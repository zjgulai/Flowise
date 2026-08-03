import { StatusCodes } from 'http-status-codes'
import { ChatFlow, EnumChatflowType } from '../../database/entities/ChatFlow'
import { ChatMessage } from '../../database/entities/ChatMessage'
import { ChatMessageFeedback } from '../../database/entities/ChatMessageFeedback'
import { Execution } from '../../database/entities/Execution'
import { Tool } from '../../database/entities/Tool'
import { Platform } from '../../Interface'
import {
    insertWorkspaceImportBatch,
    normalizeWorkspaceImportForCreate,
    preflightWorkspaceImportRelations,
    sanitizeWorkspaceImportForRebinding,
    type WorkspaceImportData
} from './workspaceImportSecurity'

const WORKSPACE_ID = 'workspace-1'
const ASSISTANT_FLOW_ID = '11111111-1111-4111-8111-111111111111'
const CHATFLOW_ID = '22222222-2222-4222-8222-222222222222'
const ASSISTANT_ID = '33333333-3333-4333-8333-333333333333'
const TOOL_ID = '44444444-4444-4444-8444-444444444444'
const EXECUTION_ID = '55555555-5555-4555-8555-555555555555'
const MESSAGE_ID = '66666666-6666-4666-8666-666666666666'
const FEEDBACK_ID = '77777777-7777-4777-8777-777777777777'
const VARIABLE_ID = '88888888-8888-4888-8888-888888888888'
const FOREIGN_ID = '99999999-9999-4999-8999-999999999999'
const SECRET = 'import-secret-sentinel'
const CANONICAL_ORIGIN = 'https://flowise.example.invalid'

const componentNodes = {
    customMCP: {
        name: 'customMCP',
        inputs: [
            { name: 'credential', type: 'credential' },
            { name: 'passwordValue', type: 'password' },
            { name: 'mcpServerConfig', type: 'json' },
            { name: 'safePrompt', type: 'string' }
        ]
    },
    agentAgentflow: { name: 'agentAgentflow', inputs: [{ name: 'agentTools', type: 'array' }] },
    syntheticLoader: {
        name: 'syntheticLoader',
        category: 'Document Loaders',
        baseClasses: ['Document'],
        filePath: '/synthetic/loader.ts',
        inputs: [
            { name: 'credential', type: 'credential' },
            { name: 'passwordValue', type: 'password' },
            { name: 'safeLoaderOption', type: 'string' }
        ]
    }
} as never

const emptyPayload = (): Record<keyof WorkspaceImportData, unknown[]> => ({
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

const makeFlow = (id: string, type: EnumChatflowType, flowData: string = '{\n  "nodes": []\n}') =>
    ({ id, name: `${type} flow`, type, flowData } as ChatFlow)

const makeManager = (rows: Partial<Record<string, unknown[]>> = {}) => {
    const find = jest.fn(async (entity: unknown, _options?: unknown) => {
        if (entity === ChatFlow) return rows.ChatFlow ?? []
        if (entity === Execution) return rows.Execution ?? []
        if (entity === ChatMessage) return rows.ChatMessage ?? []
        if (entity === ChatMessageFeedback) return rows.ChatMessageFeedback ?? []
        if (entity === Tool) return rows.Tool ?? []
        return []
    })
    return { connection: { options: { type: 'sqlite' } }, find }
}

describe('workspace import create-only security', () => {
    it('scrubs credential bindings from legacy/API imports before ID remapping or persistence', () => {
        const payload = emptyPayload()
        payload.ChatFlow = [
            makeFlow(
                CHATFLOW_ID,
                EnumChatflowType.CHATFLOW,
                JSON.stringify({
                    nodes: [
                        {
                            data: {
                                name: 'customMCP',
                                credential: FOREIGN_ID,
                                inputs: {
                                    credential: FOREIGN_ID,
                                    FLOWISE_CREDENTIAL_ID: FOREIGN_ID,
                                    passwordValue: SECRET,
                                    mcpServerConfig: JSON.stringify({ env: { TOKEN: SECRET } }),
                                    safePrompt: 'keep-flow'
                                }
                            }
                        },
                        {
                            data: {
                                name: 'agentAgentflow',
                                inputs: {
                                    agentTools: [
                                        {
                                            agentSelectedTool: 'customMCP',
                                            agentSelectedToolConfig: {
                                                credential: FOREIGN_ID,
                                                mcpServerConfig: JSON.stringify({ headers: { Authorization: SECRET } }),
                                                safePrompt: 'keep-wrapper'
                                            }
                                        }
                                    ]
                                }
                            }
                        }
                    ],
                    edges: []
                })
            )
        ]
        payload.AssistantCustom = [
            {
                id: ASSISTANT_ID,
                type: 'CUSTOM',
                credential: FOREIGN_ID,
                details: JSON.stringify({
                    documentStores: [],
                    chatModel: {
                        name: 'customMCP',
                        credential: FOREIGN_ID,
                        inputs: { passwordValue: SECRET, safePrompt: 'keep-assistant' }
                    },
                    tools: [
                        {
                            name: 'customMCP',
                            inputs: { credential: FOREIGN_ID, mcpServerConfig: JSON.stringify({ token: SECRET }), safePrompt: 'keep-tool' }
                        }
                    ]
                })
            }
        ]
        payload.DocumentStore = [
            {
                id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
                name: 'Imported store',
                loaders: JSON.stringify([
                    {
                        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
                        loaderId: 'syntheticLoader',
                        credential: FOREIGN_ID,
                        loaderConfig: { credential: FOREIGN_ID, passwordValue: SECRET, safeLoaderOption: 'keep-loader' }
                    }
                ])
            }
        ]
        payload.Variable = [{ id: VARIABLE_ID, name: 'provider-token', value: SECRET, type: 'string' }]

        const scrubbed = sanitizeWorkspaceImportForRebinding(payload, componentNodes, CANONICAL_ORIGIN)
        const serialized = JSON.stringify(scrubbed)
        expect(serialized).not.toContain(SECRET)
        expect(serialized).not.toContain(FOREIGN_ID)
        expect(scrubbed.Variable[0].value).toBe('')
        expect(JSON.parse(scrubbed.ChatFlow[0].flowData).nodes[0].data.inputs).toEqual({ safePrompt: 'keep-flow' })
        expect(JSON.parse(scrubbed.ChatFlow[0].flowData).nodes[1].data.inputs.agentTools[0].agentSelectedToolConfig).toEqual({
            safePrompt: 'keep-wrapper'
        })
        expect(JSON.parse(scrubbed.AssistantCustom[0].details).chatModel.inputs).toEqual({ safePrompt: 'keep-assistant' })
        expect(JSON.parse(scrubbed.DocumentStore[0].loaders)[0].loaderConfig).toEqual({ safeLoaderOption: 'keep-loader' })

        const normalized = normalizeWorkspaceImportForCreate(scrubbed, WORKSPACE_ID)
        expect(normalized.Variable[0].value).toBe('')
        expect(JSON.stringify(normalized)).not.toContain(SECRET)
    })

    it('regenerates IDs, remaps only typed references, strips relations/server state, and preserves user bytes', () => {
        const payload = emptyPayload()
        const userBytes = `keep:${FOREIGN_ID}:  line two`
        payload.Tool = [
            {
                id: TOOL_ID,
                name: 'Synthetic tool',
                description: userBytes,
                color: '#123456',
                schema: userBytes,
                func: userBytes,
                workspaceId: 'foreign',
                attackerManaged: true
            }
        ]
        payload.AssistantFlow = [
            {
                ...makeFlow(
                    ASSISTANT_FLOW_ID,
                    EnumChatflowType.ASSISTANT,
                    JSON.stringify({
                        nodes: [{ data: { name: 'customTool', inputs: { selectedTool: TOOL_ID, prompt: userBytes } } }],
                        arbitrary: userBytes
                    })
                ),
                deployed: true,
                isPublic: true,
                apikeyid: FOREIGN_ID,
                apiConfig: userBytes,
                mcpServerConfig: JSON.stringify({ token: 'secret' }),
                webhookSecret: 'secret',
                webhookSecretConfigured: true,
                attackerManaged: true
            }
        ]
        payload.ChatFlow = [makeFlow(CHATFLOW_ID, EnumChatflowType.CHATFLOW)]
        payload.AssistantCustom = [
            {
                id: ASSISTANT_ID,
                type: 'CUSTOM',
                credential: FOREIGN_ID,
                details: JSON.stringify({
                    flowId: ASSISTANT_FLOW_ID,
                    documentStores: [],
                    instruction: userBytes,
                    tools: [
                        { name: 'customTool', inputs: { selectedTool: TOOL_ID } },
                        { name: 'ChatflowTool', inputs: { selectedChatflow: CHATFLOW_ID, baseURL: '' } }
                    ]
                }),
                workspaceId: 'foreign',
                attackerManaged: true
            }
        ]
        payload.Execution = [
            {
                id: EXECUTION_ID,
                executionData: userBytes,
                state: 'FINISHED',
                agentflowId: ASSISTANT_FLOW_ID,
                sessionId: 'session-1',
                isPublic: true,
                workspaceId: 'foreign',
                agentflow: { id: FOREIGN_ID, mcpServerConfig: 'secret' },
                attackerManaged: true
            }
        ]
        payload.ChatMessage = [
            {
                id: MESSAGE_ID,
                role: 'userMessage',
                chatflowid: ASSISTANT_FLOW_ID,
                executionId: EXECUTION_ID,
                execution: { id: FOREIGN_ID, executionData: 'secret' },
                content: userBytes,
                chatType: 'INTERNAL',
                chatId: 'chat-1',
                attackerManaged: true
            }
        ]
        payload.ChatMessageFeedback = [
            {
                id: FEEDBACK_ID,
                chatflowid: ASSISTANT_FLOW_ID,
                chatId: 'chat-1',
                messageId: MESSAGE_ID,
                content: userBytes,
                attackerManaged: true
            }
        ]
        payload.Variable = [
            { id: VARIABLE_ID, name: 'fixture', value: userBytes, type: 'string', workspaceId: 'foreign', attackerManaged: true }
        ]

        const data = normalizeWorkspaceImportForCreate(payload, WORKSPACE_ID)
        const flow = data.AssistantFlow[0] as unknown as Record<string, unknown>
        const assistant = data.AssistantCustom[0] as unknown as Record<string, unknown>
        const execution = data.Execution[0] as unknown as Record<string, unknown>
        const message = data.ChatMessage[0] as unknown as Record<string, unknown>

        expect(flow.id).not.toBe(ASSISTANT_FLOW_ID)
        expect(flow).toMatchObject({ deployed: false, isPublic: false, webhookSecretConfigured: false, workspaceId: WORKSPACE_ID })
        expect(flow).not.toHaveProperty('apikeyid')
        expect(flow).not.toHaveProperty('apiConfig')
        expect(flow).not.toHaveProperty('mcpServerConfig')
        expect(flow).not.toHaveProperty('webhookSecret')
        expect(flow).not.toHaveProperty('attackerManaged')
        const remappedFlowData = JSON.parse(flow.flowData as string)
        expect(remappedFlowData.nodes[0].data.inputs.selectedTool).toBe(data.Tool[0].id)
        expect(remappedFlowData.nodes[0].data.inputs.prompt).toBe(userBytes)
        expect(remappedFlowData.arbitrary).toBe(userBytes)

        const assistantDetails = JSON.parse(assistant.details as string)
        expect(assistantDetails).toMatchObject({ flowId: flow.id, instruction: userBytes })
        expect(assistantDetails.tools[0].inputs.selectedTool).toBe(data.Tool[0].id)
        expect(assistantDetails.tools[1].inputs.selectedChatflow).toBe(data.ChatFlow[0].id)
        expect(assistant.credential).not.toBe(FOREIGN_ID)
        expect(assistant).not.toHaveProperty('attackerManaged')

        expect(execution).toMatchObject({ agentflowId: flow.id, executionData: userBytes, isPublic: false, workspaceId: WORKSPACE_ID })
        expect(execution).not.toHaveProperty('agentflow')
        expect(execution).not.toHaveProperty('attackerManaged')
        expect(message).toMatchObject({ chatflowid: flow.id, executionId: execution.id, content: userBytes })
        expect(message).not.toHaveProperty('execution')
        expect(message).not.toHaveProperty('attackerManaged')
        expect(data.ChatMessageFeedback[0]).toMatchObject({ chatflowid: flow.id, messageId: message.id, content: userBytes })
        expect(data.Variable[0]).toMatchObject({ value: userBytes, workspaceId: WORKSPACE_ID })
        expect(data.Tool[0]).toMatchObject({ description: userBytes, schema: userBytes, func: userBytes, workspaceId: WORKSPACE_ID })
        expect(payload.Execution[0]).toHaveProperty('agentflow')
        expect(payload.ChatMessage[0]).toHaveProperty('execution')
    })

    it('keeps an untouched formatted flow byte-for-byte when no typed reference changes', () => {
        const payload = emptyPayload()
        const flowData = '{\n  "nodes": [],\n  "prompt": "keep formatting"\n}'
        payload.ChatFlow = [makeFlow(CHATFLOW_ID, EnumChatflowType.CHATFLOW, flowData)]

        const data = normalizeWorkspaceImportForCreate(payload, WORKSPACE_ID)

        expect(data.ChatFlow[0].flowData).toBe(flowData)
    })

    it.each([
        ['AgentFlow', EnumChatflowType.CHATFLOW],
        ['AgentFlowV2', EnumChatflowType.MULTIAGENT],
        ['AssistantFlow', EnumChatflowType.CHATFLOW],
        ['ChatFlow', EnumChatflowType.AGENTFLOW]
    ])('rejects a discriminator mismatch in %s before persistence', (collection, type) => {
        const payload = emptyPayload()
        payload[collection as keyof WorkspaceImportData] = [makeFlow(CHATFLOW_ID, type)]
        expect(() => normalizeWorkspaceImportForCreate(payload, WORKSPACE_ID)).toThrow(
            expect.objectContaining({ statusCode: StatusCodes.BAD_REQUEST, message: 'Invalid workspace import' })
        )
    })

    it.each(['AssistantOpenAI', 'AssistantAzure'])('rejects disabled legacy %s imports', (collection) => {
        const payload = emptyPayload()
        payload[collection as keyof WorkspaceImportData] = [
            { id: ASSISTANT_ID, type: collection === 'AssistantOpenAI' ? 'OPENAI' : 'AZURE' }
        ]
        expect(() => normalizeWorkspaceImportForCreate(payload, WORKSPACE_ID)).toThrow(
            expect.objectContaining({ statusCode: StatusCodes.GONE })
        )
    })

    it('enforces whole-import depth, node, byte, collection, and forbidden-key budgets before remapping', () => {
        let tooDeep: unknown = 'leaf'
        for (let index = 0; index < 33; index += 1) tooDeep = [tooDeep]
        expect(() => normalizeWorkspaceImportForCreate({ ...emptyPayload(), extra: tooDeep }, WORKSPACE_ID)).toThrow(
            expect.objectContaining({ statusCode: StatusCodes.BAD_REQUEST, message: 'Invalid workspace import' })
        )
        expect(() =>
            normalizeWorkspaceImportForCreate(
                { ...emptyPayload(), extra: Array.from({ length: 50_001 }, (_, index) => index) },
                WORKSPACE_ID
            )
        ).toThrow(expect.objectContaining({ statusCode: StatusCodes.BAD_REQUEST }))
        expect(() =>
            normalizeWorkspaceImportForCreate({ ...emptyPayload(), extra: 'x'.repeat(5 * 1024 * 1024 + 1) }, WORKSPACE_ID)
        ).toThrow(expect.objectContaining({ statusCode: StatusCodes.BAD_REQUEST }))
        expect(() =>
            normalizeWorkspaceImportForCreate({ ...emptyPayload(), Tool: Array.from({ length: 10_001 }, () => ({})) }, WORKSPACE_ID)
        ).toThrow(expect.objectContaining({ statusCode: StatusCodes.BAD_REQUEST }))
        expect(() =>
            normalizeWorkspaceImportForCreate({ ...emptyPayload(), ...JSON.parse('{"__proto__":{"polluted":true}}') }, WORKSPACE_ID)
        ).toThrow(expect.objectContaining({ statusCode: StatusCodes.BAD_REQUEST }))
        const embeddedPrototype = emptyPayload()
        embeddedPrototype.ChatFlow = [makeFlow(CHATFLOW_ID, EnumChatflowType.CHATFLOW, '{"nodes":[],"__proto__":{"polluted":true}}')]
        expect(() => normalizeWorkspaceImportForCreate(embeddedPrototype, WORKSPACE_ID)).toThrow(
            expect.objectContaining({ statusCode: StatusCodes.BAD_REQUEST })
        )

        expect(normalizeWorkspaceImportForCreate({ ...emptyPayload(), extra: 'x'.repeat(4 * 1024 * 1024) }, WORKSPACE_ID)).toMatchObject({
            ChatFlow: [],
            Tool: []
        })
    })

    it('rejects cloud runtime variables and supports legacy Tool templates without mass assigning legacy fields', () => {
        const cloud = emptyPayload()
        cloud.Variable = [{ id: VARIABLE_ID, name: 'runtime', value: 'x', type: 'runtime' }]
        expect(() => normalizeWorkspaceImportForCreate(cloud, WORKSPACE_ID, Platform.CLOUD)).toThrow(
            expect.objectContaining({ statusCode: StatusCodes.BAD_REQUEST })
        )

        const payload = emptyPayload()
        payload.CustomTemplate = [
            { id: CHATFLOW_ID, name: 'Legacy tool', type: 'Tool', iconSrc: 'icon.svg', schema: '{"type":"object"}', func: 'return 1' }
        ]
        const [template] = normalizeWorkspaceImportForCreate(payload, WORKSPACE_ID).CustomTemplate
        expect(JSON.parse(template.flowData)).toEqual({ iconSrc: 'icon.svg', schema: '{"type":"object"}', func: 'return 1' })
        expect(template).not.toHaveProperty('iconSrc')
        expect(template).not.toHaveProperty('schema')
        expect(template).not.toHaveProperty('func')
    })

    it('requires every custom assistant flow to be imported in AssistantFlow and referenced one-to-one', () => {
        const external = emptyPayload()
        external.AssistantCustom = [
            { id: ASSISTANT_ID, type: 'CUSTOM', details: JSON.stringify({ flowId: ASSISTANT_FLOW_ID, documentStores: [] }) }
        ]
        expect(() => normalizeWorkspaceImportForCreate(external, WORKSPACE_ID)).toThrow(
            expect.objectContaining({ statusCode: StatusCodes.BAD_REQUEST })
        )

        const duplicate = emptyPayload()
        duplicate.AssistantFlow = [makeFlow(ASSISTANT_FLOW_ID, EnumChatflowType.ASSISTANT)]
        duplicate.AssistantCustom = [ASSISTANT_ID, FOREIGN_ID].map((id) => ({
            id,
            type: 'CUSTOM',
            details: JSON.stringify({ flowId: ASSISTANT_FLOW_ID, documentStores: [] })
        }))
        expect(() => normalizeWorkspaceImportForCreate(duplicate, WORKSPACE_ID)).toThrow(
            expect.objectContaining({ statusCode: StatusCodes.BAD_REQUEST })
        )
    })

    it('accepts a fully imported parent chain and rejects message/execution tuple mismatches', async () => {
        const valid = emptyPayload()
        valid.ChatFlow = [makeFlow(CHATFLOW_ID, EnumChatflowType.CHATFLOW)]
        valid.Execution = [{ id: EXECUTION_ID, executionData: '{}', state: 'FINISHED', agentflowId: CHATFLOW_ID, sessionId: 'session-1' }]
        valid.ChatMessage = [
            {
                id: MESSAGE_ID,
                role: 'userMessage',
                chatflowid: CHATFLOW_ID,
                executionId: EXECUTION_ID,
                content: 'fixture',
                chatType: 'INTERNAL',
                chatId: 'chat-1'
            }
        ]
        valid.ChatMessageFeedback = [
            { id: FEEDBACK_ID, chatflowid: CHATFLOW_ID, chatId: 'chat-1', messageId: MESSAGE_ID, content: 'fixture' }
        ]
        const normalized = normalizeWorkspaceImportForCreate(valid, WORKSPACE_ID)
        const manager = makeManager()
        await expect(preflightWorkspaceImportRelations(manager as never, normalized, WORKSPACE_ID)).resolves.toBeUndefined()

        const secondFlow = makeFlow(FOREIGN_ID, EnumChatflowType.CHATFLOW)
        const mismatch = normalizeWorkspaceImportForCreate(
            { ...valid, ChatFlow: [makeFlow(CHATFLOW_ID, EnumChatflowType.CHATFLOW), secondFlow] },
            WORKSPACE_ID
        )
        mismatch.ChatMessage[0].chatflowid = mismatch.ChatFlow[1].id
        await expect(preflightWorkspaceImportRelations(makeManager() as never, mismatch, WORKSPACE_ID)).rejects.toMatchObject({
            statusCode: StatusCodes.BAD_REQUEST
        })
    })

    it('rejects foreign flow and custom-tool parents without writing', async () => {
        const foreignFlow = normalizeWorkspaceImportForCreate(emptyPayload(), WORKSPACE_ID)
        foreignFlow.Execution = [
            { id: EXECUTION_ID, executionData: '{}', state: 'FINISHED', agentflowId: FOREIGN_ID, sessionId: 'session-1' } as Execution
        ]
        const manager = makeManager()
        await expect(preflightWorkspaceImportRelations(manager as never, foreignFlow, WORKSPACE_ID)).rejects.toMatchObject({
            statusCode: StatusCodes.BAD_REQUEST
        })

        const foreignToolPayload = emptyPayload()
        foreignToolPayload.ChatFlow = [
            makeFlow(
                CHATFLOW_ID,
                EnumChatflowType.CHATFLOW,
                JSON.stringify({ nodes: [{ data: { name: 'customTool', inputs: { selectedTool: FOREIGN_ID } } }] })
            )
        ]
        const foreignTool = normalizeWorkspaceImportForCreate(foreignToolPayload, WORKSPACE_ID)
        await expect(preflightWorkspaceImportRelations(makeManager() as never, foreignTool, WORKSPACE_ID)).rejects.toMatchObject({
            statusCode: StatusCodes.BAD_REQUEST
        })
    })

    it('rejects more than 999 external references without consulting existing workspace rows', async () => {
        const data = normalizeWorkspaceImportForCreate(emptyPayload(), WORKSPACE_ID)
        data.Execution = Array.from({ length: 1_001 }, (_, index) => ({
            id: `${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`,
            executionData: '{}',
            state: 'FINISHED',
            agentflowId: `${String(index + 2_000).padStart(8, '0')}-0000-4000-8000-000000000000`,
            sessionId: `session-${index}`
        })) as Execution[]
        const manager = makeManager()

        await expect(preflightWorkspaceImportRelations(manager as never, data, WORKSPACE_ID)).rejects.toMatchObject({
            statusCode: StatusCodes.BAD_REQUEST
        })
        expect(manager.find).not.toHaveBeenCalled()
    })

    it('uses insert-only batches and maps a post-preflight race to a fixed conflict', async () => {
        const manager = { insert: jest.fn().mockResolvedValue({ identifiers: [] }), save: jest.fn() }
        const rows = Array.from({ length: 901 }, (_, index) => ({ id: String(index), name: `row-${index}` }))
        await insertWorkspaceImportBatch(manager as never, Tool, rows as Tool[])
        expect(manager.insert).toHaveBeenCalledTimes(2)
        expect(manager.save).not.toHaveBeenCalled()

        manager.insert.mockRejectedValueOnce(new Error('database detail'))
        await expect(insertWorkspaceImportBatch(manager as never, Tool, [rows[0]] as Tool[])).rejects.toMatchObject({
            statusCode: StatusCodes.CONFLICT,
            message: 'Workspace import changed concurrently'
        })
    })
})
