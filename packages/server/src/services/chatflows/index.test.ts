/**
 * Unit tests for chatflowsService.saveChatflow and chatflowsService.updateChatflow.
 * All infrastructure (TypeORM, ScheduleService, ScheduleBeat, telemetry, etc.)
 * is mocked — no DB or Express app required.
 */

// ─── Shared repo mock ─────────────────────────────────────────────────────────

const mockRepo = {
    findOneBy: jest.fn(),
    findOne: jest.fn(),
    find: jest.fn(),
    findBy: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    merge: jest.fn(),
    countBy: jest.fn(),
    createQueryBuilder: jest.fn()
}

const mockDocumentStoreRepo = {
    findOneBy: jest.fn()
}

const mockQueryBuilder = {
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getManyAndCount: jest.fn()
}

const mockAppServer = {
    AppDataSource: {
        options: { type: 'postgres' },
        getRepository: jest.fn().mockReturnValue(mockRepo)
    },
    telemetry: {
        sendTelemetry: jest.fn().mockResolvedValue(undefined)
    },
    identityManager: {
        getProductIdFromSubscription: jest.fn().mockResolvedValue('prod-1')
    },
    metricsProvider: {
        incrementCounter: jest.fn()
    },
    usageCacheManager: {}
}

// ─── Mocks ────────────────────────────────────────────────────────────────────

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: jest.fn().mockReturnValue(mockAppServer)
}))
jest.mock('../../database/entities/ChatFlow', () => ({
    ChatFlow: class ChatFlow {},
    EnumChatflowType: { AGENTFLOW: 'AGENTFLOW', CHATFLOW: 'CHATFLOW', MULTIAGENT: 'MULTIAGENT', ASSISTANT: 'ASSISTANT' }
}))
jest.mock('../../database/entities/ChatMessage', () => ({ ChatMessage: class ChatMessage {} }))
jest.mock('../../database/entities/ChatMessageFeedback', () => ({ ChatMessageFeedback: class ChatMessageFeedback {} }))
jest.mock('../../database/entities/DocumentStore', () => ({ DocumentStore: class DocumentStore {} }))
jest.mock('../../database/entities/UpsertHistory', () => ({ UpsertHistory: class UpsertHistory {} }))
jest.mock('../../database/entities/ScheduleRecord', () => ({
    ScheduleRecord: class ScheduleRecord {},
    ScheduleTriggerType: { AGENTFLOW: 'AGENTFLOW' }
}))
jest.mock('../../enterprise/database/entities/workspace.entity', () => ({ Workspace: class Workspace {} }))
jest.mock('../../enterprise/utils/ControllerServiceUtils', () => ({ getWorkspaceSearchOptions: jest.fn().mockReturnValue({}) }))
jest.mock('../../errors/internalFlowiseError', () => ({
    InternalFlowiseError: class InternalFlowiseError extends Error {
        constructor(public statusCode: number, message: string) {
            super(message)
            this.name = 'InternalFlowiseError'
        }
    }
}))
jest.mock('../../errors/utils', () => ({ getErrorMessage: (e: unknown) => String(e) }))
jest.mock('../../services/documentstore', () => ({
    __esModule: true,
    default: { updateDocumentStoreUsage: jest.fn().mockResolvedValue(undefined) }
}))
jest.mock('../../utils', () => ({
    constructGraphs: jest.fn().mockReturnValue({ graph: {}, nodeDependencies: {} }),
    decryptCredentialData: jest.fn().mockResolvedValue({ secret: 'decrypted' }),
    encryptCredentialData: jest.fn().mockResolvedValue('encrypted-secret'),
    getAppVersion: jest.fn().mockResolvedValue('1.0.0'),
    getEndingNodes: jest.fn().mockReturnValue([]),
    getTelemetryFlowObj: jest.fn().mockReturnValue({}),
    isFlowValidForStream: jest.fn().mockReturnValue(false)
}))
jest.mock('../../utils/fileValidation', () => ({
    sanitizeAllowedUploadMimeTypesFromConfig: jest.fn((x: string) => x)
}))
jest.mock('../../utils/fileRepository', () => ({
    containsBase64File: jest.fn().mockReturnValue(false),
    updateFlowDataWithFilePaths: jest.fn().mockImplementation(async (_id: string, fd: string) => fd)
}))
jest.mock('../../utils/sanitizeFlowData', () => ({
    sanitizeFlowDataForPublicEndpoint: jest.fn().mockReturnValue('{}')
}))
jest.mock('../../utils/getUploadsConfig', () => ({ utilGetUploadsConfig: jest.fn().mockResolvedValue(null) }))
jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() }
}))
jest.mock('../../utils/quotaUsage', () => ({ updateStorageUsage: jest.fn().mockResolvedValue(undefined) }))
jest.mock('../../services/schedule', () => ({
    __esModule: true,
    default: {
        resolveScheduleCron: jest.fn().mockReturnValue({ valid: true, cronExpression: '* * * * *' }),
        canScheduleEnable: jest.fn().mockReturnValue(true),
        createOrUpdateSchedule: jest.fn().mockResolvedValue({ id: 'sched-1', enabled: true }),
        deleteScheduleForTarget: jest.fn().mockResolvedValue(undefined)
    }
}))
jest.mock('../../schedule/ScheduleBeat', () => ({
    ScheduleBeat: {
        getInstance: jest.fn().mockReturnValue({
            onScheduleChanged: jest.fn().mockResolvedValue(undefined)
        })
    }
}))
jest.mock('flowise-components', () => ({ removeFolderFromStorage: jest.fn().mockResolvedValue({ totalSize: 0 }) }), { virtual: true })
jest.mock('uuid', () => ({
    validate: jest.fn((value: unknown) =>
        typeof value === 'string'
            ? value === 'flow-1' || /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
            : false
    ),
    v4: jest.fn().mockReturnValue('mock-uuid-v4')
}))
jest.mock('http-status-codes', () => ({
    StatusCodes: { OK: 200, BAD_REQUEST: 400, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, INTERNAL_SERVER_ERROR: 500 }
}))

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import chatflowsService from './index'
import scheduleService from '../../services/schedule'
import { ScheduleBeat } from '../../schedule/ScheduleBeat'
import { containsBase64File } from '../../utils/fileRepository'
import { EnumChatflowType } from '../../database/entities/ChatFlow'
import { ScheduleTriggerType } from '../../database/entities/ScheduleRecord'
import { DocumentStore } from '../../database/entities/DocumentStore'
import documentStoreService from '../../services/documentstore'
import logger from '../../utils/logger'

const mockContainsBase64File = containsBase64File as jest.Mock
const mockCreateOrUpdateSchedule = scheduleService.createOrUpdateSchedule as jest.Mock
const mockDeleteScheduleForTarget = scheduleService.deleteScheduleForTarget as jest.Mock
const mockResolveScheduleCron = scheduleService.resolveScheduleCron as jest.Mock
const mockCanScheduleEnable = scheduleService.canScheduleEnable as jest.Mock
const mockUpdateDocumentStoreUsage = documentStoreService.updateDocumentStoreUsage as jest.Mock

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal scheduleInput AGENTFLOW flowData JSON */
const makeScheduleFlowData = (inputs: Record<string, unknown> = {}) =>
    JSON.stringify({
        nodes: [
            {
                id: 'start-0',
                data: {
                    name: 'startAgentflow',
                    inputs: {
                        startInputType: 'scheduleInput',
                        scheduleCronExpression: '* * * * *',
                        scheduleTimezone: 'UTC',
                        scheduleInputMode: 'text',
                        scheduleDefaultInput: 'hello',
                        ...inputs
                    }
                }
            }
        ],
        edges: []
    })

/** Build a non-schedule AGENTFLOW flowData JSON (chatInput start) */
const makeChatInputFlowData = () =>
    JSON.stringify({
        nodes: [{ id: 'start-0', data: { name: 'startAgentflow', inputs: { startInputType: 'chatInput' } } }],
        edges: []
    })

/** Build a plain (non-agentflow) flowData JSON */
const makePlainFlowData = () => JSON.stringify({ nodes: [], edges: [] })

const STORE_A = '11111111-1111-4111-8111-111111111111'
const STORE_B = '22222222-2222-4222-8222-222222222222'
const STORE_C = '33333333-3333-4333-8333-333333333333'
const STORE_D = '44444444-4444-4444-8444-444444444444'
const LEGACY_STORE_ID = 'store-1'

const makeDocumentStoreFlowData = (name: 'documentStore' | 'documentStoreVS', selectedStore: unknown) =>
    JSON.stringify({
        nodes: [{ id: 'store-0', data: { name, inputs: { selectedStore } } }],
        edges: []
    })

const makeAllDocumentStoreReferencesFlowData = () =>
    JSON.stringify({
        nodes: [
            { id: 'loader-0', data: { name: 'documentStore', inputs: { selectedStore: STORE_A } } },
            { id: 'vector-0', data: { name: 'documentStoreVS', inputs: { selectedStore: STORE_B } } },
            {
                id: 'agent-0',
                data: {
                    name: 'agentAgentflow',
                    inputs: {
                        agentKnowledgeDocumentStores: [
                            { documentStore: `${STORE_C}:Agent knowledge` },
                            { documentStore: `${STORE_A}:Duplicate loader reference` }
                        ]
                    }
                }
            },
            {
                id: 'retriever-0',
                data: {
                    name: 'retrieverAgentflow',
                    inputs: { retrieverKnowledgeDocumentStores: [{ documentStore: `${STORE_D}:Retriever knowledge` }] }
                }
            }
        ],
        edges: []
    })

const makeChatflow = (overrides: Record<string, unknown> = {}) => ({
    id: 'flow-1',
    type: EnumChatflowType.AGENTFLOW,
    flowData: makeScheduleFlowData(),
    workspaceId: 'ws-1',
    chatbotConfig: undefined,
    ...overrides
})

const SAVE_ARGS = {
    orgId: 'org-1',
    workspaceId: 'ws-1',
    subscriptionId: 'sub-1',
    usageCacheManager: {} as any
}

beforeEach(() => {
    jest.clearAllMocks()
    mockAppServer.AppDataSource.options.type = 'postgres'
    mockAppServer.AppDataSource.getRepository.mockImplementation((entity: unknown) =>
        entity === DocumentStore ? mockDocumentStoreRepo : mockRepo
    )
    mockRepo.create.mockImplementation((x: unknown) => x)
    mockRepo.createQueryBuilder.mockReturnValue(mockQueryBuilder)
    mockRepo.findBy.mockResolvedValue([])
    mockDocumentStoreRepo.findOneBy.mockImplementation(async ({ id, workspaceId }: { id: string; workspaceId: string }) => ({
        id,
        workspaceId
    }))
    mockQueryBuilder.getManyAndCount.mockResolvedValue([[], 0])
    mockRepo.save.mockResolvedValue(makeChatflow())
    mockRepo.update.mockResolvedValue({ affected: 1 })
    mockRepo.merge.mockImplementation((_existing: any, updates: any) => ({ ...makeChatflow(), ...updates }))
    mockContainsBase64File.mockReturnValue(false)
    mockCreateOrUpdateSchedule.mockResolvedValue({ id: 'sched-1', enabled: true })
    mockDeleteScheduleForTarget.mockResolvedValue(undefined)
    mockResolveScheduleCron.mockReturnValue({ valid: true, cronExpression: '* * * * *' })
    mockCanScheduleEnable.mockReturnValue(true)
    ;(ScheduleBeat.getInstance as jest.Mock).mockReturnValue({
        onScheduleChanged: jest.fn().mockResolvedValue(undefined)
    })
})

describe('generic capability endpoints', () => {
    it('hides Assistant backing flows from the streaming capability endpoint', async () => {
        mockRepo.findOneBy.mockResolvedValue(makeChatflow({ type: EnumChatflowType.ASSISTANT }))

        await expect(chatflowsService.checkIfChatflowIsValidForStreaming('flow-1')).rejects.toMatchObject({ statusCode: 404 })
    })

    it('hides Assistant backing flows from the uploads capability endpoint', async () => {
        mockRepo.findOne.mockResolvedValue(makeChatflow({ type: EnumChatflowType.ASSISTANT }))

        await expect(chatflowsService.checkIfChatflowIsValidForUploads('flow-1')).rejects.toMatchObject({ statusCode: 404 })
    })
})

describe('custom assistant backing-flow deletion guard', () => {
    const linkedAssistant = {
        id: 'assistant-1',
        workspaceId: 'ws-1',
        type: 'CUSTOM',
        details: JSON.stringify({ name: 'Assistant', flowId: 'flow-1' })
    }

    beforeEach(() => {
        mockRepo.findOne.mockResolvedValue(makeChatflow({ id: 'flow-1', type: EnumChatflowType.ASSISTANT, workspaceId: 'ws-1' }))
        mockRepo.findBy.mockResolvedValue([linkedAssistant])
        mockRepo.delete.mockResolvedValue({ affected: 1 })
    })

    it('preserves the fixed 409 and performs no delete for a linked ASSISTANT flow', async () => {
        await expect(chatflowsService.deleteChatflow('flow-1', 'org-1', 'ws-1', [EnumChatflowType.ASSISTANT])).rejects.toMatchObject({
            statusCode: 409,
            message: 'Linked custom assistant flow must be deleted through the custom assistant endpoint'
        })
        expect(mockRepo.delete).not.toHaveBeenCalled()
    })

    it('fails closed with a fixed 409 when custom assistant ownership data is malformed', async () => {
        mockRepo.findBy.mockResolvedValue([{ ...linkedAssistant, details: '{' }])

        await expect(chatflowsService.deleteChatflow('flow-1', 'org-1', 'ws-1', [EnumChatflowType.ASSISTANT])).rejects.toMatchObject({
            statusCode: 409,
            message: 'Unable to verify custom assistant flow ownership'
        })
        expect(mockRepo.delete).not.toHaveBeenCalled()
    })

    it('returns a fixed 500 without exposing an unexpected lookup error', async () => {
        mockRepo.findOne.mockRejectedValue(new Error('secret database detail'))

        await expect(chatflowsService.deleteChatflow('flow-1', 'org-1', 'ws-1', [EnumChatflowType.ASSISTANT])).rejects.toMatchObject({
            statusCode: 500,
            message: 'Unable to load chatflow'
        })
        expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('secret database detail')
        expect(mockRepo.delete).not.toHaveBeenCalled()
    })
})

describe('getAllChatflows', () => {
    it.each([undefined, '', '   '])('fails closed without a workspace before creating a query builder (%p)', async (workspaceId) => {
        await expect(chatflowsService.getAllChatflows(undefined, workspaceId)).rejects.toMatchObject({
            statusCode: 400,
            message: 'Workspace ID is required'
        })
        expect(mockRepo.createQueryBuilder).not.toHaveBeenCalled()
    })

    it('filters an untyped list to the actual user-permitted flow types', async () => {
        await chatflowsService.getAllChatflows(undefined, 'ws-1', -1, -1, undefined, undefined, undefined, [
            EnumChatflowType.AGENTFLOW,
            EnumChatflowType.MULTIAGENT
        ])

        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('chat_flow.type IN (:...permittedTypes)', {
            permittedTypes: [EnumChatflowType.AGENTFLOW, EnumChatflowType.MULTIAGENT]
        })
        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith('chat_flow.workspaceId = :workspaceId', { workspaceId: 'ws-1' })
    })

    it('rejects a requested type outside the supplied permission scope before querying', async () => {
        await expect(
            chatflowsService.getAllChatflows(EnumChatflowType.AGENTFLOW, 'ws-1', -1, -1, undefined, undefined, undefined, [
                EnumChatflowType.CHATFLOW
            ])
        ).rejects.toMatchObject({ statusCode: 403 })
        expect(mockRepo.createQueryBuilder).not.toHaveBeenCalled()
    })

    it('applies search before pagination so totals and pages share one filtered dataset', async () => {
        await chatflowsService.getAllChatflows(EnumChatflowType.CHATFLOW, 'ws-1', 2, 10, 'Needle', 'name', 'asc')

        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
            `(LOWER(chat_flow.name) LIKE :search OR LOWER(COALESCE(chat_flow.category, '')) LIKE :search OR LOWER(CAST(chat_flow.id AS TEXT)) LIKE :search)`,
            { search: '%needle%' }
        )
        expect(mockQueryBuilder.skip).toHaveBeenCalledWith(10)
        expect(mockQueryBuilder.take).toHaveBeenCalledWith(10)
        expect(mockQueryBuilder.orderBy).toHaveBeenCalledWith('chat_flow.name', 'ASC')
        expect(mockQueryBuilder.addOrderBy).toHaveBeenCalledWith('chat_flow.id', 'ASC')
    })

    it('keeps the native text id search expression for non-Postgres databases', async () => {
        mockAppServer.AppDataSource.options.type = 'sqlite'

        await chatflowsService.getAllChatflows(EnumChatflowType.AGENTFLOW, 'ws-1', 1, 12, 'Needle', 'updatedDate', 'desc')

        expect(mockQueryBuilder.andWhere).toHaveBeenCalledWith(
            `(LOWER(chat_flow.name) LIKE :search OR LOWER(COALESCE(chat_flow.category, '')) LIKE :search OR LOWER(chat_flow.id) LIKE :search)`,
            { search: '%needle%' }
        )
    })
})

describe('workspace and type-scoped chatflow lookup', () => {
    it('rejects a foreign flow type after a minimal scoped type lookup', async () => {
        mockRepo.findOne.mockResolvedValue({ id: 'flow-1', type: EnumChatflowType.AGENTFLOW })

        await expect(
            chatflowsService.assertChatflowInWorkspaceAndTypes('flow-1', 'ws-1', [EnumChatflowType.CHATFLOW])
        ).rejects.toMatchObject({ statusCode: 403 })
        expect(mockRepo.findOne).toHaveBeenCalledWith({
            where: { id: 'flow-1', workspaceId: 'ws-1' },
            select: ['id', 'type']
        })
    })

    it('loads the full entity only after the scoped type is authorized', async () => {
        const fullFlow = makeChatflow({ type: EnumChatflowType.CHATFLOW, flowData: makePlainFlowData() })
        mockRepo.findOne.mockResolvedValueOnce({ id: 'flow-1', type: EnumChatflowType.CHATFLOW }).mockResolvedValueOnce(fullFlow)

        await expect(chatflowsService.getChatflowByIdForWorkspaceAndTypes('flow-1', 'ws-1', [EnumChatflowType.CHATFLOW])).resolves.toBe(
            fullFlow
        )
        expect(mockRepo.findOne).toHaveBeenNthCalledWith(2, {
            where: { id: 'flow-1', workspaceId: 'ws-1', type: EnumChatflowType.CHATFLOW }
        })
    })

    it('rejects Assistant records from generic reads even for a generic organization-admin scope', async () => {
        mockRepo.findOne.mockResolvedValue({ id: 'flow-1', type: EnumChatflowType.ASSISTANT })

        await expect(
            chatflowsService.assertChatflowInWorkspaceAndTypes('flow-1', 'ws-1', [
                EnumChatflowType.CHATFLOW,
                EnumChatflowType.AGENTFLOW,
                EnumChatflowType.MULTIAGENT
            ])
        ).rejects.toMatchObject({ statusCode: 403 })
    })
})

describe('generic endpoint server-state boundaries', () => {
    it('scopes webhook-secret writes by workspace and permitted flow type', async () => {
        const flow = makeChatflow({ type: EnumChatflowType.CHATFLOW, flowData: makePlainFlowData() })
        mockRepo.findOne.mockResolvedValue(flow)

        await chatflowsService.setWebhookSecret('flow-1', 'ws-1', [EnumChatflowType.CHATFLOW])

        expect(mockRepo.findOne).toHaveBeenCalledWith({
            where: {
                id: 'flow-1',
                workspaceId: 'ws-1'
            },
            select: ['id', 'type']
        })
        expect(mockRepo.update).toHaveBeenCalledWith(
            {
                id: 'flow-1',
                workspaceId: 'ws-1',
                type: EnumChatflowType.CHATFLOW,
                webhookSecret: { type: 'isNull', value: undefined }
            },
            { webhookSecret: 'encrypted-secret', webhookSecretConfigured: true }
        )
        expect(mockRepo.save).not.toHaveBeenCalled()
    })

    it('performs no webhook-secret write when the scoped permitted-type query misses', async () => {
        mockRepo.findOne.mockResolvedValue(null)

        await expect(chatflowsService.clearWebhookSecret('flow-1', 'ws-1', [EnumChatflowType.CHATFLOW])).rejects.toMatchObject({
            statusCode: 404
        })
        expect(mockRepo.update).not.toHaveBeenCalled()
        expect(mockRepo.save).not.toHaveBeenCalled()
    })

    it('fails closed when a webhook target changes after authorization', async () => {
        mockRepo.findOne.mockResolvedValue(makeChatflow({ type: EnumChatflowType.CHATFLOW }))
        mockRepo.update.mockResolvedValue({ affected: 0 })

        await expect(chatflowsService.clearWebhookSecret('flow-1', 'ws-1', [EnumChatflowType.CHATFLOW])).rejects.toMatchObject({
            statusCode: 409
        })
        expect(mockRepo.save).not.toHaveBeenCalled()
    })

    it('hides Assistant backing flows from the generic public chatbot-config service', async () => {
        mockRepo.findOneBy.mockResolvedValue(makeChatflow({ type: EnumChatflowType.ASSISTANT }))

        await expect(chatflowsService.getSinglePublicChatbotConfig('flow-1')).rejects.toMatchObject({ statusCode: 404 })
    })
})

// ─── saveChatflow ─────────────────────────────────────────────────────────────

describe('saveChatflow', () => {
    it('saves and returns the chatflow', async () => {
        const newFlow = makeChatflow({ type: EnumChatflowType.AGENTFLOW })
        const saved = makeChatflow()
        mockRepo.save.mockResolvedValue(saved)

        const result = await chatflowsService.saveChatflow(
            newFlow as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        expect(mockRepo.save).toHaveBeenCalled()
        expect(result).toBe(saved)
    })

    it('removes MCP and webhook server state before repository create or save', async () => {
        const newFlow = makeChatflow({
            type: EnumChatflowType.CHATFLOW,
            flowData: makePlainFlowData(),
            mcpServerConfig: '{"token":"attacker"}',
            webhookSecret: 'attacker-secret',
            webhookSecretConfigured: true
        })
        mockRepo.save.mockImplementation(async (value: unknown) => value)

        const result = await chatflowsService.saveChatflow(
            newFlow as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        expect(mockRepo.create).toHaveBeenCalledWith(expect.not.objectContaining({ mcpServerConfig: expect.anything() }))
        expect(result).not.toHaveProperty('mcpServerConfig')
        expect(result).not.toHaveProperty('webhookSecret')
        expect(result).not.toHaveProperty('webhookSecretConfigured')
    })

    it('rejects Assistant creation through the generic service before persistence', async () => {
        const newFlow = makeChatflow({ type: EnumChatflowType.ASSISTANT, flowData: makePlainFlowData() })

        await expect(
            chatflowsService.saveChatflow(
                newFlow as any,
                SAVE_ARGS.orgId,
                SAVE_ARGS.workspaceId,
                SAVE_ARGS.subscriptionId,
                SAVE_ARGS.usageCacheManager
            )
        ).rejects.toMatchObject({ statusCode: 403 })
        expect(mockDocumentStoreRepo.findOneBy).not.toHaveBeenCalled()
        expect(mockRepo.save).not.toHaveBeenCalled()
    })

    it.each([
        ['document loader', 'documentStore' as const],
        ['document vector store', 'documentStoreVS' as const]
    ])('validates and synchronizes a %s reference on ordinary create', async (_label, nodeName) => {
        const newFlow = makeChatflow({ type: EnumChatflowType.CHATFLOW, flowData: makeDocumentStoreFlowData(nodeName, STORE_A) })
        mockRepo.save.mockImplementation(async (value: unknown) => value)

        await chatflowsService.saveChatflow(
            newFlow as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        expect(mockDocumentStoreRepo.findOneBy).toHaveBeenCalledWith({ id: STORE_A, workspaceId: 'ws-1' })
        expect(mockUpdateDocumentStoreUsage).toHaveBeenCalledWith('flow-1', [STORE_A], 'ws-1')
    })

    it('keeps a bounded non-UUID legacy store reference maintainable after migration', async () => {
        const newFlow = makeChatflow({
            type: EnumChatflowType.CHATFLOW,
            flowData: makeDocumentStoreFlowData('documentStoreVS', LEGACY_STORE_ID)
        })
        mockRepo.save.mockImplementation(async (value: unknown) => value)

        await chatflowsService.saveChatflow(
            newFlow as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        expect(mockDocumentStoreRepo.findOneBy).toHaveBeenCalledWith({ id: LEGACY_STORE_ID, workspaceId: 'ws-1' })
        expect(mockUpdateDocumentStoreUsage).toHaveBeenCalledWith('flow-1', [LEGACY_STORE_ID], 'ws-1')
    })

    it('validates every distinct loader, vector, Agent and Retriever reference before saving', async () => {
        const flowData = makeAllDocumentStoreReferencesFlowData()
        const newFlow = makeChatflow({ type: EnumChatflowType.AGENTFLOW, flowData })
        mockRepo.save.mockImplementation(async (value: unknown) => value)

        await chatflowsService.saveChatflow(
            newFlow as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        expect(mockDocumentStoreRepo.findOneBy).toHaveBeenCalledTimes(4)
        expect(mockDocumentStoreRepo.findOneBy.mock.calls.map(([where]) => where)).toEqual([
            { id: STORE_A, workspaceId: 'ws-1' },
            { id: STORE_B, workspaceId: 'ws-1' },
            { id: STORE_C, workspaceId: 'ws-1' },
            { id: STORE_D, workspaceId: 'ws-1' }
        ])
        expect(mockRepo.save).toHaveBeenCalledTimes(1)
        expect(mockUpdateDocumentStoreUsage).toHaveBeenCalledWith('flow-1', [STORE_A, STORE_B, STORE_C, STORE_D], 'ws-1')
    })

    it('rejects before saving when a later store in a multi-store flow is not tenant-owned', async () => {
        mockDocumentStoreRepo.findOneBy.mockImplementation(async ({ id, workspaceId }: { id: string; workspaceId: string }) =>
            id === STORE_A ? { id, workspaceId } : undefined
        )
        const flow = makeChatflow({ flowData: makeAllDocumentStoreReferencesFlowData() })

        await expect(
            chatflowsService.saveChatflow(
                flow as any,
                SAVE_ARGS.orgId,
                SAVE_ARGS.workspaceId,
                SAVE_ARGS.subscriptionId,
                SAVE_ARGS.usageCacheManager
            )
        ).rejects.toMatchObject({
            statusCode: 404,
            message: 'One or more document stores were not found in the workspace'
        })
        expect(mockDocumentStoreRepo.findOneBy).toHaveBeenCalledTimes(2)
        expect(mockRepo.save).not.toHaveBeenCalled()
        expect(mockUpdateDocumentStoreUsage).not.toHaveBeenCalled()
    })

    it('fails closed before save and usage when a referenced store is missing or belongs to another workspace', async () => {
        mockDocumentStoreRepo.findOneBy.mockResolvedValue(undefined)
        const flow = makeChatflow({ flowData: makeDocumentStoreFlowData('documentStore', STORE_A) })

        await expect(
            chatflowsService.saveChatflow(
                flow as any,
                SAVE_ARGS.orgId,
                SAVE_ARGS.workspaceId,
                SAVE_ARGS.subscriptionId,
                SAVE_ARGS.usageCacheManager
            )
        ).rejects.toMatchObject({
            statusCode: 404,
            message: 'One or more document stores were not found in the workspace'
        })
        expect(mockRepo.save).not.toHaveBeenCalled()
        expect(mockUpdateDocumentStoreUsage).not.toHaveBeenCalled()
    })

    it('validates references before the first persistence step of a Base64 create', async () => {
        mockContainsBase64File.mockReturnValue(true)
        mockDocumentStoreRepo.findOneBy.mockResolvedValue(undefined)
        const flow = makeChatflow({ flowData: makeDocumentStoreFlowData('documentStore', STORE_A) })

        await expect(
            chatflowsService.saveChatflow(
                flow as any,
                SAVE_ARGS.orgId,
                SAVE_ARGS.workspaceId,
                SAVE_ARGS.subscriptionId,
                SAVE_ARGS.usageCacheManager
            )
        ).rejects.toMatchObject({ statusCode: 404 })
        expect(mockRepo.create).not.toHaveBeenCalled()
        expect(mockRepo.save).not.toHaveBeenCalled()
        expect(mockUpdateDocumentStoreUsage).not.toHaveBeenCalled()
    })

    it.each([
        ['invalid JSON', '{'],
        ['nodes is not an array', JSON.stringify({ nodes: {} })],
        ['selectedStore is not a string', makeDocumentStoreFlowData('documentStore', { id: STORE_A })],
        [
            'Agent knowledge is not an array',
            JSON.stringify({
                nodes: [
                    {
                        id: 'agent-0',
                        data: { name: 'agentAgentflow', inputs: { agentKnowledgeDocumentStores: { documentStore: STORE_A } } }
                    }
                ]
            })
        ],
        [
            'Agent knowledge is null',
            JSON.stringify({
                nodes: [
                    {
                        id: 'agent-0',
                        data: { name: 'agentAgentflow', inputs: { agentKnowledgeDocumentStores: null } }
                    }
                ]
            })
        ],
        [
            'Retriever knowledge item is not an object',
            JSON.stringify({
                nodes: [
                    {
                        id: 'retriever-0',
                        data: { name: 'retrieverAgentflow', inputs: { retrieverKnowledgeDocumentStores: [STORE_A] } }
                    }
                ]
            })
        ],
        [
            'knowledge documentStore prefix exceeds the legacy bound',
            JSON.stringify({
                nodes: [
                    {
                        id: 'agent-0',
                        data: {
                            name: 'agentAgentflow',
                            inputs: { agentKnowledgeDocumentStores: [{ documentStore: `${'x'.repeat(257)}:Knowledge` }] }
                        }
                    }
                ]
            })
        ]
    ])('rejects malformed document-store flow data before save: %s', async (_label, flowData) => {
        const flow = makeChatflow({ flowData })

        await expect(
            chatflowsService.saveChatflow(
                flow as any,
                SAVE_ARGS.orgId,
                SAVE_ARGS.workspaceId,
                SAVE_ARGS.subscriptionId,
                SAVE_ARGS.usageCacheManager
            )
        ).rejects.toMatchObject({ statusCode: 400, message: 'Chatflow contains an invalid document store reference' })
        expect(mockRepo.save).not.toHaveBeenCalled()
        expect(mockUpdateDocumentStoreUsage).not.toHaveBeenCalled()
    })

    it('fails closed when workspaceId is missing', async () => {
        const flow = makeChatflow({ flowData: makeDocumentStoreFlowData('documentStore', STORE_A) })

        await expect(
            chatflowsService.saveChatflow(flow as any, SAVE_ARGS.orgId, '', SAVE_ARGS.subscriptionId, SAVE_ARGS.usageCacheManager)
        ).rejects.toMatchObject({ statusCode: 400, message: 'Workspace ID is required' })
        expect(mockDocumentStoreRepo.findOneBy).not.toHaveBeenCalled()
        expect(mockRepo.save).not.toHaveBeenCalled()
        expect(mockUpdateDocumentStoreUsage).not.toHaveBeenCalled()
    })

    it('synchronizes an ordinary create with no DocumentStore reference', async () => {
        const newFlow = makeChatflow({ type: EnumChatflowType.CHATFLOW, flowData: makePlainFlowData() })
        mockRepo.save.mockImplementation(async (value: unknown) => value)

        await chatflowsService.saveChatflow(
            newFlow as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        expect(mockDocumentStoreRepo.findOneBy).not.toHaveBeenCalled()
        expect(mockUpdateDocumentStoreUsage).toHaveBeenCalledWith('flow-1', [], 'ws-1')
    })

    it('throws BAD_REQUEST for an invalid chatflow type', async () => {
        const badFlow = makeChatflow({ type: 'INVALID_TYPE' })

        await expect(
            chatflowsService.saveChatflow(
                badFlow as any,
                SAVE_ARGS.orgId,
                SAVE_ARGS.workspaceId,
                SAVE_ARGS.subscriptionId,
                SAVE_ARGS.usageCacheManager
            )
        ).rejects.toMatchObject({ statusCode: 400 })
    })

    // ── schedule sync (AGENTFLOW + scheduleInput) ────────────────────────────

    it('creates or updates the schedule when the start node is scheduleInput', async () => {
        const newFlow = makeChatflow()
        mockRepo.save.mockResolvedValue(makeChatflow({ flowData: makeScheduleFlowData() }))

        await chatflowsService.saveChatflow(
            newFlow as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        expect(mockCreateOrUpdateSchedule).toHaveBeenCalledWith(
            expect.objectContaining({
                triggerType: ScheduleTriggerType.AGENTFLOW,
                targetId: 'flow-1',
                workspaceId: 'ws-1'
            })
        )
    })

    it('calls onScheduleChanged upsert when the schedule is enabled', async () => {
        mockRepo.save.mockResolvedValue(makeChatflow({ flowData: makeScheduleFlowData() }))
        mockCreateOrUpdateSchedule.mockResolvedValue({ id: 'sched-1', enabled: true })
        mockCanScheduleEnable.mockReturnValue(true)

        await chatflowsService.saveChatflow(
            makeChatflow() as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        const beat = ScheduleBeat.getInstance()
        expect(beat.onScheduleChanged).toHaveBeenCalledWith('sched-1', 'upsert')
    })

    it('does NOT call onScheduleChanged when the schedule is disabled', async () => {
        mockRepo.save.mockResolvedValue(makeChatflow({ flowData: makeScheduleFlowData() }))
        mockCreateOrUpdateSchedule.mockResolvedValue({ id: 'sched-1', enabled: false })
        mockCanScheduleEnable.mockReturnValue(false)

        await chatflowsService.saveChatflow(
            makeChatflow() as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        const beat = ScheduleBeat.getInstance()
        expect(beat.onScheduleChanged).not.toHaveBeenCalled()
    })

    it('passes scheduleEndDate as a Date when set in flowData', async () => {
        const futureDate = new Date(Date.now() + 86_400_000).toISOString()
        mockRepo.save.mockResolvedValue(makeChatflow({ flowData: makeScheduleFlowData({ scheduleEndDate: futureDate }) }))

        await chatflowsService.saveChatflow(
            makeChatflow() as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        expect(mockCreateOrUpdateSchedule).toHaveBeenCalledWith(expect.objectContaining({ endDate: expect.any(Date) }))
    })

    it('passes undefined endDate when scheduleEndDate is not set', async () => {
        mockRepo.save.mockResolvedValue(makeChatflow({ flowData: makeScheduleFlowData() }))

        await chatflowsService.saveChatflow(
            makeChatflow() as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        expect(mockCreateOrUpdateSchedule).toHaveBeenCalledWith(expect.objectContaining({ endDate: undefined }))
    })

    // ── schedule input mode ───────────────────────────────────────────────────

    it("defaults scheduleInputMode to 'text' and passes defaultInput when mode is not set", async () => {
        mockRepo.save.mockResolvedValue(makeChatflow({ flowData: makeScheduleFlowData() }))

        await chatflowsService.saveChatflow(
            makeChatflow() as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        expect(mockCreateOrUpdateSchedule).toHaveBeenCalledWith(
            expect.objectContaining({ scheduleInputMode: 'text', defaultInput: 'hello', defaultForm: undefined })
        )
    })

    it("passes defaultForm (stringified) when scheduleInputMode is 'form'", async () => {
        mockRepo.save.mockResolvedValue(
            makeChatflow({
                flowData: makeScheduleFlowData({
                    scheduleInputMode: 'form',
                    scheduleFormDefaults: { team: 'eng', metric: 'p95' },
                    scheduleDefaultInput: ''
                })
            })
        )

        await chatflowsService.saveChatflow(
            makeChatflow() as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        const call = mockCreateOrUpdateSchedule.mock.calls[0][0]
        expect(call.scheduleInputMode).toBe('form')
        expect(call.defaultInput).toBe('') // cleared in form mode
        expect(JSON.parse(call.defaultForm)).toEqual({ team: 'eng', metric: 'p95' })
    })

    it("passes empty defaultInput and no defaultForm when scheduleInputMode is 'none'", async () => {
        mockRepo.save.mockResolvedValue(
            makeChatflow({ flowData: makeScheduleFlowData({ scheduleInputMode: 'none', scheduleDefaultInput: 'ignored' }) })
        )

        await chatflowsService.saveChatflow(
            makeChatflow() as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        expect(mockCreateOrUpdateSchedule).toHaveBeenCalledWith(
            expect.objectContaining({ scheduleInputMode: 'none', defaultInput: '', defaultForm: undefined })
        )
    })

    it('does not create a schedule when the start node type is chatInput', async () => {
        mockRepo.save.mockResolvedValue(makeChatflow({ flowData: makeChatInputFlowData() }))

        await chatflowsService.saveChatflow(
            makeChatflow({ flowData: makeChatInputFlowData() }) as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        expect(mockCreateOrUpdateSchedule).not.toHaveBeenCalled()
    })

    it('does not create a schedule for a non-AGENTFLOW type', async () => {
        const chatflow = makeChatflow({ type: EnumChatflowType.CHATFLOW, flowData: makePlainFlowData() })
        mockRepo.save.mockResolvedValue(chatflow)

        await chatflowsService.saveChatflow(
            chatflow as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        expect(mockCreateOrUpdateSchedule).not.toHaveBeenCalled()
    })

    // ── telemetry ─────────────────────────────────────────────────────────────

    it('sends chatflow_created telemetry after saving', async () => {
        mockRepo.save.mockResolvedValue(makeChatflow({ flowData: makePlainFlowData() }))

        await chatflowsService.saveChatflow(
            makeChatflow({ type: EnumChatflowType.CHATFLOW, flowData: makePlainFlowData() }) as any,
            SAVE_ARGS.orgId,
            SAVE_ARGS.workspaceId,
            SAVE_ARGS.subscriptionId,
            SAVE_ARGS.usageCacheManager
        )

        expect(mockAppServer.telemetry.sendTelemetry).toHaveBeenCalledWith('chatflow_created', expect.any(Object), SAVE_ARGS.orgId)
    })
})

// ─── updateChatflow ───────────────────────────────────────────────────────────

describe('updateChatflow', () => {
    const existingFlow = makeChatflow()

    it('conditionally updates and returns the merged chatflow', async () => {
        const updates = makeChatflow({ flowData: makeScheduleFlowData() })
        const merged = { ...existingFlow, ...updates }
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockResolvedValue(merged)

        const result = await chatflowsService.updateChatflow(existingFlow as any, updates as any, 'org-1', 'ws-1', 'sub-1')

        expect(mockRepo.merge).toHaveBeenCalled()
        expect(mockRepo.update).toHaveBeenCalledWith(
            { id: 'flow-1', workspaceId: 'ws-1', type: EnumChatflowType.AGENTFLOW },
            expect.not.objectContaining({
                id: expect.anything(),
                workspaceId: expect.anything(),
                type: expect.anything(),
                mcpServerConfig: expect.anything(),
                webhookSecret: expect.anything()
            })
        )
        expect(mockRepo.save).not.toHaveBeenCalled()
        expect(result).toBe(merged)
    })

    it('removes MCP and webhook server state before merge on a generic update', async () => {
        const updates = makeChatflow({
            type: existingFlow.type,
            mcpServerConfig: '{"token":"attacker"}',
            webhookSecret: 'attacker-secret',
            webhookSecretConfigured: true
        })
        mockRepo.merge.mockImplementation((existing: unknown, update: unknown) => ({ ...(existing as object), ...(update as object) }))
        mockRepo.save.mockImplementation(async (value: unknown) => value)

        const result = await chatflowsService.updateChatflow(existingFlow as any, updates as any, 'org-1', 'ws-1', 'sub-1')

        const mergeInput = mockRepo.merge.mock.calls[0][1]
        expect(mergeInput).not.toHaveProperty('mcpServerConfig')
        expect(mergeInput).not.toHaveProperty('webhookSecret')
        expect(mergeInput).not.toHaveProperty('webhookSecretConfigured')
        expect(result).not.toHaveProperty('mcpServerConfig')
    })

    it('validates nested Agent and Retriever stores before update and deduplicates them', async () => {
        const updates = makeChatflow({ flowData: makeAllDocumentStoreReferencesFlowData() })
        const merged = { ...existingFlow, ...updates }
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockResolvedValue(merged)

        await chatflowsService.updateChatflow(existingFlow as any, updates as any, 'org-1', 'ws-1', 'sub-1')

        expect(mockDocumentStoreRepo.findOneBy).toHaveBeenCalledTimes(4)
        expect(mockRepo.merge).toHaveBeenCalledTimes(1)
        expect(mockRepo.update).toHaveBeenCalledTimes(1)
        expect(mockRepo.save).not.toHaveBeenCalled()
    })

    it('validates the existing flow references when an update omits flowData', async () => {
        const current = makeChatflow({ flowData: makeDocumentStoreFlowData('documentStoreVS', STORE_B) })
        const updates = { name: 'Renamed flow' }
        const merged = { ...current, ...updates }
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockResolvedValue(merged)

        await chatflowsService.updateChatflow(current as any, updates as any, 'org-1', 'ws-1', 'sub-1')

        expect(mockDocumentStoreRepo.findOneBy).toHaveBeenCalledWith({ id: STORE_B, workspaceId: 'ws-1' })
        expect(mockRepo.update).toHaveBeenCalledTimes(1)
        expect(mockRepo.save).not.toHaveBeenCalled()
    })

    it('rejects a missing or foreign vector store before merge, save, and usage', async () => {
        mockDocumentStoreRepo.findOneBy.mockResolvedValue(undefined)
        const updates = makeChatflow({ flowData: makeDocumentStoreFlowData('documentStoreVS', STORE_B) })

        await expect(chatflowsService.updateChatflow(existingFlow as any, updates as any, 'org-1', 'ws-1', 'sub-1')).rejects.toMatchObject({
            statusCode: 404,
            message: 'One or more document stores were not found in the workspace'
        })
        expect(mockRepo.merge).not.toHaveBeenCalled()
        expect(mockRepo.update).not.toHaveBeenCalled()
        expect(mockRepo.save).not.toHaveBeenCalled()
        expect(mockUpdateDocumentStoreUsage).not.toHaveBeenCalled()
    })

    it('rejects malformed nested references before merge, save, and usage', async () => {
        const updates = makeChatflow({
            flowData: JSON.stringify({
                nodes: [
                    {
                        id: 'retriever-0',
                        data: {
                            name: 'retrieverAgentflow',
                            inputs: { retrieverKnowledgeDocumentStores: [{ documentStore: { id: STORE_A } }] }
                        }
                    }
                ]
            })
        })

        await expect(chatflowsService.updateChatflow(existingFlow as any, updates as any, 'org-1', 'ws-1', 'sub-1')).rejects.toMatchObject({
            statusCode: 400,
            message: 'Chatflow contains an invalid document store reference'
        })
        expect(mockRepo.merge).not.toHaveBeenCalled()
        expect(mockRepo.update).not.toHaveBeenCalled()
        expect(mockRepo.save).not.toHaveBeenCalled()
        expect(mockUpdateDocumentStoreUsage).not.toHaveBeenCalled()
    })

    it('fails closed before reading stores when update workspaceId is missing', async () => {
        const updates = makeChatflow({ flowData: makeDocumentStoreFlowData('documentStore', STORE_A) })

        await expect(chatflowsService.updateChatflow(existingFlow as any, updates as any, 'org-1', '', 'sub-1')).rejects.toMatchObject({
            statusCode: 400,
            message: 'Workspace ID is required'
        })
        expect(mockDocumentStoreRepo.findOneBy).not.toHaveBeenCalled()
        expect(mockRepo.merge).not.toHaveBeenCalled()
        expect(mockRepo.update).not.toHaveBeenCalled()
        expect(mockRepo.save).not.toHaveBeenCalled()
    })

    it('throws BAD_REQUEST when updateChatFlow.type is invalid', async () => {
        const updates = makeChatflow({ type: 'BAD_TYPE' })

        await expect(chatflowsService.updateChatflow(existingFlow as any, updates as any, 'org-1', 'ws-1', 'sub-1')).rejects.toMatchObject({
            statusCode: 400
        })
    })

    it('fails closed without side effects when workspace or type changes before persistence', async () => {
        mockRepo.update.mockResolvedValue({ affected: 0 })

        await expect(
            chatflowsService.updateChatflow(existingFlow as any, makeChatflow() as any, 'org-1', 'ws-1', 'sub-1')
        ).rejects.toMatchObject({ statusCode: 409 })

        expect(mockUpdateDocumentStoreUsage).not.toHaveBeenCalled()
        expect(mockCreateOrUpdateSchedule).not.toHaveBeenCalled()
        expect(mockRepo.save).not.toHaveBeenCalled()
    })

    it('preserves existing type when updateChatFlow.type is not provided', async () => {
        const updates = { flowData: makeScheduleFlowData() } // no type field
        const merged = { ...existingFlow, flowData: makeScheduleFlowData() }
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockResolvedValue(merged)

        await chatflowsService.updateChatflow(existingFlow as any, updates as any, 'org-1', 'ws-1', 'sub-1')

        // Type should have been copied from existing flow
        expect(updates).toMatchObject({ type: existingFlow.type })
    })

    it('throws BAD_REQUEST when chatbotConfig is invalid JSON', async () => {
        const updates = makeChatflow({ chatbotConfig: 'not-json' })

        await expect(chatflowsService.updateChatflow(existingFlow as any, updates as any, 'org-1', 'ws-1', 'sub-1')).rejects.toMatchObject({
            statusCode: 400
        })
    })

    // ── schedule sync — scheduleInput branch ─────────────────────────────────

    it('creates or updates the schedule when start node is scheduleInput', async () => {
        const updates = makeChatflow({ flowData: makeScheduleFlowData() })
        const merged = { ...existingFlow, flowData: makeScheduleFlowData(), type: EnumChatflowType.AGENTFLOW }
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockResolvedValue(merged)

        await chatflowsService.updateChatflow(existingFlow as any, updates as any, 'org-1', 'ws-1', 'sub-1')

        expect(mockCreateOrUpdateSchedule).toHaveBeenCalledWith(
            expect.objectContaining({ triggerType: ScheduleTriggerType.AGENTFLOW, targetId: 'flow-1', workspaceId: 'ws-1' })
        )
    })

    it('calls onScheduleChanged upsert when the updated schedule is enabled', async () => {
        const merged = makeChatflow({ flowData: makeScheduleFlowData() })
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockResolvedValue(merged)
        mockCreateOrUpdateSchedule.mockResolvedValue({ id: 'sched-1', enabled: true })

        await chatflowsService.updateChatflow(existingFlow as any, makeChatflow() as any, 'org-1', 'ws-1', 'sub-1')

        const beat = ScheduleBeat.getInstance()
        expect(beat.onScheduleChanged).toHaveBeenCalledWith('sched-1', 'upsert')
    })

    it('calls onScheduleChanged delete when the updated schedule is disabled', async () => {
        const merged = makeChatflow({ flowData: makeScheduleFlowData() })
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockResolvedValue(merged)
        mockCreateOrUpdateSchedule.mockResolvedValue({ id: 'sched-1', enabled: false })
        mockCanScheduleEnable.mockReturnValue(false)

        await chatflowsService.updateChatflow(existingFlow as any, makeChatflow() as any, 'org-1', 'ws-1', 'sub-1')

        const beat = ScheduleBeat.getInstance()
        expect(beat.onScheduleChanged).toHaveBeenCalledWith('sched-1', 'delete')
    })

    it('sets enabled=false in createOrUpdateSchedule when canScheduleEnable returns false', async () => {
        const merged = makeChatflow({ flowData: makeScheduleFlowData() })
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockResolvedValue(merged)
        mockCanScheduleEnable.mockReturnValue(false)
        mockCreateOrUpdateSchedule.mockResolvedValue({ id: 'sched-1', enabled: false })

        await chatflowsService.updateChatflow(existingFlow as any, makeChatflow() as any, 'org-1', 'ws-1', 'sub-1')

        expect(mockCreateOrUpdateSchedule).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }))
    })

    it('passes undefined enabled in createOrUpdateSchedule when canScheduleEnable returns true (preserve existing)', async () => {
        const merged = makeChatflow({ flowData: makeScheduleFlowData() })
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockResolvedValue(merged)
        mockCanScheduleEnable.mockReturnValue(true)
        mockCreateOrUpdateSchedule.mockResolvedValue({ id: 'sched-1', enabled: true })

        await chatflowsService.updateChatflow(existingFlow as any, makeChatflow() as any, 'org-1', 'ws-1', 'sub-1')

        expect(mockCreateOrUpdateSchedule).toHaveBeenCalledWith(expect.objectContaining({ enabled: undefined }))
    })

    // ── schedule sync — non-scheduleInput branch ──────────────────────────────

    it('deletes existing schedule when start node switches away from scheduleInput', async () => {
        const merged = makeChatflow({ flowData: makeChatInputFlowData() })
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockResolvedValue(merged)

        await chatflowsService.updateChatflow(
            existingFlow as any,
            makeChatflow({ flowData: makeChatInputFlowData() }) as any,
            'org-1',
            'ws-1',
            'sub-1'
        )

        expect(mockDeleteScheduleForTarget).toHaveBeenCalledWith('flow-1', ScheduleTriggerType.AGENTFLOW, 'ws-1')
    })

    it('calls onScheduleChanged delete after deleting the existing schedule record', async () => {
        const merged = makeChatflow({ flowData: makeChatInputFlowData() })
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockResolvedValue(merged)
        mockDeleteScheduleForTarget.mockResolvedValue({ id: 'sched-old' })

        await chatflowsService.updateChatflow(
            existingFlow as any,
            makeChatflow({ flowData: makeChatInputFlowData() }) as any,
            'org-1',
            'ws-1',
            'sub-1'
        )

        const beat = ScheduleBeat.getInstance()
        expect(beat.onScheduleChanged).toHaveBeenCalledWith('sched-old', 'delete')
    })

    it('does not call onScheduleChanged when no existing schedule was found', async () => {
        const merged = makeChatflow({ flowData: makeChatInputFlowData() })
        mockRepo.merge.mockReturnValue(merged)
        mockRepo.save.mockResolvedValue(merged)
        mockDeleteScheduleForTarget.mockResolvedValue(undefined)

        await chatflowsService.updateChatflow(
            existingFlow as any,
            makeChatflow({ flowData: makeChatInputFlowData() }) as any,
            'org-1',
            'ws-1',
            'sub-1'
        )

        const beat = ScheduleBeat.getInstance()
        expect(beat.onScheduleChanged).not.toHaveBeenCalled()
    })

    it('does not touch schedules for a non-AGENTFLOW type', async () => {
        const existingNonAgentFlow = makeChatflow({ type: EnumChatflowType.CHATFLOW, flowData: makePlainFlowData() })
        const nonAgentFlow = makeChatflow({ type: EnumChatflowType.CHATFLOW, flowData: makePlainFlowData() })
        mockRepo.merge.mockReturnValue(nonAgentFlow)
        mockRepo.save.mockResolvedValue(nonAgentFlow)

        await chatflowsService.updateChatflow(existingNonAgentFlow as any, nonAgentFlow as any, 'org-1', 'ws-1', 'sub-1')

        expect(mockCreateOrUpdateSchedule).not.toHaveBeenCalled()
        expect(mockDeleteScheduleForTarget).not.toHaveBeenCalled()
    })

    it('rejects a generic cross-type transition before merge or save', async () => {
        const updates = makeChatflow({ type: EnumChatflowType.CHATFLOW, flowData: makePlainFlowData() })

        await expect(chatflowsService.updateChatflow(existingFlow as any, updates as any, 'org-1', 'ws-1', 'sub-1')).rejects.toMatchObject({
            statusCode: 403
        })
        expect(mockRepo.merge).not.toHaveBeenCalled()
        expect(mockRepo.save).not.toHaveBeenCalled()
    })
})
