import { EnumChatflowType } from '../../database/entities/ChatFlow'
import { buildWorkspaceExportClosure, type WorkspaceExportInventory } from './workspaceExportClosure'
import type { WorkspaceExportInput } from './workspaceExportContract'

const ROOT = '11111111-1111-4111-8111-111111111111'
const CHILD = '22222222-2222-4222-8222-222222222222'
const UNRELATED = '33333333-3333-4333-8333-333333333333'
const TOOL = '44444444-4444-4444-8444-444444444444'
const OTHER_TOOL = '55555555-5555-4555-8555-555555555555'
const STORE = '66666666-6666-4666-8666-666666666666'
const OTHER_STORE = '77777777-7777-4777-8777-777777777777'
const MESSAGE = '88888888-8888-4888-8888-888888888888'
const EXECUTION = '99999999-9999-4999-8999-999999999999'

const emptyInput = (): WorkspaceExportInput => ({
    agentflow: false,
    agentflowv2: false,
    assistantCustom: false,
    assistantOpenAI: false,
    assistantAzure: false,
    chatflow: false,
    chat_message: false,
    chat_feedback: false,
    custom_template: false,
    document_store: false,
    execution: false,
    tool: false,
    variable: false
})

const flow = (id: string, type: EnumChatflowType, nodes: unknown[] = []) => ({
    id,
    name: id,
    type,
    flowData: JSON.stringify({ nodes, edges: [] })
})

const inventory = (): WorkspaceExportInventory => ({
    flows: [
        flow(ROOT, EnumChatflowType.MULTIAGENT, [
            {
                data: {
                    name: 'ChatflowTool',
                    inputs: { selectedChatflow: CHILD, baseURL: 'https://flowise.example.invalid' }
                }
            },
            {
                data: {
                    name: 'agentAgentflow',
                    inputs: {
                        agentTools: [{ agentSelectedTool: 'customTool', agentSelectedToolConfig: { selectedTool: TOOL } }]
                    }
                }
            },
            { data: { name: 'documentStore', inputs: { selectedStore: STORE } } }
        ]),
        flow(CHILD, EnumChatflowType.CHATFLOW),
        flow(UNRELATED, EnumChatflowType.CHATFLOW)
    ] as never,
    assistants: [],
    messages: [
        { id: MESSAGE, chatflowid: CHILD, executionId: EXECUTION, chatId: 'chat-1', role: 'userMessage', content: 'fixture' }
    ] as never,
    feedbacks: [
        {
            id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            chatflowid: CHILD,
            messageId: MESSAGE,
            chatId: 'chat-1'
        }
    ] as never,
    templates: [],
    documentStores: [
        { id: STORE, name: 'Referenced store' },
        { id: OTHER_STORE, name: 'Unrelated store' }
    ] as never,
    documentStoreChunks: [
        { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', storeId: STORE },
        { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', storeId: OTHER_STORE }
    ] as never,
    executions: [{ id: EXECUTION, agentflowId: CHILD, state: 'FINISHED', executionData: '{}' }] as never,
    tools: [
        { id: TOOL, name: 'Referenced tool' },
        { id: OTHER_TOOL, name: 'Unrelated tool' }
    ] as never,
    variables: [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', name: 'TOKEN', value: 'do-not-export' }] as never
})

describe('workspace export record closure', () => {
    it('recursively includes only referenced flow, tool, and document-store records', () => {
        const input = { ...emptyInput(), agentflow: true }
        const result = buildWorkspaceExportClosure(input, inventory(), 'https://flowise.example.invalid')

        expect(result.data.AgentFlow.map(({ id }) => id)).toEqual([ROOT])
        expect(result.data.ChatFlow.map(({ id }) => id)).toEqual([CHILD])
        expect(result.data.Tool.map(({ id }) => id)).toEqual([TOOL])
        expect(result.data.DocumentStore.map(({ id }) => id)).toEqual([STORE])
        expect(result.data.DocumentStoreFileChunk.map(({ storeId }) => storeId)).toEqual([STORE])
        expect(result.data.Variable).toEqual([expect.objectContaining({ name: 'TOKEN', value: '' })])
        expect(result.manifest).toMatchObject({ dependencyMode: 'record-closure', selectedCategories: ['agentflow'] })
    })

    it('adds the exact message, execution, and flow parents for feedback-only export', () => {
        const result = buildWorkspaceExportClosure({ ...emptyInput(), chat_feedback: true }, inventory(), 'https://flowise.example.invalid')
        expect(result.data.ChatMessage.map(({ id }) => id)).toEqual([MESSAGE])
        expect(result.data.ChatMessageFeedback).toHaveLength(1)
        expect(result.data.Execution.map(({ id }) => id)).toEqual([EXECUTION])
        expect(result.data.ChatFlow.map(({ id }) => id)).toEqual([CHILD])
        expect(result.data.AgentFlow).toEqual([])
    })

    it.each([
        ['references a message in another flow', (broken: WorkspaceExportInventory) => (broken.feedbacks[0].chatflowid = ROOT)],
        [
            'uses a different chat session than its parent message',
            (broken: WorkspaceExportInventory) => (broken.feedbacks[0].chatId = 'chat-2')
        ],
        [
            'references a parent message that is absent from the export inventory',
            (broken: WorkspaceExportInventory) => {
                broken.feedbacks[0].messageId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
            }
        ]
    ])('fails closed when feedback %s', (_scenario, corrupt) => {
        const broken = inventory()
        corrupt(broken)

        expect(() =>
            buildWorkspaceExportClosure({ ...emptyInput(), chat_feedback: true }, broken, 'https://flowise.example.invalid')
        ).toThrow(expect.objectContaining({ statusCode: 422, message: '工作区引用不完整，无法生成可恢复的导出文件' }))
    })

    it('fails closed when a message execution belongs to another flow', () => {
        const broken = inventory()
        broken.executions[0].agentflowId = ROOT

        expect(() =>
            buildWorkspaceExportClosure({ ...emptyInput(), chat_feedback: true }, broken, 'https://flowise.example.invalid')
        ).toThrow(expect.objectContaining({ statusCode: 422, message: '工作区引用不完整，无法生成可恢复的导出文件' }))
    })

    it('fails closed when a selected runtime reference is absent from the workspace inventory', () => {
        const broken = inventory()
        broken.flows = broken.flows.filter(({ id }) => id !== CHILD)
        expect(() => buildWorkspaceExportClosure({ ...emptyInput(), agentflow: true }, broken, 'https://flowise.example.invalid')).toThrow(
            expect.objectContaining({ statusCode: 422, message: '工作区引用不完整，无法生成可恢复的导出文件' })
        )
    })
})
