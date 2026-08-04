jest.mock('../../enterprise/utils/authSecrets', () => ({
    getTokenHashSecret: () => '0123456789abcdef0123456789abcdef'
}))

import { createMcpTokenHash, migrateLegacyMcpServerTokens, parseStoredMcpServerConfig, verifyMcpTokenHash } from './mcpTokenSecurity'

const FLOW_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_FLOW_ID = '22222222-2222-4222-8222-222222222222'
const TOKEN = '0123456789abcdef0123456789abcdef'

const makeQuery = (rows: any[] = [], current?: any) => ({
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
    getOne: jest.fn().mockResolvedValue(current)
})

describe('MCP bearer token security', () => {
    it('creates a versioned, deterministic, flow-bound keyed digest', () => {
        const digest = createMcpTokenHash(FLOW_ID, TOKEN)

        expect(digest).toMatch(/^v1:[0-9a-f]{64}$/)
        expect(createMcpTokenHash(FLOW_ID, TOKEN)).toBe(digest)
        expect(createMcpTokenHash(OTHER_FLOW_ID, TOKEN)).not.toBe(digest)
        expect(verifyMcpTokenHash(FLOW_ID, TOKEN, digest)).toBe(true)
        expect(verifyMcpTokenHash(OTHER_FLOW_ID, TOKEN, digest)).toBe(false)
        expect(verifyMcpTokenHash(FLOW_ID, 'not-a-token', digest)).toBe(false)
    })

    it('revokes every legacy plaintext token and never persists a derived live credential', async () => {
        const rows = [
            {
                id: FLOW_ID,
                workspaceId: 'ws-1',
                type: 'CHATFLOW',
                mcpServerConfig: JSON.stringify({ enabled: true, token: TOKEN, description: 'enabled', toolName: 'tool' })
            },
            {
                id: OTHER_FLOW_ID,
                workspaceId: 'ws-1',
                type: 'AGENTFLOW',
                mcpServerConfig: JSON.stringify({ enabled: false, token: TOKEN, description: 'disabled', toolName: 'tool' })
            }
        ]
        const updates: string[] = []
        const repository = {
            createQueryBuilder: jest.fn(() => makeQuery(rows)),
            update: jest.fn(async (_criteria, update) => {
                updates.push(update.mcpServerConfig)
                return { affected: 1 }
            })
        }
        const dataSource = { getRepository: jest.fn(() => repository) } as any

        await expect(migrateLegacyMcpServerTokens(dataSource)).resolves.toEqual({ scanned: 2, migrated: 2, concurrent: 0 })
        expect(updates).toHaveLength(2)
        expect(updates.join('')).not.toContain(TOKEN)
        expect(parseStoredMcpServerConfig(updates[0])).toEqual({ enabled: false, description: 'enabled', toolName: 'tool' })
        expect(parseStoredMcpServerConfig(updates[1])).toEqual({ enabled: false, description: 'disabled', toolName: 'tool' })
    })

    it('accepts a concurrent winner only after reloading a secure config', async () => {
        const legacy = {
            id: FLOW_ID,
            workspaceId: 'ws-1',
            type: 'CHATFLOW',
            mcpServerConfig: JSON.stringify({ enabled: true, token: TOKEN })
        }
        const secure = {
            ...legacy,
            mcpServerConfig: JSON.stringify({ enabled: true, tokenHash: createMcpTokenHash(FLOW_ID, TOKEN) })
        }
        const scanQuery = makeQuery([legacy])
        const reloadQuery = makeQuery([], secure)
        const repository = {
            createQueryBuilder: jest.fn().mockReturnValueOnce(scanQuery).mockReturnValueOnce(reloadQuery),
            update: jest.fn().mockResolvedValue({ affected: 0 })
        }
        const dataSource = { getRepository: jest.fn(() => repository) } as any

        await expect(migrateLegacyMcpServerTokens(dataSource)).resolves.toEqual({ scanned: 1, migrated: 0, concurrent: 1 })
    })

    it('revokes an invalid enabled legacy token instead of blocking startup or preserving it', async () => {
        const row = {
            id: FLOW_ID,
            workspaceId: 'ws-1',
            type: 'CHATFLOW',
            mcpServerConfig: JSON.stringify({ enabled: true, token: 'weak' })
        }
        const repository = {
            createQueryBuilder: jest.fn(() => makeQuery([row])),
            update: jest.fn().mockResolvedValue({ affected: 1 })
        }
        const dataSource = { getRepository: jest.fn(() => repository) } as any

        await expect(migrateLegacyMcpServerTokens(dataSource)).resolves.toEqual({ scanned: 1, migrated: 1, concurrent: 0 })
        expect(parseStoredMcpServerConfig(repository.update.mock.calls[0][1].mcpServerConfig)).toEqual({ enabled: false })
    })

    it('truncates an overlong legacy description while revoking its plaintext token', async () => {
        const row = {
            id: FLOW_ID,
            workspaceId: 'ws-1',
            type: 'CHATFLOW',
            mcpServerConfig: JSON.stringify({ enabled: true, token: TOKEN, description: 'x'.repeat(5000) })
        }
        const repository = {
            createQueryBuilder: jest.fn(() => makeQuery([row])),
            update: jest.fn().mockResolvedValue({ affected: 1 })
        }

        await migrateLegacyMcpServerTokens({ getRepository: jest.fn(() => repository) } as any)

        const stored = parseStoredMcpServerConfig(repository.update.mock.calls[0][1].mcpServerConfig)
        expect(stored).toMatchObject({ enabled: false })
        expect(stored?.description).toHaveLength(4096)
    })
})
