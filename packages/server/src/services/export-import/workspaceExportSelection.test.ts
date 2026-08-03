const mockGetAllChatflows = jest.fn()
const mockGetMessagesByChatflowIds = jest.fn()
const mockGetMessagesFeedbackByChatflowIds = jest.fn()
const mockGetMessagesByReferencesForExport = jest.fn()
const mockGetExecutionsByIdsForExport = jest.fn()
const mockBuildWorkspaceExportClosure = jest.fn()
const mockCreateWorkspaceExportArtifact = jest.fn()

jest.mock('../assistants', () => ({ __esModule: true, default: { getAllAssistants: jest.fn() } }))
jest.mock('../chatflows', () => ({
    __esModule: true,
    default: { getAllChatflows: (...args: unknown[]) => mockGetAllChatflows(...args) },
    extractDocumentStoreIds: jest.fn(() => [])
}))
jest.mock('../chat-messages', () => ({
    __esModule: true,
    default: {
        getMessagesByChatflowIds: (...args: unknown[]) => mockGetMessagesByChatflowIds(...args),
        getMessagesFeedbackByChatflowIds: (...args: unknown[]) => mockGetMessagesFeedbackByChatflowIds(...args),
        getMessagesByReferencesForExport: (...args: unknown[]) => mockGetMessagesByReferencesForExport(...args)
    }
}))
jest.mock('../documentstore', () => ({
    __esModule: true,
    default: { getAllDocumentStores: jest.fn().mockResolvedValue([]), getAllDocumentFileChunksByDocumentStoreIds: jest.fn() }
}))
jest.mock('../executions', () => ({
    __esModule: true,
    default: {
        getAllExecutions: jest.fn(),
        getExecutionsByIdsForExport: (...args: unknown[]) => mockGetExecutionsByIdsForExport(...args)
    }
}))
jest.mock('../marketplaces', () => ({ __esModule: true, default: { getAllCustomTemplates: jest.fn() } }))
jest.mock('../tools', () => ({ __esModule: true, default: { getAllTools: jest.fn().mockResolvedValue([]) } }))
jest.mock('../variables', () => ({ __esModule: true, default: { getAllVariables: jest.fn().mockResolvedValue([]) } }))
jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        nodesPool: { componentNodes: {} },
        identityManager: { getPlatformType: () => 'OPEN_SOURCE' }
    })
}))
jest.mock('flowise-components', () => ({
    getStoragePath: jest.fn(),
    parseJsonBody: jest.fn(),
    resolveFlowiseRequestTarget: () => ({ canonicalOrigin: 'https://flowise.example.invalid' }),
    normalizeFlowiseBaseUrl: (value: string) => value
}))
jest.mock('./workspaceExportClosure', () => ({
    buildWorkspaceExportClosure: (...args: unknown[]) => mockBuildWorkspaceExportClosure(...args)
}))
jest.mock('./workspaceExportPortability', () => ({
    createWorkspaceExportArtifact: (...args: unknown[]) => mockCreateWorkspaceExportArtifact(...args)
}))
jest.mock('../../utils/quotaUsage', () => ({ checkUsageLimit: jest.fn() }))
jest.mock('../../utils/getChatMessage', () => ({ utilGetChatMessage: jest.fn() }))
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { error: jest.fn() } }))

import exportImportService from '.'
import type { WorkspaceImportData } from './workspaceImportSecurity'

const FLOW_ID = '11111111-1111-4111-8111-111111111111'
const MESSAGE_ID = '22222222-2222-4222-8222-222222222222'
const FEEDBACK_ID = '33333333-3333-4333-8333-333333333333'

const emptyData = (): WorkspaceImportData => ({
    AgentFlow: [],
    AgentFlowV2: [],
    AssistantCustom: [],
    AssistantFlow: [],
    AssistantOpenAI: [],
    AssistantAzure: [],
    ChatFlow: [],
    ChatMessage: [],
    ChatMessageFeedback: [],
    CustomTemplate: [],
    DocumentStore: [],
    DocumentStoreFileChunk: [],
    Execution: [],
    Tool: [],
    Variable: []
})

describe('workspace export relation selection', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockGetAllChatflows.mockResolvedValue([{ id: FLOW_ID, type: 'CHATFLOW', flowData: '{"nodes":[],"edges":[]}' }])
        mockGetMessagesFeedbackByChatflowIds.mockResolvedValue([
            { id: FEEDBACK_ID, messageId: MESSAGE_ID, chatflowid: FLOW_ID, chatId: 'chat-1' }
        ])
        mockGetMessagesByReferencesForExport.mockResolvedValue([
            { id: MESSAGE_ID, chatflowid: FLOW_ID, chatId: 'chat-1', content: 'selected parent' }
        ])
        mockGetExecutionsByIdsForExport.mockResolvedValue([])
        mockBuildWorkspaceExportClosure.mockImplementation(() => ({ data: emptyData(), manifest: { formatVersion: 1 } }))
        mockCreateWorkspaceExportArtifact.mockResolvedValue({ ...emptyData(), ExportManifest: { formatVersion: 1 } })
    })

    it('exports one feedback and its exact parent even when an all-message scan would exceed the cap', async () => {
        mockGetMessagesByChatflowIds.mockRejectedValue(new Error('more than 10,000 unrelated messages'))

        await expect(
            exportImportService.exportData(
                {
                    agentflow: false,
                    agentflowv2: false,
                    assistantCustom: false,
                    assistantOpenAI: false,
                    assistantAzure: false,
                    chatflow: false,
                    chat_message: false,
                    chat_feedback: true,
                    custom_template: false,
                    document_store: false,
                    execution: false,
                    tool: false,
                    variable: false
                },
                'workspace-1'
            )
        ).resolves.toMatchObject({ FileDefaultName: 'ExportData.json' })

        expect(mockGetMessagesByChatflowIds).not.toHaveBeenCalled()
        expect(mockGetMessagesByReferencesForExport).toHaveBeenCalledWith([{ messageId: MESSAGE_ID, chatflowId: FLOW_ID }])
        expect(mockGetExecutionsByIdsForExport).toHaveBeenCalledWith([], 'workspace-1')
        const inventories = mockBuildWorkspaceExportClosure.mock.calls.map(([, inventory]) => inventory)
        expect(inventories).toHaveLength(2)
        for (const inventory of inventories) {
            expect(inventory.messages).toEqual([
                expect.objectContaining({ id: MESSAGE_ID, chatflowid: FLOW_ID, content: 'selected parent' })
            ])
            expect(inventory.feedbacks).toEqual([expect.objectContaining({ id: FEEDBACK_ID, messageId: MESSAGE_ID })])
        }
    })
})
