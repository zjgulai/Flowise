import Redis from 'ioredis'
import { RedisStore } from 'connect-redis'
import session, { type MemoryStore, type SessionData, type Store } from 'express-session'
import { StatusCodes } from 'http-status-codes'
import { getDatabaseSSLFromEnv } from '../../../DataSource'
import path from 'path'
import { getUserHome } from '../../../utils'
import { InternalFlowiseError } from '../../../errors/internalFlowiseError'
import logger from '../../../utils/logger'
import { LoginSession } from '../../database/entities/login-session.entity'
import { getRunningExpressApp } from '../../../utils/getRunningExpressApp'

let redisClient: Redis | null = null
let redisStore: RedisStore | null = null
let dbStore: Store | null = null
let memoryStore: MemoryStore | null = null

type SessionStoreKind = 'redis' | 'sqlite' | 'mysql' | 'postgres' | 'memory' | 'missing' | 'unsupported'

class SessionRevocationError extends InternalFlowiseError {
    readonly cause: unknown

    constructor(cause: unknown) {
        super(StatusCodes.INTERNAL_SERVER_ERROR, 'Failed to revoke active sessions')
        this.name = 'SessionRevocationError'
        Object.defineProperty(this, 'cause', {
            value: cause,
            enumerable: false,
            configurable: true
        })
    }
}

const createStoreError = (code: string, message: string) => Object.assign(new Error(message), { code })

export const initializeRedisClientAndStore = (): RedisStore => {
    if (!redisClient) {
        if (process.env.REDIS_URL) {
            redisClient = new Redis(process.env.REDIS_URL)
        } else {
            redisClient = new Redis({
                host: process.env.REDIS_HOST || 'localhost',
                port: parseInt(process.env.REDIS_PORT || '6379'),
                username: process.env.REDIS_USERNAME || undefined,
                password: process.env.REDIS_PASSWORD || undefined,
                tls:
                    process.env.REDIS_TLS === 'true'
                        ? {
                              cert: process.env.REDIS_CERT ? Buffer.from(process.env.REDIS_CERT, 'base64') : undefined,
                              key: process.env.REDIS_KEY ? Buffer.from(process.env.REDIS_KEY, 'base64') : undefined,
                              ca: process.env.REDIS_CA ? Buffer.from(process.env.REDIS_CA, 'base64') : undefined
                          }
                        : undefined
            })
        }
    }
    if (!redisStore) {
        redisStore = new RedisStore({ client: redisClient })
    }
    return redisStore
}

export const initializeMemoryStore = (): MemoryStore => {
    if (!memoryStore) memoryStore = new session.MemoryStore()
    return memoryStore
}

export const initializeDBClientAndStore = (): Store | undefined => {
    if (dbStore) return dbStore

    const databaseType = process.env.DATABASE_TYPE || 'sqlite'
    switch (databaseType) {
        case 'mysql': {
            const expressSession = require('express-session')
            const MySQLStore = require('express-mysql-session')(expressSession)
            const options = {
                host: process.env.DATABASE_HOST,
                port: parseInt(process.env.DATABASE_PORT || '3306'),
                user: process.env.DATABASE_USER,
                password: process.env.DATABASE_PASSWORD,
                database: process.env.DATABASE_NAME,
                createDatabaseTable: true,
                schema: {
                    tableName: 'login_sessions'
                }
            }
            dbStore = new MySQLStore(options)
            return dbStore ?? undefined
        }
        case 'mariadb':
            /* TODO: Implement MariaDB session store */
            break
        case 'postgres': {
            // default is postgres
            const pg = require('pg')
            const expressSession = require('express-session')
            const pgSession = require('connect-pg-simple')(expressSession)

            const pgPool = new pg.Pool({
                host: process.env.DATABASE_HOST,
                port: parseInt(process.env.DATABASE_PORT || '5432'),
                user: process.env.DATABASE_USER,
                password: process.env.DATABASE_PASSWORD,
                database: process.env.DATABASE_NAME,
                ssl: getDatabaseSSLFromEnv()
            })
            dbStore = new pgSession({
                pool: pgPool, // Connection pool
                tableName: 'login_sessions',
                schemaName: 'public',
                createTableIfMissing: true
            })
            return dbStore ?? undefined
        }
        case 'default':
        case 'sqlite': {
            const expressSession = require('express-session')
            const sqlSession = require('connect-sqlite3')(expressSession)
            let flowisePath = path.join(getUserHome(), '.flowise')
            const homePath = process.env.DATABASE_PATH ?? flowisePath
            dbStore = new sqlSession({
                db: 'database.sqlite',
                table: 'login_sessions',
                dir: homePath
            })
            return dbStore ?? undefined
        }
    }
}

const getUserIdFromSession = (sessionPayload: unknown): string | undefined => {
    try {
        const data = typeof sessionPayload === 'string' ? JSON.parse(sessionPayload) : sessionPayload
        return data?.passport?.user?.id
    } catch {
        return undefined
    }
}

const assertPipelineResults = (results: unknown): void => {
    if (!Array.isArray(results)) {
        throw createStoreError('REDIS_PIPELINE_RESULT_MISSING', 'Redis pipeline did not return command results')
    }

    for (const result of results) {
        if (!Array.isArray(result) || result.length < 2) {
            throw createStoreError('REDIS_PIPELINE_RESULT_INVALID', 'Redis pipeline returned an invalid command result')
        }
        if (result[0]) throw result[0]
    }
}

const deleteRedisKeys = async (keys: string[]): Promise<void> => {
    if (keys.length === 0) return
    if (!redisClient) throw createStoreError('REDIS_CLIENT_UNAVAILABLE', 'Redis client is unavailable')
    const pipeline = redisClient.pipeline()
    keys.forEach((key) => pipeline.del(key))
    assertPipelineResults(await pipeline.exec())
}

const destroyRedisSessionsForUser = async (userId: string): Promise<void> => {
    if (!redisStore || !redisClient) throw createStoreError('REDIS_STORE_UNAVAILABLE', 'Redis session store is unavailable')

    const prefix = (redisStore as RedisStore & { prefix?: string }).prefix ?? 'sess:'
    const keysToDelete: string[] = []
    const batchSize = 1000
    const stream = redisClient.scanStream({
        match: `${prefix}*`,
        count: batchSize
    })

    for await (const keysBatch of stream) {
        if (keysBatch.length === 0) continue

        const sessions = await redisClient.mget(...keysBatch)
        for (let index = 0; index < sessions.length; index++) {
            if (getUserIdFromSession(sessions[index]) === userId) keysToDelete.push(keysBatch[index])
        }

        while (keysToDelete.length >= batchSize) {
            await deleteRedisKeys(keysToDelete.splice(0, batchSize))
        }
    }

    await deleteRedisKeys(keysToDelete)
}

const getDatabaseStoreKind = (): SessionStoreKind => {
    switch (process.env.DATABASE_TYPE || 'sqlite') {
        case 'default':
        case 'sqlite':
            return 'sqlite'
        case 'mysql':
            return 'mysql'
        case 'postgres':
            return 'postgres'
        default:
            return 'unsupported'
    }
}

const destroyDatabaseSessionsForUser = async (userId: string): Promise<void> => {
    const storeKind = getDatabaseStoreKind()
    if (storeKind === 'unsupported') {
        throw createStoreError('DATABASE_SESSION_STORE_UNSUPPORTED', 'Database session store type is unsupported')
    }

    const repository = getRunningExpressApp().AppDataSource.getRepository(LoginSession)
    switch (storeKind) {
        case 'sqlite':
            await repository.createQueryBuilder().delete().where(`json_extract(sess, '$.passport.user.id') = :userId`, { userId }).execute()
            return
        case 'mysql':
            await repository
                .createQueryBuilder()
                .delete()
                .where(`JSON_EXTRACT(data, '$.passport.user.id') = :userId`, { userId }) // express-mysql-session uses column name 'data' for session payload, not 'sess'
                .execute()
            return
        case 'postgres':
            await repository.createQueryBuilder().delete().where(`sess->'passport'->'user'->>'id' = :userId`, { userId }).execute()
    }
}

const getMemorySessions = async (store: MemoryStore): Promise<Record<string, SessionData>> =>
    await new Promise((resolve, reject) => {
        store.all((error, sessions) => {
            if (error) reject(error)
            else resolve(sessions ?? {})
        })
    })

const destroyMemorySession = async (store: MemoryStore, sid: string): Promise<void> =>
    await new Promise((resolve, reject) => {
        store.destroy(sid, (error) => {
            if (error) reject(error)
            else resolve()
        })
    })

const destroyMemorySessionsForUser = async (userId: string): Promise<void> => {
    if (!memoryStore) throw createStoreError('MEMORY_STORE_UNAVAILABLE', 'Memory session store is unavailable')

    const sessions = await getMemorySessions(memoryStore)
    for (const [sid, sessionData] of Object.entries(sessions)) {
        if (getUserIdFromSession(sessionData) === userId) await destroyMemorySession(memoryStore, sid)
    }
}

const getErrorMetadata = (error: unknown, storeKind: SessionStoreKind) => {
    const errorRecord = typeof error === 'object' && error !== null ? (error as { name?: unknown; code?: unknown }) : {}
    return {
        event: 'session_revocation_failed',
        storeKind,
        errorName: typeof errorRecord.name === 'string' ? errorRecord.name : 'Error',
        errorCode: typeof errorRecord.code === 'string' || typeof errorRecord.code === 'number' ? String(errorRecord.code) : 'unknown'
    }
}

export const destroyAllSessionsForUser = async (userId: string): Promise<void> => {
    let storeKind: SessionStoreKind = 'missing'
    try {
        if (redisStore && redisClient) {
            storeKind = 'redis'
            await destroyRedisSessionsForUser(userId)
            return
        }
        if (dbStore) {
            storeKind = getDatabaseStoreKind()
            await destroyDatabaseSessionsForUser(userId)
            return
        }
        if (memoryStore) {
            storeKind = 'memory'
            await destroyMemorySessionsForUser(userId)
            return
        }

        throw createStoreError('SESSION_STORE_UNAVAILABLE', 'Session store has not been registered')
    } catch (error) {
        const typedError = error instanceof SessionRevocationError ? error : new SessionRevocationError(error)
        logger.error('session_revocation_failed', getErrorMetadata(error, storeKind))
        throw typedError
    }
}
