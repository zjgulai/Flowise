import type { MemoryStore, SessionData } from 'express-session'

const mockRedisClient = {
    scanStream: jest.fn(),
    mget: jest.fn(),
    pipeline: jest.fn()
}
const mockRedisStore = { prefix: 'sess:' }
const mockDbStore = {}
const mockQueryBuilder = {
    delete: jest.fn(),
    where: jest.fn(),
    execute: jest.fn()
}
const mockRepository = {
    createQueryBuilder: jest.fn()
}
const mockRunningApp = {
    AppDataSource: {
        getRepository: jest.fn()
    }
}
const mockLoggerError = jest.fn()

jest.mock('ioredis', () => ({
    __esModule: true,
    default: jest.fn().mockImplementation(() => mockRedisClient)
}))

jest.mock('connect-redis', () => ({
    RedisStore: jest.fn().mockImplementation(() => mockRedisStore)
}))

jest.mock('connect-sqlite3', () => () => jest.fn().mockImplementation(() => mockDbStore))
jest.mock('express-mysql-session', () => () => jest.fn().mockImplementation(() => mockDbStore))
jest.mock('connect-pg-simple', () => () => jest.fn().mockImplementation(() => mockDbStore))
jest.mock('pg', () => ({ Pool: jest.fn() }))

jest.mock('../../../DataSource', () => ({
    getDatabaseSSLFromEnv: jest.fn()
}))

jest.mock('../../../utils', () => ({
    getUserHome: jest.fn().mockReturnValue('/tmp/flowise-session-test')
}))

jest.mock('../../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: jest.fn().mockImplementation(() => mockRunningApp)
}))

jest.mock('../../../utils/logger', () => ({
    __esModule: true,
    default: {
        error: mockLoggerError
    }
}))

jest.mock('../../database/entities/login-session.entity', () => ({
    LoginSession: class LoginSession {}
}))

type Subject = typeof import('./SessionPersistance') & {
    initializeMemoryStore: () => MemoryStore
}

const originalDatabaseType = process.env.DATABASE_TYPE
const originalRedisUrl = process.env.REDIS_URL

const loadSubject = async (): Promise<Subject> => {
    jest.resetModules()
    return (await import('./SessionPersistance')) as Subject
}

const asAsyncBatches = (batches: string[][]) => ({
    async *[Symbol.asyncIterator]() {
        for (const batch of batches) yield batch
    }
})

const createPipeline = (results: unknown) => {
    const pipeline = {
        del: jest.fn(),
        exec: jest.fn().mockResolvedValue(results)
    }
    pipeline.del.mockReturnValue(pipeline)
    return pipeline
}

const sessionFor = (userId: string) => JSON.stringify({ passport: { user: { id: userId } } })

const setMemorySession = async (store: MemoryStore, sid: string, session: Partial<SessionData>) =>
    await new Promise<void>((resolve, reject) => {
        store.set(sid, session as SessionData, (error) => (error ? reject(error) : resolve()))
    })

const getMemorySession = async (store: MemoryStore, sid: string) =>
    await new Promise<SessionData | null | undefined>((resolve, reject) => {
        store.get(sid, (error, session) => (error ? reject(error) : resolve(session)))
    })

const requireMemoryStore = (subject: Subject): MemoryStore => {
    const initializeMemoryStore = (subject as Partial<Subject>).initializeMemoryStore
    expect(initializeMemoryStore).toEqual(expect.any(Function))
    return initializeMemoryStore!()
}

describe('destroyAllSessionsForUser', () => {
    afterAll(() => {
        if (originalDatabaseType === undefined) delete process.env.DATABASE_TYPE
        else process.env.DATABASE_TYPE = originalDatabaseType
        if (originalRedisUrl === undefined) delete process.env.REDIS_URL
        else process.env.REDIS_URL = originalRedisUrl
    })

    beforeEach(() => {
        jest.clearAllMocks()
        delete process.env.REDIS_URL
        process.env.DATABASE_TYPE = 'sqlite'

        mockQueryBuilder.delete.mockReturnValue(mockQueryBuilder)
        mockQueryBuilder.where.mockReturnValue(mockQueryBuilder)
        mockQueryBuilder.execute.mockResolvedValue({ affected: 1 })
        mockRepository.createQueryBuilder.mockReturnValue(mockQueryBuilder)
        mockRunningApp.AppDataSource.getRepository.mockReturnValue(mockRepository)
    })

    it('fails closed with a typed error when no session store has been registered', async () => {
        const subject = await loadSubject()

        await expect(subject.destroyAllSessionsForUser('target-user')).rejects.toMatchObject({
            name: 'SessionRevocationError',
            statusCode: 500,
            message: 'Failed to revoke active sessions'
        })
    })

    it('fails closed when the registered database store no longer matches a supported database type', async () => {
        const subject = await loadSubject()
        process.env.DATABASE_TYPE = 'sqlite'
        subject.initializeDBClientAndStore()
        process.env.DATABASE_TYPE = 'mariadb'

        await expect(subject.destroyAllSessionsForUser('target-user')).rejects.toMatchObject({
            name: 'SessionRevocationError',
            statusCode: 500,
            message: 'Failed to revoke active sessions'
        })
        expect(mockQueryBuilder.execute).not.toHaveBeenCalled()
    })

    it('rejects a Redis command error tuple and preserves the internal cause without logging its message', async () => {
        const subject = await loadSubject()
        subject.initializeRedisClientAndStore()
        const commandError = Object.assign(new Error('redis-command-sensitive-detail'), { code: 'READONLY' })
        const pipeline = createPipeline([[commandError, null]])
        mockRedisClient.scanStream.mockReturnValue(asAsyncBatches([['sess:target']]))
        mockRedisClient.mget.mockResolvedValue([sessionFor('target-user')])
        mockRedisClient.pipeline.mockReturnValue(pipeline)

        const thrownError = await subject.destroyAllSessionsForUser('target-user').catch((error: unknown) => error)
        expect(thrownError).toMatchObject({
            name: 'SessionRevocationError',
            statusCode: 500,
            message: 'Failed to revoke active sessions',
            cause: commandError
        })
        expect(Object.keys(thrownError as object)).not.toContain('cause')
        expect(mockLoggerError).toHaveBeenCalledWith('session_revocation_failed', {
            event: 'session_revocation_failed',
            storeKind: 'redis',
            errorName: 'Error',
            errorCode: 'READONLY'
        })
        expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain(commandError.message)
        expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain('target-user')
    })

    it.each([
        ['missing', null],
        ['malformed', [null]]
    ] as Array<[string, unknown]>)('rejects %s Redis pipeline command results', async (_caseName, results) => {
        const subject = await loadSubject()
        subject.initializeRedisClientAndStore()
        const pipeline = createPipeline(results)
        mockRedisClient.scanStream.mockReturnValue(asAsyncBatches([['sess:target']]))
        mockRedisClient.mget.mockResolvedValue([sessionFor('target-user')])
        mockRedisClient.pipeline.mockReturnValue(pipeline)

        await expect(subject.destroyAllSessionsForUser('target-user')).rejects.toMatchObject({
            name: 'SessionRevocationError',
            statusCode: 500,
            message: 'Failed to revoke active sessions'
        })
    })

    it('rejects when a later Redis delete batch fails after an earlier batch succeeded', async () => {
        const subject = await loadSubject()
        subject.initializeRedisClientAndStore()
        const keys = Array.from({ length: 1001 }, (_, index) => `sess:key-${index}`)
        const laterBatchError = new Error('later-batch-detail')
        const firstPipeline = createPipeline(Array.from({ length: 1000 }, () => [null, 1]))
        const secondPipeline = createPipeline([[laterBatchError, null]])
        mockRedisClient.scanStream.mockReturnValue(asAsyncBatches([keys]))
        mockRedisClient.mget.mockResolvedValue(keys.map(() => sessionFor('target-user')))
        mockRedisClient.pipeline.mockReturnValueOnce(firstPipeline).mockReturnValueOnce(secondPipeline)

        await expect(subject.destroyAllSessionsForUser('target-user')).rejects.toMatchObject({
            name: 'SessionRevocationError',
            cause: laterBatchError
        })
        expect(firstPipeline.del).toHaveBeenCalledTimes(1000)
        expect(secondPipeline.del).toHaveBeenCalledTimes(1)
    })

    it('accepts successful Redis tuples, including DEL=0 for an already expired key', async () => {
        const subject = await loadSubject()
        subject.initializeRedisClientAndStore()
        const pipeline = createPipeline([
            [null, 1],
            [null, 0]
        ])
        mockRedisClient.scanStream.mockReturnValue(asAsyncBatches([['sess:first', 'sess:expired']]))
        mockRedisClient.mget.mockResolvedValue([sessionFor('target-user'), sessionFor('target-user')])
        mockRedisClient.pipeline.mockReturnValue(pipeline)

        await expect(subject.destroyAllSessionsForUser('target-user')).resolves.toBeUndefined()
        expect(pipeline.del).toHaveBeenCalledTimes(2)
    })

    it('skips malformed or unowned Redis payloads and deletes only the target session', async () => {
        const subject = await loadSubject()
        subject.initializeRedisClientAndStore()
        const pipeline = createPipeline([[null, 1]])
        mockRedisClient.scanStream.mockReturnValue(asAsyncBatches([['sess:null', 'sess:bad', 'sess:unowned', 'sess:target', 'sess:other']]))
        mockRedisClient.mget.mockResolvedValue([
            null,
            '{bad-json',
            JSON.stringify({ cookie: {} }),
            sessionFor('target-user'),
            sessionFor('other-user')
        ])
        mockRedisClient.pipeline.mockReturnValue(pipeline)

        await expect(subject.destroyAllSessionsForUser('target-user')).resolves.toBeUndefined()
        expect(pipeline.del).toHaveBeenCalledTimes(1)
        expect(pipeline.del).toHaveBeenCalledWith('sess:target')
    })

    it.each([
        ['default', `json_extract(sess, '$.passport.user.id') = :userId`],
        ['sqlite', `json_extract(sess, '$.passport.user.id') = :userId`],
        ['mysql', `JSON_EXTRACT(data, '$.passport.user.id') = :userId`],
        ['postgres', `sess->'passport'->'user'->>'id' = :userId`]
    ])('preserves the %s backend delete expression and parameters', async (databaseType, expectedWhere) => {
        const subject = await loadSubject()
        process.env.DATABASE_TYPE = databaseType
        subject.initializeDBClientAndStore()

        await expect(subject.destroyAllSessionsForUser('target-user')).resolves.toBeUndefined()
        expect(mockQueryBuilder.where).toHaveBeenCalledWith(expectedWhere, { userId: 'target-user' })
        expect(mockQueryBuilder.execute).toHaveBeenCalledTimes(1)
    })

    it('wraps a database execute failure and preserves its internal cause', async () => {
        const subject = await loadSubject()
        process.env.DATABASE_TYPE = 'postgres'
        subject.initializeDBClientAndStore()
        const databaseError = Object.assign(new Error('database-sensitive-detail'), { code: 'DB_DOWN' })
        mockQueryBuilder.execute.mockRejectedValue(databaseError)

        await expect(subject.destroyAllSessionsForUser('target-user')).rejects.toMatchObject({
            name: 'SessionRevocationError',
            statusCode: 500,
            message: 'Failed to revoke active sessions',
            cause: databaseError
        })
    })

    it('uses one explicit MemoryStore instance and deletes only the target user sessions', async () => {
        const subject = await loadSubject()
        const store = requireMemoryStore(subject)
        expect(subject.initializeMemoryStore()).toBe(store)
        await setMemorySession(store, 'target-one', { passport: { user: { id: 'target-user' } } } as Partial<SessionData>)
        await setMemorySession(store, 'target-two', { passport: { user: { id: 'target-user' } } } as Partial<SessionData>)
        await setMemorySession(store, 'other', { passport: { user: { id: 'other-user' } } } as Partial<SessionData>)

        await expect(subject.destroyAllSessionsForUser('target-user')).resolves.toBeUndefined()

        expect(await getMemorySession(store, 'target-one')).toBeUndefined()
        expect(await getMemorySession(store, 'target-two')).toBeUndefined()
        expect(await getMemorySession(store, 'other')).toBeDefined()
    })

    it('fails closed when MemoryStore all returns an error', async () => {
        const subject = await loadSubject()
        const store = requireMemoryStore(subject)
        const storeError = new Error('memory-all-detail')
        jest.spyOn(store, 'all').mockImplementationOnce((callback) => callback(storeError))

        await expect(subject.destroyAllSessionsForUser('target-user')).rejects.toMatchObject({
            name: 'SessionRevocationError',
            cause: storeError
        })
    })

    it('fails closed when MemoryStore destroy returns an error', async () => {
        const subject = await loadSubject()
        const store = requireMemoryStore(subject)
        const storeError = new Error('memory-destroy-detail')
        jest.spyOn(store, 'all').mockImplementationOnce((callback) =>
            callback(null, { target: { passport: { user: { id: 'target-user' } } } } as unknown as Record<string, SessionData>)
        )
        jest.spyOn(store, 'destroy').mockImplementationOnce((_sid, callback) => callback?.(storeError))

        await expect(subject.destroyAllSessionsForUser('target-user')).rejects.toMatchObject({
            name: 'SessionRevocationError',
            cause: storeError
        })
    })
})
