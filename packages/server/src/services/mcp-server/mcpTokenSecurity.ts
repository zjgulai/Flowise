import crypto from 'crypto'
import type { DataSource } from 'typeorm'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { getTokenHashSecret } from '../../enterprise/utils/authSecrets'

export interface StoredMcpServerConfig {
    enabled: boolean
    description?: string
    toolName?: string
    /** Legacy bearer value. New writes must never persist this field. */
    token?: string
    /** Versioned, flow-bound keyed digest. */
    tokenHash?: string
}

const TOKEN_FORMAT = /^[0-9a-f]{32}(?:[0-9a-f]{32})?$/
const DIGEST_FORMAT = /^v1:[0-9a-f]{64}$/
const TOKEN_DIGEST_DOMAIN = 'flowise/mcp/bearer-token-digest/v1\0'
const TOKEN_KEY_SALT = 'flowise/mcp/bearer-token-key/salt/v1'
const TOKEN_KEY_INFO = 'flowise/mcp/bearer-token-key/info/v1'
const MIGRATION_BATCH_SIZE = 500
export const MAX_MCP_DESCRIPTION_LENGTH = 4096

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export const isSupportedMcpToken = (token: unknown): token is string => typeof token === 'string' && TOKEN_FORMAT.test(token)

export const isSupportedMcpTokenHash = (tokenHash: unknown): tokenHash is string =>
    typeof tokenHash === 'string' && DIGEST_FORMAT.test(tokenHash)

export const parseStoredMcpServerConfig = (serialized: string | null | undefined): StoredMcpServerConfig | null => {
    if (!serialized) return null
    try {
        const parsed: unknown = JSON.parse(serialized)
        if (!isRecord(parsed) || typeof parsed.enabled !== 'boolean') return null
        if (parsed.description !== undefined && typeof parsed.description !== 'string') return null
        if (parsed.toolName !== undefined && typeof parsed.toolName !== 'string') return null
        if (parsed.token !== undefined && typeof parsed.token !== 'string') return null
        if (parsed.tokenHash !== undefined && typeof parsed.tokenHash !== 'string') return null
        return {
            enabled: parsed.enabled,
            ...(parsed.description !== undefined ? { description: parsed.description } : {}),
            ...(parsed.toolName !== undefined ? { toolName: parsed.toolName } : {}),
            ...(parsed.token !== undefined ? { token: parsed.token } : {}),
            ...(parsed.tokenHash !== undefined ? { tokenHash: parsed.tokenHash } : {})
        }
    } catch {
        return null
    }
}

export const serializeStoredMcpServerConfig = (config: StoredMcpServerConfig): string =>
    JSON.stringify({
        enabled: config.enabled,
        ...(config.description !== undefined ? { description: config.description } : {}),
        ...(config.toolName !== undefined ? { toolName: config.toolName } : {}),
        ...(config.tokenHash !== undefined ? { tokenHash: config.tokenHash } : {})
    })

const deriveMcpTokenKey = (): Buffer =>
    Buffer.from(
        crypto.hkdfSync(
            'sha256',
            Buffer.from(getTokenHashSecret(), 'utf8'),
            Buffer.from(TOKEN_KEY_SALT, 'utf8'),
            Buffer.from(TOKEN_KEY_INFO, 'utf8'),
            32
        )
    )

export const createMcpTokenHash = (chatflowId: string, token: string): string => {
    if (!chatflowId || !isSupportedMcpToken(token)) throw new Error('Invalid MCP bearer token material')
    const digest = crypto
        .createHmac('sha256', deriveMcpTokenKey())
        .update(TOKEN_DIGEST_DOMAIN, 'utf8')
        .update(chatflowId, 'utf8')
        .update('\0', 'utf8')
        .update(token, 'utf8')
        .digest('hex')
    return `v1:${digest}`
}

export const verifyMcpTokenHash = (chatflowId: string, token: unknown, storedHash: unknown): boolean => {
    if (!isSupportedMcpToken(token) || !isSupportedMcpTokenHash(storedHash)) return false
    const actual = Buffer.from(createMcpTokenHash(chatflowId, token).slice(3), 'hex')
    const expected = Buffer.from(storedHash.slice(3), 'hex')
    return crypto.timingSafeEqual(actual, expected)
}

const migrateConfig = (chatflowId: string, config: StoredMcpServerConfig): StoredMcpServerConfig => {
    const migrated = { ...config }
    if (migrated.description !== undefined) migrated.description = migrated.description.slice(0, MAX_MCP_DESCRIPTION_LENGTH)
    if (migrated.token !== undefined) {
        migrated.enabled = false
        delete migrated.token
        delete migrated.tokenHash
        return migrated
    }
    if (!migrated.enabled) {
        delete migrated.token
        delete migrated.tokenHash
        return migrated
    }
    if (isSupportedMcpTokenHash(migrated.tokenHash)) {
        delete migrated.token
        return migrated
    }
    throw new Error(`MCP bearer token migration failed for ${chatflowId ? 'configured flow' : 'unknown flow'}`)
}

const isSecureStoredConfig = (serialized: string | null | undefined): boolean => {
    const config = parseStoredMcpServerConfig(serialized)
    if (!config || config.token !== undefined) return false
    return config.enabled ? isSupportedMcpTokenHash(config.tokenHash) : config.tokenHash === undefined
}

/**
 * Startup migration revokes every legacy plaintext MCP bearer token. It is
 * idempotent, bounded, CAS-protected, and records only aggregate counts at the
 * caller. An administrator must explicitly re-enable the server to receive a
 * fresh one-time token.
 */
export const migrateLegacyMcpServerTokens = async (
    dataSource: DataSource
): Promise<{ scanned: number; migrated: number; concurrent: number }> => {
    const repository = dataSource.getRepository(ChatFlow)
    let cursor = ''
    let scanned = 0
    let migrated = 0
    let concurrent = 0
    let hasMoreRows = true

    while (hasMoreRows) {
        const query = repository
            .createQueryBuilder('chatflow')
            .select(['chatflow.id', 'chatflow.workspaceId', 'chatflow.type'])
            .addSelect('chatflow.mcpServerConfig')
            .where('chatflow.mcpServerConfig IS NOT NULL')
            .orderBy('chatflow.id', 'ASC')
            .take(MIGRATION_BATCH_SIZE)
        if (cursor) query.andWhere('chatflow.id > :cursor', { cursor })
        const rows = await query.getMany()
        if (rows.length === 0) break

        for (const row of rows) {
            scanned += 1
            cursor = row.id
            const previous = row.mcpServerConfig
            const parsed = parseStoredMcpServerConfig(previous)
            if (!parsed) throw new Error('MCP bearer token migration failed')
            const next = serializeStoredMcpServerConfig(migrateConfig(row.id, parsed))
            if (next === previous) continue

            const result = await repository.update(
                { id: row.id, workspaceId: row.workspaceId, type: row.type, mcpServerConfig: previous },
                { mcpServerConfig: next }
            )
            if (result.affected === 1) {
                migrated += 1
                continue
            }

            const current = await repository
                .createQueryBuilder('chatflow')
                .select(['chatflow.id'])
                .addSelect('chatflow.mcpServerConfig')
                .where('chatflow.id = :id', { id: row.id })
                .andWhere('chatflow.workspaceId = :workspaceId', { workspaceId: row.workspaceId })
                .andWhere('chatflow.type = :type', { type: row.type })
                .getOne()
            if (!current || !isSecureStoredConfig(current.mcpServerConfig))
                throw new Error('MCP bearer token migration changed concurrently')
            concurrent += 1
        }
        hasMoreRows = rows.length === MIGRATION_BATCH_SIZE
    }

    return { scanned, migrated, concurrent }
}
