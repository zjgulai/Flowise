/**
 * Unit tests for MCP server service (packages/server/src/services/mcp-server/index.ts)
 *
 * These tests mock the database layer (getRunningExpressApp) and test the
 * service functions in isolation: config CRUD, token generation/verification,
 * toolName validation, and parseMcpConfig.
 */
import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'

// Mock typeorm decorators before any entity import (virtual: true for pnpm resolution)
jest.mock(
    'typeorm',
    () => ({
        Entity: () => (_target: any) => _target,
        Column: () => () => {},
        CreateDateColumn: () => () => {},
        UpdateDateColumn: () => () => {},
        PrimaryGeneratedColumn: () => () => {},
        In: (value: unknown[]) => ({ type: 'in', value }),
        IsNull: () => ({ type: 'isNull' })
    }),
    { virtual: true }
)

// --- Mock setup ---
const mockFindOne = jest.fn()
const mockSave = jest.fn()
const mockUpdate = jest.fn()
const mockGetOne = jest.fn()
const mockQueryBuilder = {
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: mockGetOne
}
const mockRepository = {
    findOne: mockFindOne,
    save: mockSave,
    update: mockUpdate,
    createQueryBuilder: jest.fn(() => mockQueryBuilder)
}

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: {
            getRepository: () => mockRepository
        }
    })
}))

jest.mock('../../enterprise/utils/authSecrets', () => ({
    getTokenHashSecret: () => '0123456789abcdef0123456789abcdef'
}))

// Import after mocking
import mcpServerService from '.'
import { IMcpServerConfig } from '../../Interface'
import { EnumChatflowType } from '../../database/entities/ChatFlow'
import { createMcpTokenHash } from './mcpTokenSecurity'

const PERMITTED_TYPES = [EnumChatflowType.CHATFLOW] as const

// Helper: create a mock ChatFlow entity
function makeChatflow(overrides: Record<string, any> = {}) {
    return {
        id: 'chatflow-1',
        name: 'Test Chatflow',
        flowData: '{}',
        type: 'CHATFLOW',
        workspaceId: 'ws-1',
        mcpServerConfig: undefined as string | undefined,
        ...overrides
    }
}

function makeConfig(overrides: Partial<IMcpServerConfig> = {}): IMcpServerConfig {
    return {
        enabled: true,
        token: 'a'.repeat(32),
        description: 'Test tool',
        toolName: 'test_tool',
        ...overrides
    }
}

function makeHashedConfig(token = 'a'.repeat(32), overrides: Partial<IMcpServerConfig> = {}): IMcpServerConfig {
    return makeConfig({ token: undefined, tokenHash: createMcpTokenHash('chatflow-1', token), ...overrides })
}

beforeEach(() => {
    jest.clearAllMocks()
    mockSave.mockImplementation((entity: any) => Promise.resolve(entity))
    mockUpdate.mockResolvedValue({ affected: 1 })
    mockGetOne.mockImplementation(() => mockFindOne())
})

describe('mcpServerService', () => {
    describe('parseMcpConfig', () => {
        it('returns null when mcpServerConfig is undefined', () => {
            const chatflow = makeChatflow()
            expect(mcpServerService.parseMcpConfig(chatflow as any)).toBeNull()
        })

        it('returns null when mcpServerConfig is empty string', () => {
            const chatflow = makeChatflow({ mcpServerConfig: '' })
            expect(mcpServerService.parseMcpConfig(chatflow as any)).toBeNull()
        })

        it('parses valid JSON config', () => {
            const config = makeConfig()
            const chatflow = makeChatflow({ mcpServerConfig: JSON.stringify(config) })
            expect(mcpServerService.parseMcpConfig(chatflow as any)).toEqual(config)
        })

        it('returns null for invalid JSON', () => {
            const chatflow = makeChatflow({ mcpServerConfig: '{bad json' })
            expect(mcpServerService.parseMcpConfig(chatflow as any)).toBeNull()
        })
    })

    describe('getMcpServerConfig', () => {
        it('revokes a legacy plaintext config and requires explicit re-enable', async () => {
            const config = makeConfig()
            mockFindOne.mockResolvedValue(makeChatflow({ mcpServerConfig: JSON.stringify(config) }))

            const result = await mcpServerService.getMcpServerConfig('chatflow-1', 'ws-1', PERMITTED_TYPES)
            expect(result).toEqual({
                configured: true,
                enabled: false,
                hasToken: false,
                description: config.description,
                toolName: config.toolName
            })
            expect(JSON.stringify(result)).not.toContain(config.token)
            const migrated = JSON.parse(mockUpdate.mock.calls[0][1].mcpServerConfig)
            expect(migrated).not.toHaveProperty('token')
            expect(migrated).not.toHaveProperty('tokenHash')
            expect(migrated.enabled).toBe(false)
            expect(mockQueryBuilder.addSelect).toHaveBeenCalledWith('chatflow.mcpServerConfig')
            expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('chatflow.workspaceId = :workspaceId', {
                workspaceId: 'ws-1'
            })
            expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('chatflow.type IN (:...permittedTypes)', {
                permittedTypes: PERMITTED_TYPES
            })
        })

        it('returns disabled config when chatflow has no config', async () => {
            mockFindOne.mockResolvedValue(makeChatflow())
            const result = await mcpServerService.getMcpServerConfig('chatflow-1', 'ws-1', PERMITTED_TYPES)
            expect(result).toEqual({ configured: false, enabled: false, hasToken: false, description: '', toolName: '' })
        })

        it('throws NOT_FOUND when chatflow does not exist', async () => {
            mockFindOne.mockResolvedValue(null)
            await expect(mcpServerService.getMcpServerConfig('no-such', 'ws-1', PERMITTED_TYPES)).rejects.toThrow(InternalFlowiseError)
            await expect(mcpServerService.getMcpServerConfig('no-such', 'ws-1', PERMITTED_TYPES)).rejects.toMatchObject({
                statusCode: StatusCodes.NOT_FOUND
            })
        })

        it('rejects a cross-type config read without returning or mutating the MCP config', async () => {
            mockGetOne.mockResolvedValueOnce(null)
            mockFindOne.mockResolvedValue(makeChatflow({ type: EnumChatflowType.AGENTFLOW, mcpServerConfig: JSON.stringify(makeConfig()) }))

            await expect(mcpServerService.getMcpServerConfig('chatflow-1', 'ws-1', PERMITTED_TYPES)).rejects.toMatchObject({
                statusCode: StatusCodes.FORBIDDEN
            })
            expect(mockSave).not.toHaveBeenCalled()
        })

        it('rejects an empty permission scope before creating a secret-selecting query', async () => {
            await expect(mcpServerService.getMcpServerConfig('chatflow-1', 'ws-1', [])).rejects.toMatchObject({
                statusCode: StatusCodes.FORBIDDEN
            })
            expect(mockRepository.createQueryBuilder).not.toHaveBeenCalled()
        })
    })

    describe('createMcpServerConfig', () => {
        it('creates a new config with generated token', async () => {
            mockFindOne.mockResolvedValue(makeChatflow())

            const result = await mcpServerService.createMcpServerConfig(
                'chatflow-1',
                'ws-1',
                {
                    description: 'My tool',
                    toolName: 'my_tool'
                },
                PERMITTED_TYPES
            )

            expect(result.enabled).toBe(true)
            expect(result.token).toHaveLength(64)
            expect(result.hasToken).toBe(true)
            expect(result.description).toBe('My tool')
            expect(result.toolName).toBe('my_tool')
            expect(mockUpdate).toHaveBeenCalledWith(
                expect.objectContaining({
                    id: 'chatflow-1',
                    workspaceId: 'ws-1',
                    type: { type: 'in', value: PERMITTED_TYPES },
                    mcpServerConfig: { type: 'isNull' }
                }),
                expect.objectContaining({ mcpServerConfig: expect.any(String) })
            )
            expect(mockSave).not.toHaveBeenCalled()
            const stored = JSON.parse(mockUpdate.mock.calls[0][1].mcpServerConfig)
            expect(stored).not.toHaveProperty('token')
            expect(stored.tokenHash).toMatch(/^v1:[0-9a-f]{64}$/)
        })

        it('returns existing config if already enabled', async () => {
            const existing = makeHashedConfig()
            mockFindOne.mockResolvedValue(makeChatflow({ mcpServerConfig: JSON.stringify(existing) }))

            const result = await mcpServerService.createMcpServerConfig('chatflow-1', 'ws-1', {} as any, PERMITTED_TYPES)
            expect(result).toMatchObject({ configured: true, enabled: true, hasToken: true })
            expect(result).not.toHaveProperty('token')
            expect(result).not.toHaveProperty('tokenHash')
            expect(mockUpdate).not.toHaveBeenCalled()
        })

        it('throws NOT_FOUND when chatflow does not exist', async () => {
            mockFindOne.mockResolvedValue(null)
            await expect(mcpServerService.createMcpServerConfig('no-such', 'ws-1', {} as any, PERMITTED_TYPES)).rejects.toMatchObject({
                statusCode: StatusCodes.NOT_FOUND
            })
        })

        it('rejects invalid toolName', async () => {
            mockFindOne.mockResolvedValue(makeChatflow())
            await expect(
                mcpServerService.createMcpServerConfig(
                    'chatflow-1',
                    'ws-1',
                    { toolName: 'invalid name with spaces!', description: 'desc' },
                    PERMITTED_TYPES
                )
            ).rejects.toMatchObject({
                statusCode: StatusCodes.BAD_REQUEST
            })
        })

        it('accepts valid toolName patterns', async () => {
            mockFindOne.mockResolvedValue(makeChatflow())
            const result = await mcpServerService.createMcpServerConfig(
                'chatflow-1',
                'ws-1',
                {
                    toolName: 'valid-tool_name123',
                    description: 'A valid tool'
                },
                PERMITTED_TYPES
            )
            expect(result.toolName).toBe('valid-tool_name123')
        })

        it('rejects missing toolName', async () => {
            mockFindOne.mockResolvedValue(makeChatflow())
            await expect(
                mcpServerService.createMcpServerConfig('chatflow-1', 'ws-1', { description: 'desc' } as any, PERMITTED_TYPES)
            ).rejects.toMatchObject({
                statusCode: StatusCodes.BAD_REQUEST
            })
        })

        it('rejects missing description', async () => {
            mockFindOne.mockResolvedValue(makeChatflow())
            await expect(
                mcpServerService.createMcpServerConfig('chatflow-1', 'ws-1', { toolName: 'my_tool' } as any, PERMITTED_TYPES)
            ).rejects.toMatchObject({
                statusCode: StatusCodes.BAD_REQUEST
            })
        })

        it('rejects an overlong description', async () => {
            mockFindOne.mockResolvedValue(makeChatflow())
            await expect(
                mcpServerService.createMcpServerConfig(
                    'chatflow-1',
                    'ws-1',
                    { toolName: 'my_tool', description: 'x'.repeat(4097) },
                    PERMITTED_TYPES
                )
            ).rejects.toMatchObject({ statusCode: StatusCodes.BAD_REQUEST })
        })
    })

    describe('updateMcpServerConfig', () => {
        it('updates description and toolName', async () => {
            const existing = makeHashedConfig()
            mockFindOne.mockResolvedValue(makeChatflow({ mcpServerConfig: JSON.stringify(existing) }))

            const result = await mcpServerService.updateMcpServerConfig(
                'chatflow-1',
                'ws-1',
                {
                    description: 'Updated desc',
                    toolName: 'new_name'
                },
                PERMITTED_TYPES
            )

            expect(result.description).toBe('Updated desc')
            expect(result.toolName).toBe('new_name')
            expect(result).not.toHaveProperty('token')
            expect(result).not.toHaveProperty('tokenHash')
            expect(mockUpdate).toHaveBeenCalled()
            expect(mockSave).not.toHaveBeenCalled()
        })

        it('can disable config via enabled=false', async () => {
            const existing = makeHashedConfig()
            mockFindOne.mockResolvedValue(makeChatflow({ mcpServerConfig: JSON.stringify(existing) }))

            const result = await mcpServerService.updateMcpServerConfig('chatflow-1', 'ws-1', { enabled: false }, PERMITTED_TYPES)
            expect(result.enabled).toBe(false)
            expect(result.hasToken).toBe(false)
            const stored = JSON.parse(mockUpdate.mock.calls[0][1].mcpServerConfig)
            expect(stored).not.toHaveProperty('token')
            expect(stored).not.toHaveProperty('tokenHash')
        })

        it('re-enables a disabled config only by issuing a fresh one-time token', async () => {
            const oldToken = 'b'.repeat(32)
            const existing = makeConfig({ enabled: false, token: oldToken, tokenHash: undefined })
            mockFindOne.mockResolvedValue(makeChatflow({ mcpServerConfig: JSON.stringify(existing) }))

            const result = await mcpServerService.updateMcpServerConfig('chatflow-1', 'ws-1', { enabled: true }, PERMITTED_TYPES)

            expect(result.token).toHaveLength(64)
            expect(result.token).not.toBe(oldToken)
            expect(result.hasToken).toBe(true)
            const stored = JSON.parse(mockUpdate.mock.calls[0][1].mcpServerConfig)
            expect(stored).not.toHaveProperty('token')
            expect(stored.tokenHash).toMatch(/^v1:[0-9a-f]{64}$/)
            expect(stored.tokenHash).not.toBe(createMcpTokenHash('chatflow-1', oldToken))
        })

        it('throws NOT_FOUND when no existing config', async () => {
            mockFindOne.mockResolvedValue(makeChatflow())
            await expect(mcpServerService.updateMcpServerConfig('chatflow-1', 'ws-1', {}, PERMITTED_TYPES)).rejects.toMatchObject({
                statusCode: StatusCodes.NOT_FOUND
            })
        })

        it('rejects invalid toolName on update', async () => {
            const existing = makeHashedConfig()
            mockFindOne.mockResolvedValue(makeChatflow({ mcpServerConfig: JSON.stringify(existing) }))

            await expect(
                mcpServerService.updateMcpServerConfig('chatflow-1', 'ws-1', { toolName: 'a'.repeat(65) }, PERMITTED_TYPES)
            ).rejects.toMatchObject({
                statusCode: StatusCodes.BAD_REQUEST
            })
        })
    })

    describe('deleteMcpServerConfig', () => {
        it('disables the config and irreversibly removes every bearer representation', async () => {
            const existing = makeConfig({ tokenHash: createMcpTokenHash('chatflow-1', 'a'.repeat(32)) })
            mockFindOne.mockResolvedValue(makeChatflow({ mcpServerConfig: JSON.stringify(existing) }))

            await mcpServerService.deleteMcpServerConfig('chatflow-1', 'ws-1', PERMITTED_TYPES)

            expect(mockUpdate).toHaveBeenCalled()
            expect(mockSave).not.toHaveBeenCalled()
            const savedConfig = JSON.parse(mockUpdate.mock.calls[0][1].mcpServerConfig)
            expect(savedConfig.enabled).toBe(false)
            expect(savedConfig).not.toHaveProperty('token')
            expect(savedConfig).not.toHaveProperty('tokenHash')
        })

        it('does nothing when no config exists', async () => {
            mockFindOne.mockResolvedValue(makeChatflow())
            await mcpServerService.deleteMcpServerConfig('chatflow-1', 'ws-1', PERMITTED_TYPES)
            expect(mockUpdate).not.toHaveBeenCalled()
        })

        it('throws NOT_FOUND when chatflow does not exist', async () => {
            mockFindOne.mockResolvedValue(null)
            await expect(mcpServerService.deleteMcpServerConfig('no-such', 'ws-1', PERMITTED_TYPES)).rejects.toMatchObject({
                statusCode: StatusCodes.NOT_FOUND
            })
        })
    })

    describe('refreshMcpToken', () => {
        it('generates a new token', async () => {
            const existing = makeHashedConfig('a'.repeat(32))
            mockFindOne.mockResolvedValue(makeChatflow({ mcpServerConfig: JSON.stringify(existing) }))

            const result = await mcpServerService.refreshMcpToken('chatflow-1', 'ws-1', PERMITTED_TYPES)

            expect(result.token).not.toBe('a'.repeat(32))
            expect(result.token).toHaveLength(64)
            expect(result.enabled).toBe(true)
            expect(mockUpdate).toHaveBeenCalled()
            expect(mockSave).not.toHaveBeenCalled()
            const stored = JSON.parse(mockUpdate.mock.calls[0][1].mcpServerConfig)
            expect(stored).not.toHaveProperty('token')
            expect(stored.tokenHash).toMatch(/^v1:[0-9a-f]{64}$/)
        })

        it('fails closed when the config or type changes between authorization and update', async () => {
            const existing = makeHashedConfig('a'.repeat(32))
            mockFindOne.mockResolvedValue(makeChatflow({ mcpServerConfig: JSON.stringify(existing) }))
            mockUpdate.mockResolvedValue({ affected: 0 })

            await expect(mcpServerService.refreshMcpToken('chatflow-1', 'ws-1', PERMITTED_TYPES)).rejects.toMatchObject({
                statusCode: StatusCodes.CONFLICT
            })
            expect(mockSave).not.toHaveBeenCalled()
        })

        it('throws NOT_FOUND when no config exists', async () => {
            mockFindOne.mockResolvedValue(makeChatflow())
            await expect(mcpServerService.refreshMcpToken('chatflow-1', 'ws-1', PERMITTED_TYPES)).rejects.toMatchObject({
                statusCode: StatusCodes.NOT_FOUND
            })
        })

        it('refuses to rotate a disabled config', async () => {
            const existing = makeConfig({ enabled: false, token: undefined, tokenHash: undefined })
            mockFindOne.mockResolvedValue(makeChatflow({ mcpServerConfig: JSON.stringify(existing) }))

            await expect(mcpServerService.refreshMcpToken('chatflow-1', 'ws-1', PERMITTED_TYPES)).rejects.toMatchObject({
                statusCode: StatusCodes.CONFLICT
            })
            expect(mockUpdate).not.toHaveBeenCalled()
        })

        it('throws NOT_FOUND when chatflow does not exist', async () => {
            mockFindOne.mockResolvedValue(null)
            await expect(mcpServerService.refreshMcpToken('no-such', 'ws-1', PERMITTED_TYPES)).rejects.toMatchObject({
                statusCode: StatusCodes.NOT_FOUND
            })
        })
    })

    describe('getChatflowByIdAndVerifyToken', () => {
        it('returns chatflow when token matches', async () => {
            const token = 'abcdef1234567890abcdef1234567890'
            const config = makeHashedConfig(token)
            const chatflow = makeChatflow({ mcpServerConfig: JSON.stringify(config) })
            mockFindOne.mockResolvedValue(chatflow)

            const result = await mcpServerService.getChatflowByIdAndVerifyToken('chatflow-1', token)
            expect(result.id).toBe('chatflow-1')
            expect(mockQueryBuilder.addSelect).toHaveBeenCalledWith('chatflow.mcpServerConfig')
            expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('chatflow.type IN (:...genericTypes)', {
                genericTypes: [EnumChatflowType.CHATFLOW, EnumChatflowType.AGENTFLOW, EnumChatflowType.MULTIAGENT]
            })
        })

        it('throws UNAUTHORIZED when token does not match', async () => {
            const config = makeHashedConfig('abcdef1234567890abcdef1234567890')
            mockFindOne.mockResolvedValue(makeChatflow({ mcpServerConfig: JSON.stringify(config) }))

            await expect(
                mcpServerService.getChatflowByIdAndVerifyToken('chatflow-1', '00000000000000000000000000000000')
            ).rejects.toMatchObject({
                statusCode: StatusCodes.UNAUTHORIZED
            })
        })

        it('rejects a matching legacy plaintext token without deriving a replacement credential', async () => {
            const token = '1234567890abcdef1234567890abcdef'
            const legacy = makeConfig({ token, tokenHash: undefined })
            mockFindOne.mockResolvedValue(makeChatflow({ mcpServerConfig: JSON.stringify(legacy) }))

            await expect(mcpServerService.getChatflowByIdAndVerifyToken('chatflow-1', token)).rejects.toMatchObject({
                statusCode: StatusCodes.NOT_FOUND
            })
            expect(mockUpdate).not.toHaveBeenCalled()
        })

        it('throws NOT_FOUND when chatflow does not exist', async () => {
            mockFindOne.mockResolvedValue(null)
            await expect(mcpServerService.getChatflowByIdAndVerifyToken('no-such', 'token')).rejects.toMatchObject({
                statusCode: StatusCodes.NOT_FOUND
            })
        })

        it('throws NOT_FOUND when config is disabled', async () => {
            const config = makeConfig({ enabled: false })
            mockFindOne.mockResolvedValue(makeChatflow({ mcpServerConfig: JSON.stringify(config) }))

            await expect(mcpServerService.getChatflowByIdAndVerifyToken('chatflow-1', config.token!)).rejects.toMatchObject({
                statusCode: StatusCodes.NOT_FOUND
            })
        })

        it('throws NOT_FOUND when config has no token', async () => {
            const config = { enabled: true }
            mockFindOne.mockResolvedValue(makeChatflow({ mcpServerConfig: JSON.stringify(config) }))

            await expect(mcpServerService.getChatflowByIdAndVerifyToken('chatflow-1', 'some-token')).rejects.toMatchObject({
                statusCode: StatusCodes.NOT_FOUND
            })
        })
    })
})
