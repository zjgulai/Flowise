import { StatusCodes } from 'http-status-codes'
import { ChatFlow, EnumChatflowType } from '../../database/entities/ChatFlow'
import { Platform } from '../../Interface'
import { assertWorkspaceExportPortable, createWorkspaceExportArtifact, type WorkspaceExportManifest } from './workspaceExportPortability'
import type { WorkspaceImportData } from './workspaceImportSecurity'

const FLOW_ID = '11111111-1111-4111-8111-111111111111'
const EXECUTION_ID = '22222222-2222-4222-8222-222222222222'
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333'
const FEEDBACK_ID = '44444444-4444-4444-8444-444444444444'
const STORE_ID = '55555555-5555-4555-8555-555555555555'
const LOADER_ID = 'loader-1'

const emptyPayload = (): WorkspaceImportData => ({
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

const portableFailure = expect.objectContaining({
    statusCode: StatusCodes.UNPROCESSABLE_ENTITY,
    message: '工作区包含无法安全恢复的数据，导出已中止；请先修复超限或非规范记录'
})

const manifest: WorkspaceExportManifest = {
    formatVersion: 1,
    dependencyMode: 'record-closure',
    selectedCategories: ['chatflow'],
    includedDependencies: { flows: 1, tools: 0, documentStores: 0, variables: 0 },
    rebindRequired: [
        'credentials',
        'variable-values',
        'mcp-connections',
        'api-key-and-rate-limit-policy',
        'provider-and-http-options',
        'local-file-and-directory-paths'
    ],
    reviewRequired: ['preserved-provider-and-http-targets'],
    restoreScope: 'structure-and-selected-user-content',
    contentWarning: 'contains-user-data-and-custom-code-review-before-sharing'
}
const componentNodes = {
    fixtureNode: {
        name: 'fixtureNode',
        inputs: [{ name: 'apiPassword', type: 'password' }]
    }
} as never

const addDocumentStore = (payload: WorkspaceImportData, metadata: unknown = '{}', pageContent = 'fixture') => {
    payload.DocumentStore = [
        {
            id: STORE_ID,
            name: 'Synthetic store',
            description: null,
            loaders: JSON.stringify([{ id: LOADER_ID, loaderId: 'syntheticLoader', loaderConfig: {} }]),
            whereUsed: '[]',
            workspaceId: 'source-workspace'
        } as never
    ]
    payload.DocumentStoreFileChunk = [
        {
            id: 'chunk-1',
            docId: LOADER_ID,
            storeId: STORE_ID,
            chunkNo: 1,
            pageContent,
            metadata
        } as never
    ]
}

describe('workspace export fresh-target portability', () => {
    it('accepts an export-normalize-empty-target parent chain', async () => {
        const payload = emptyPayload()
        payload.ChatFlow = [
            {
                id: FLOW_ID,
                name: 'Synthetic flow',
                type: EnumChatflowType.CHATFLOW,
                flowData: JSON.stringify({ nodes: [], edges: [] }),
                createdDate: new Date('2026-08-02T00:00:00.000Z'),
                updatedDate: new Date('2026-08-02T00:00:00.000Z')
            } as ChatFlow
        ]
        payload.Execution = [{ id: EXECUTION_ID, agentflowId: FLOW_ID, state: 'FINISHED', executionData: '{}' } as never]
        payload.ChatMessage = [
            {
                id: MESSAGE_ID,
                role: 'userMessage',
                chatflowid: FLOW_ID,
                executionId: EXECUTION_ID,
                chatId: 'chat-1',
                content: 'fixture'
            } as never
        ]
        payload.ChatMessageFeedback = [
            { id: FEEDBACK_ID, chatflowid: FLOW_ID, messageId: MESSAGE_ID, chatId: 'chat-1', content: 'fixture' } as never
        ]

        await expect(assertWorkspaceExportPortable(payload, Platform.OPEN_SOURCE)).resolves.toBeUndefined()
    })

    it('returns the exact sanitized public artifact while preserving restorable flow configuration', async () => {
        const payload = emptyPayload()
        payload.ChatFlow = [
            {
                id: FLOW_ID,
                name: 'Synthetic flow',
                type: EnumChatflowType.CHATFLOW,
                flowData: JSON.stringify({
                    nodes: [
                        {
                            data: {
                                name: 'fixtureNode',
                                inputParams: [{ name: 'apiPassword', type: 'password' }],
                                inputs: {
                                    apiPassword: 'literal-secret-sentinel',
                                    requestsGetHeaders: [{ key: 'Authorization', value: 'literal-secret-sentinel' }],
                                    prompt: 'keep-me'
                                },
                                credential: '99999999-9999-4999-8999-999999999999'
                            }
                        }
                    ],
                    edges: []
                }),
                chatbotConfig: JSON.stringify({ theme: 'light' }),
                analytic: JSON.stringify({ enabled: true }),
                speechToText: JSON.stringify({ enabled: true }),
                textToSpeech: JSON.stringify({ enabled: true }),
                followUpPrompts: JSON.stringify({ enabled: true }),
                category: 'Training',
                workspaceId: 'source-workspace',
                deployed: true,
                isPublic: true,
                createdDate: new Date('2026-08-02T00:00:00.000Z'),
                updatedDate: new Date('2026-08-02T00:00:00.000Z')
            } as ChatFlow
        ]

        const artifact = await createWorkspaceExportArtifact(payload, manifest, componentNodes, 'https://flowise.example.invalid')
        expect(artifact.ChatFlow).toHaveLength(1)
        expect(artifact.ChatFlow[0]).toMatchObject({
            name: 'Synthetic flow',
            chatbotConfig: JSON.stringify({ theme: 'light' }),
            analytic: JSON.stringify({ enabled: true }),
            speechToText: JSON.stringify({ enabled: true }),
            textToSpeech: JSON.stringify({ enabled: true }),
            followUpPrompts: JSON.stringify({ enabled: true }),
            category: 'Training'
        })
        expect(artifact.ChatFlow[0].id).not.toBe(FLOW_ID)
        expect(artifact.ChatFlow[0]).not.toHaveProperty('workspaceId')
        expect(artifact.ChatFlow[0]).not.toHaveProperty('deployed')
        expect(artifact.ChatFlow[0]).not.toHaveProperty('isPublic')
        expect(JSON.stringify(artifact)).not.toContain('literal-secret-sentinel')
        expect(JSON.parse(artifact.ChatFlow[0].flowData).nodes[0].data.inputs).toEqual({ prompt: 'keep-me' })
        expect(artifact.ExportManifest).toEqual(manifest)
    })

    it('accepts a canonical document store and chunk', async () => {
        const payload = emptyPayload()
        addDocumentStore(payload)
        await expect(assertWorkspaceExportPortable(payload)).resolves.toBeUndefined()
    })

    it.each([
        ['nullable chunk metadata', null, 'fixture'],
        ['a chunk above 65,535 bytes', '{}', 'x'.repeat(65_536)]
    ])('rejects %s instead of issuing a false-success backup', async (_name, metadata, pageContent) => {
        const payload = emptyPayload()
        addDocumentStore(payload, metadata, pageContent)
        await expect(assertWorkspaceExportPortable(payload)).rejects.toMatchObject(portableFailure)
    })

    it('rejects more than 10,000 exported rows in one collection', async () => {
        const payload = emptyPayload()
        payload.DocumentStoreFileChunk = Array.from({ length: 10_001 }, (_, index) => ({ id: `chunk-${index}` })) as never
        await expect(assertWorkspaceExportPortable(payload)).rejects.toMatchObject(portableFailure)
    })

    it('rejects an export above the bounded JSON budget', async () => {
        const payload = emptyPayload()
        payload.Tool = [
            {
                id: '66666666-6666-4666-8666-666666666666',
                name: 'Oversized tool',
                func: 'x'.repeat(5 * 1024 * 1024 + 1)
            } as never
        ]
        await expect(assertWorkspaceExportPortable(payload)).rejects.toMatchObject(portableFailure)
    })
})
