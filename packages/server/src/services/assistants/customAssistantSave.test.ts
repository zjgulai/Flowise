import { StatusCodes } from 'http-status-codes'
import { Assistant } from '../../database/entities/Assistant'
import { ChatFlow, EnumChatflowType } from '../../database/entities/ChatFlow'
import { Credential } from '../../database/entities/Credential'
import { DocumentStore } from '../../database/entities/DocumentStore'
import { Tool } from '../../database/entities/Tool'
import { WorkspaceShared } from '../../enterprise/database/entities/EnterpriseEntities'
import { Workspace } from '../../enterprise/database/entities/workspace.entity'
import {
    CustomAssistantSaveDependencies,
    getCustomAssistantFlowWithDataSource,
    saveCustomAssistantWithDependencies,
    validateCustomAssistantDetails,
    validateCustomAssistantFlowData
} from './customAssistantSave'

const OLD_ASSISTANT_DATE = new Date('2026-08-02T01:00:00.000Z')
const OLD_FLOW_DATE = new Date('2026-08-02T01:05:00.000Z')
const ASSISTANT_ID = '11111111-1111-4111-8111-111111111111'
const FLOW_ID = '22222222-2222-4222-8222-222222222222'
const CREATED_FLOW_ID = '33333333-3333-4333-8333-333333333333'
const SHARED_CREDENTIAL_ID = '44444444-4444-4444-8444-444444444444'
const FOREIGN_STORE_ID = '55555555-5555-4555-8555-555555555555'
const CUSTOM_TOOL_ID = '66666666-6666-4666-8666-666666666666'
const DOCUMENT_STORE_A_ID = '77777777-7777-4777-8777-777777777777'
const DOCUMENT_STORE_B_ID = '88888888-8888-4888-8888-888888888888'

type State = {
    assistants: Assistant[]
    chatflows: ChatFlow[]
    credentials: Array<Partial<Credential>>
    shared: Array<Partial<WorkspaceShared>>
    documentStores: Array<Partial<DocumentStore>>
    tools: Array<Partial<Tool>>
    workspaces: Array<Partial<Workspace>>
}

const cloneState = (state: State): State => structuredClone(state)

const matches = (entity: Record<string, any>, where: Record<string, any>) =>
    Object.entries(where).every(([key, expected]) => {
        const actual = entity[key]
        if (expected && expected.type === 'in') return expected.value.includes(actual)
        if (expected instanceof Date && actual instanceof Date) return expected.getTime() === actual.getTime()
        return actual === expected
    })

const makeFakeDataSource = (
    initialState: State,
    behavior: { failAssistantCas?: boolean; failFlowCas?: boolean; failDocumentStoreCas?: boolean } = {}
) => {
    let committed = cloneState(initialState)
    const repository = (entity: unknown, state: State) => {
        const rows: Array<Record<string, any>> =
            entity === Assistant
                ? state.assistants
                : entity === ChatFlow
                ? state.chatflows
                : entity === Credential
                ? state.credentials
                : entity === WorkspaceShared
                ? state.shared
                : entity === DocumentStore
                ? state.documentStores
                : entity === Tool
                ? state.tools
                : entity === Workspace
                ? state.workspaces
                : []
        return {
            findOneBy: jest.fn(async (where: Record<string, any>) => rows.find((row) => matches(row, where)) ?? null),
            findBy: jest.fn(async (where: Record<string, any>) => rows.filter((row) => matches(row, where))),
            countBy: jest.fn(async (where: Record<string, any>) => rows.filter((row) => matches(row, where)).length),
            count: jest.fn(async ({ where }: { where: Record<string, any> }) => rows.filter((row) => matches(row, where)).length),
            create: jest.fn((value: Record<string, any>) => ({ ...value })),
            save: jest.fn(async (value: Record<string, any>) => {
                const now = new Date('2026-08-02T02:00:00.000Z')
                const saved = {
                    id: value.id ?? CREATED_FLOW_ID,
                    createdDate: value.createdDate ?? now,
                    updatedDate: value.updatedDate ?? now,
                    ...value
                }
                rows.push(saved)
                return saved
            }),
            update: jest.fn(async (where: Record<string, any>, changes: Record<string, any>) => {
                if (
                    (entity === Assistant && behavior.failAssistantCas) ||
                    (entity === ChatFlow && behavior.failFlowCas) ||
                    (entity === DocumentStore && behavior.failDocumentStoreCas)
                )
                    return { affected: 0 }
                const index = rows.findIndex((row) => matches(row, where))
                if (index < 0) return { affected: 0 }
                rows[index] = {
                    ...rows[index],
                    ...changes,
                    ...(entity === DocumentStore ? { revision: Number(rows[index].revision) + 1 } : {})
                }
                return { affected: 1 }
            })
        }
    }
    const dataSource = {
        getRepository: (entity: unknown) => repository(entity, committed),
        transaction: async (operation: (manager: any) => Promise<any>) => {
            const working = cloneState(committed)
            const manager = { getRepository: (entity: unknown) => repository(entity, working) }
            const result = await operation(manager)
            committed = working
            return result
        }
    }
    return { dataSource: dataSource as any, getState: () => committed }
}

const makeAssistant = (details: string, overrides: Partial<Assistant> = {}): Assistant =>
    ({
        id: ASSISTANT_ID,
        details,
        credential: 'assistant-internal-id',
        type: 'CUSTOM',
        createdDate: new Date('2026-08-02T00:00:00.000Z'),
        updatedDate: OLD_ASSISTANT_DATE,
        workspaceId: 'workspace-1',
        ...overrides
    } as Assistant)

const makeChatflow = (overrides: Partial<ChatFlow> = {}): ChatFlow =>
    ({
        id: FLOW_ID,
        name: 'Old assistant',
        flowData: JSON.stringify({
            nodes: [
                { id: 'model', data: { name: 'chatModel', inputs: {} } },
                { id: 'agent', data: { name: 'toolAgent', inputs: {} } }
            ],
            edges: [{ id: 'model-agent', source: 'model', target: 'agent' }]
        }),
        type: EnumChatflowType.ASSISTANT,
        createdDate: new Date('2026-08-02T00:05:00.000Z'),
        updatedDate: OLD_FLOW_DATE,
        workspaceId: 'workspace-1',
        ...overrides
    } as ChatFlow)

const makeDocumentStore = (id: string, whereUsed = '[]'): Partial<DocumentStore> => ({
    id,
    name: `Store ${id.slice(0, 4)}`,
    workspaceId: 'workspace-1',
    generationId: '99999999-9999-4999-8999-999999999999',
    revision: 1,
    whereUsed
})

const newDetails = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
        name: 'New assistant',
        chatModel: { name: 'chatDeepSeek', inputs: {} },
        instruction: 'Help the user.',
        documentStores: [],
        tools: [],
        ...extra
    })

const newFlowData = (extraNodeData: Record<string, unknown> = {}) =>
    JSON.stringify({
        nodes: [
            { id: 'model', data: { name: 'chatDeepSeek', inputs: {}, ...extraNodeData } },
            { id: 'agent', data: { name: 'toolAgent', inputs: {} } }
        ],
        edges: [{ id: 'model-agent', source: 'model', target: 'agent' }]
    })

const assistantSnapshot = (assistant: Assistant) => ({
    updatedDate: assistant.updatedDate.toISOString(),
    details: assistant.details,
    type: 'CUSTOM' as const
})

const flowSnapshot = (chatflow: ChatFlow) => ({
    id: chatflow.id,
    updatedDate: chatflow.updatedDate.toISOString(),
    name: chatflow.name,
    flowData: chatflow.flowData,
    type: EnumChatflowType.ASSISTANT
})

const initialState = (assistant: Assistant, chatflows: ChatFlow[] = []): State => ({
    assistants: [assistant],
    chatflows,
    credentials: [],
    shared: [],
    documentStores: [],
    tools: [],
    workspaces: [{ id: 'workspace-1', organizationId: 'org-1' }]
})

const dependencies = (dataSource: any, quota = jest.fn().mockResolvedValue(undefined)): CustomAssistantSaveDependencies => ({
    dataSource,
    usageCacheManager: {} as any,
    componentNodes: {
        chatDeepSeek: { name: 'chatDeepSeek', category: 'Chat Models' },
        toolAgent: { name: 'toolAgent', category: 'Agents' },
        bufferMemory: { name: 'bufferMemory', category: 'Memory' },
        documentStoreVS: { name: 'documentStoreVS', category: 'Vector Stores' },
        retrieverTool: { name: 'retrieverTool', category: 'Tools' },
        customTool: { name: 'customTool', category: 'Tools' }
    } as any,
    checkUsageLimitFn: quota
})

describe('atomic custom assistant save', () => {
    it('creates the linked ASSISTANT flow and updates details in one transaction', async () => {
        const assistant = makeAssistant(JSON.stringify({ name: 'New assistant' }))
        const fake = makeFakeDataSource(initialState(assistant))
        const quota = jest.fn().mockResolvedValue(undefined)

        const result = await saveCustomAssistantWithDependencies(
            assistant.id,
            {
                expectedAssistant: assistantSnapshot(assistant),
                expectedChatflow: null,
                details: newDetails(),
                flowData: newFlowData()
            },
            'org-1',
            'workspace-1',
            'subscription-1',
            dependencies(fake.dataSource, quota)
        )

        expect(result.createdFlow).toBe(true)
        expect(result.chatflow).toMatchObject({ id: CREATED_FLOW_ID, type: EnumChatflowType.ASSISTANT, workspaceId: 'workspace-1' })
        expect(JSON.parse(result.assistant.details)).toMatchObject({ name: 'New assistant', flowId: CREATED_FLOW_ID })
        expect(quota).toHaveBeenCalledWith('flows', 'subscription-1', expect.anything(), 1)
    })

    it('adds the created assistant flow to the selected document store usage in the same transaction', async () => {
        const assistant = makeAssistant(JSON.stringify({ name: 'New assistant' }))
        const state = initialState(assistant)
        state.documentStores = [makeDocumentStore(DOCUMENT_STORE_A_ID)]
        const fake = makeFakeDataSource(state)

        await saveCustomAssistantWithDependencies(
            assistant.id,
            {
                expectedAssistant: assistantSnapshot(assistant),
                expectedChatflow: null,
                details: newDetails({ documentStores: [{ id: DOCUMENT_STORE_A_ID, name: 'A' }] }),
                flowData: newFlowData()
            },
            'org-1',
            'workspace-1',
            'subscription-1',
            dependencies(fake.dataSource)
        )

        expect(fake.getState().documentStores).toEqual([
            expect.objectContaining({ id: DOCUMENT_STORE_A_ID, whereUsed: JSON.stringify([CREATED_FLOW_ID]), revision: 2 })
        ])
    })

    it('updates only the persisted linked flow and skips creation quota', async () => {
        const chatflow = makeChatflow()
        const assistant = makeAssistant(JSON.stringify({ name: 'Old assistant', flowId: chatflow.id }))
        const fake = makeFakeDataSource(initialState(assistant, [chatflow]))
        const quota = jest.fn().mockResolvedValue(undefined)

        const result = await saveCustomAssistantWithDependencies(
            assistant.id,
            {
                expectedAssistant: assistantSnapshot(assistant),
                expectedChatflow: flowSnapshot(chatflow),
                details: newDetails({ flowId: CREATED_FLOW_ID }),
                flowData: newFlowData()
            },
            'org-1',
            'workspace-1',
            'subscription-1',
            dependencies(fake.dataSource, quota)
        )

        expect(result.createdFlow).toBe(false)
        expect(result.chatflow.id).toBe(chatflow.id)
        expect(JSON.parse(result.assistant.details).flowId).toBe(chatflow.id)
        expect(quota).not.toHaveBeenCalled()
    })

    it('moves an updated assistant flow from the old document store usage to the new store', async () => {
        const chatflow = makeChatflow()
        const assistant = makeAssistant(
            JSON.stringify({ name: 'Old assistant', flowId: chatflow.id, documentStores: [{ id: DOCUMENT_STORE_A_ID }] })
        )
        const state = initialState(assistant, [chatflow])
        state.documentStores = [makeDocumentStore(DOCUMENT_STORE_A_ID, JSON.stringify([FLOW_ID])), makeDocumentStore(DOCUMENT_STORE_B_ID)]
        const fake = makeFakeDataSource(state)

        await saveCustomAssistantWithDependencies(
            assistant.id,
            {
                expectedAssistant: assistantSnapshot(assistant),
                expectedChatflow: flowSnapshot(chatflow),
                details: newDetails({ documentStores: [{ id: DOCUMENT_STORE_B_ID }] }),
                flowData: newFlowData()
            },
            'org-1',
            'workspace-1',
            'subscription-1',
            dependencies(fake.dataSource)
        )

        expect(fake.getState().documentStores).toEqual([
            expect.objectContaining({ id: DOCUMENT_STORE_A_ID, whereUsed: '[]', revision: 2 }),
            expect.objectContaining({ id: DOCUMENT_STORE_B_ID, whereUsed: JSON.stringify([FLOW_ID]), revision: 2 })
        ])
    })

    it('rolls back assistant, flow, and document-store usage when the usage CAS loses a race', async () => {
        const assistant = makeAssistant(JSON.stringify({ name: 'New assistant' }))
        const state = initialState(assistant)
        state.documentStores = [makeDocumentStore(DOCUMENT_STORE_A_ID)]
        const before = cloneState(state)
        const fake = makeFakeDataSource(state, { failDocumentStoreCas: true })

        await expect(
            saveCustomAssistantWithDependencies(
                assistant.id,
                {
                    expectedAssistant: assistantSnapshot(assistant),
                    expectedChatflow: null,
                    details: newDetails({ documentStores: [{ id: DOCUMENT_STORE_A_ID }] }),
                    flowData: newFlowData()
                },
                'org-1',
                'workspace-1',
                'subscription-1',
                dependencies(fake.dataSource)
            )
        ).rejects.toMatchObject({ statusCode: StatusCodes.CONFLICT })
        expect(fake.getState()).toEqual(before)
    })

    it.each([
        ['outside the workspace', makeAssistant(JSON.stringify({ name: 'A' })), 'workspace-2', StatusCodes.NOT_FOUND],
        [
            'the wrong assistant type',
            makeAssistant(JSON.stringify({ name: 'A' }), { type: 'OPENAI' }),
            'workspace-1',
            StatusCodes.BAD_REQUEST
        ]
    ])('rejects an assistant %s', async (_label, assistant, workspaceId, statusCode) => {
        const fake = makeFakeDataSource(initialState(assistant))
        await expect(
            saveCustomAssistantWithDependencies(
                assistant.id,
                {
                    expectedAssistant: assistantSnapshot({ ...assistant, type: 'CUSTOM' } as Assistant),
                    expectedChatflow: null,
                    details: newDetails(),
                    flowData: newFlowData()
                },
                'org-1',
                workspaceId,
                'subscription-1',
                dependencies(fake.dataSource)
            )
        ).rejects.toMatchObject({ statusCode })
    })

    it('rejects an active workspace that is not in the active organization', async () => {
        const assistant = makeAssistant(JSON.stringify({ name: 'A' }))
        const state = initialState(assistant)
        state.workspaces[0].organizationId = 'org-2'
        const fake = makeFakeDataSource(state)

        await expect(
            saveCustomAssistantWithDependencies(
                assistant.id,
                {
                    expectedAssistant: assistantSnapshot(assistant),
                    expectedChatflow: null,
                    details: newDetails(),
                    flowData: newFlowData()
                },
                'org-1',
                'workspace-1',
                '',
                dependencies(fake.dataSource)
            )
        ).rejects.toMatchObject({ statusCode: StatusCodes.NOT_FOUND, message: expect.stringContaining('organization org-1') })
    })

    it.each([
        ['route assistant id', 'not-a-uuid', null, StatusCodes.BAD_REQUEST],
        ['persisted flow id', ASSISTANT_ID, 'not-a-uuid', StatusCodes.CONFLICT]
    ])('rejects an invalid UUID in the %s before querying that UUID resource', async (_label, assistantId, persistedFlowId, statusCode) => {
        const details = JSON.stringify({ name: 'A', ...(persistedFlowId ? { flowId: persistedFlowId } : {}) })
        const assistant = makeAssistant(details)
        const fake = makeFakeDataSource(initialState(assistant))
        await expect(
            saveCustomAssistantWithDependencies(
                assistantId,
                {
                    expectedAssistant: assistantSnapshot(assistant),
                    expectedChatflow: null,
                    details: newDetails(),
                    flowData: newFlowData()
                },
                'org-1',
                'workspace-1',
                '',
                dependencies(fake.dataSource)
            )
        ).rejects.toMatchObject({ statusCode })
    })

    it('rejects an invalid expected linked-flow UUID before any linked-flow query', async () => {
        const assistant = makeAssistant(JSON.stringify({ name: 'A', flowId: FLOW_ID }))
        const chatflow = makeChatflow()
        const fake = makeFakeDataSource(initialState(assistant, [chatflow]))
        await expect(
            saveCustomAssistantWithDependencies(
                assistant.id,
                {
                    expectedAssistant: assistantSnapshot(assistant),
                    expectedChatflow: { ...flowSnapshot(chatflow), id: 'not-a-uuid' },
                    details: newDetails(),
                    flowData: newFlowData()
                },
                'org-1',
                'workspace-1',
                '',
                dependencies(fake.dataSource)
            )
        ).rejects.toMatchObject({ statusCode: StatusCodes.BAD_REQUEST })
    })

    it('rejects malformed details and graph schemas before starting a transaction', async () => {
        const assistant = makeAssistant(JSON.stringify({ name: 'A' }))
        const fake = makeFakeDataSource(initialState(assistant))
        await expect(
            saveCustomAssistantWithDependencies(
                assistant.id,
                {
                    expectedAssistant: assistantSnapshot(assistant),
                    expectedChatflow: null,
                    details: JSON.stringify({ name: 'A', chatModel: null, instruction: '', documentStores: [], tools: [] }),
                    flowData: JSON.stringify({ nodes: [null], edges: [] })
                },
                'org-1',
                'workspace-1',
                '',
                dependencies(fake.dataSource)
            )
        ).rejects.toMatchObject({ statusCode: StatusCodes.BAD_REQUEST })
    })

    it.each([
        ['inputParams entry', newDetails({ chatModel: { name: 'chatDeepSeek', inputs: {}, inputParams: [null] } })],
        ['input option', newDetails({ chatModel: { name: 'chatDeepSeek', inputs: {}, inputParams: [{ name: 'model', options: [42] }] } })],
        [
            'document-store returnSourceDocuments',
            newDetails({
                documentStores: [{ id: FOREIGN_STORE_ID, name: 'Store', description: '', returnSourceDocuments: 'yes' }]
            })
        ]
    ])('rejects an invalid nested %s schema', async (_label, details) => {
        const assistant = makeAssistant(JSON.stringify({ name: 'A' }))
        const fake = makeFakeDataSource(initialState(assistant))
        await expect(
            saveCustomAssistantWithDependencies(
                assistant.id,
                {
                    expectedAssistant: assistantSnapshot(assistant),
                    expectedChatflow: null,
                    details,
                    flowData: newFlowData()
                },
                'org-1',
                'workspace-1',
                '',
                dependencies(fake.dataSource)
            )
        ).rejects.toMatchObject({ statusCode: StatusCodes.BAD_REQUEST })
    })

    it('rejects a stale assistant snapshot even when its timestamp is unchanged', async () => {
        const assistant = makeAssistant(JSON.stringify({ name: 'Changed in the same second' }))
        const fake = makeFakeDataSource(initialState(assistant))
        await expect(
            saveCustomAssistantWithDependencies(
                assistant.id,
                {
                    expectedAssistant: { ...assistantSnapshot(assistant), details: JSON.stringify({ name: 'Old value' }) },
                    expectedChatflow: null,
                    details: newDetails(),
                    flowData: newFlowData()
                },
                'org-1',
                'workspace-1',
                '',
                dependencies(fake.dataSource)
            )
        ).rejects.toMatchObject({ statusCode: StatusCodes.CONFLICT })
    })

    it('returns 409 when the linked-flow compare-and-swap affects no row', async () => {
        const chatflow = makeChatflow()
        const assistant = makeAssistant(JSON.stringify({ name: 'Old assistant', flowId: chatflow.id }))
        const fake = makeFakeDataSource(initialState(assistant, [chatflow]), { failFlowCas: true })
        await expect(
            saveCustomAssistantWithDependencies(
                assistant.id,
                {
                    expectedAssistant: assistantSnapshot(assistant),
                    expectedChatflow: flowSnapshot(chatflow),
                    details: newDetails(),
                    flowData: newFlowData()
                },
                'org-1',
                'workspace-1',
                '',
                dependencies(fake.dataSource)
            )
        ).rejects.toMatchObject({ statusCode: StatusCodes.CONFLICT })
    })

    it('rolls back the first write when the assistant CAS is the failing second write', async () => {
        const chatflow = makeChatflow()
        const assistant = makeAssistant(JSON.stringify({ name: 'Old assistant', flowId: chatflow.id }))
        const fake = makeFakeDataSource(initialState(assistant, [chatflow]), { failAssistantCas: true })
        await expect(
            saveCustomAssistantWithDependencies(
                assistant.id,
                {
                    expectedAssistant: assistantSnapshot(assistant),
                    expectedChatflow: flowSnapshot(chatflow),
                    details: newDetails(),
                    flowData: newFlowData()
                },
                'org-1',
                'workspace-1',
                '',
                dependencies(fake.dataSource)
            )
        ).rejects.toMatchObject({ statusCode: StatusCodes.CONFLICT })

        expect(fake.getState().chatflows[0].name).toBe('Old assistant')
        expect(fake.getState().chatflows[0].flowData).toBe(chatflow.flowData)
        expect(fake.getState().assistants[0].details).toBe(assistant.details)
    })

    it('allows shared credentials but rejects document stores outside the active workspace', async () => {
        const assistant = makeAssistant(JSON.stringify({ name: 'A' }))
        const state = initialState(assistant)
        state.shared.push({ workspaceId: 'workspace-1', sharedItemId: SHARED_CREDENTIAL_ID, itemType: 'credential' })
        const fake = makeFakeDataSource(state)
        await expect(
            saveCustomAssistantWithDependencies(
                assistant.id,
                {
                    expectedAssistant: assistantSnapshot(assistant),
                    expectedChatflow: null,
                    details: newDetails({
                        chatModel: { name: 'chatDeepSeek', credential: SHARED_CREDENTIAL_ID, inputs: {} },
                        documentStores: [{ id: FOREIGN_STORE_ID, name: 'Foreign', description: '' }]
                    }),
                    flowData: newFlowData()
                },
                'org-1',
                'workspace-1',
                '',
                dependencies(fake.dataSource)
            )
        ).rejects.toMatchObject({ statusCode: StatusCodes.NOT_FOUND, message: expect.stringContaining(FOREIGN_STORE_ID) })
    })

    it('rejects executable components that were not selected for the assistant', async () => {
        const assistant = makeAssistant(JSON.stringify({ name: 'A' }))
        const fake = makeFakeDataSource(initialState(assistant))
        const flowData = JSON.parse(newFlowData())
        flowData.nodes.push({ id: 'custom-function', data: { name: 'customFunction', inputs: { javascriptFunction: 'return 1' } } })

        await expect(
            saveCustomAssistantWithDependencies(
                assistant.id,
                {
                    expectedAssistant: assistantSnapshot(assistant),
                    expectedChatflow: null,
                    details: newDetails(),
                    flowData: JSON.stringify(flowData)
                },
                'org-1',
                'workspace-1',
                '',
                dependencies(fake.dataSource)
            )
        ).rejects.toMatchObject({ statusCode: StatusCodes.BAD_REQUEST, message: expect.stringContaining('not selected') })
    })

    it('rejects custom-tool code overrides instead of accepting client-supplied executable code', async () => {
        const assistant = makeAssistant(JSON.stringify({ name: 'A' }))
        const fake = makeFakeDataSource(initialState(assistant))
        const flowData = JSON.parse(newFlowData())
        flowData.nodes.push({
            id: 'customTool_0',
            data: {
                name: 'customTool',
                inputs: { selectedTool: CUSTOM_TOOL_ID, customToolFunc: 'return process.env' }
            }
        })

        await expect(
            saveCustomAssistantWithDependencies(
                assistant.id,
                {
                    expectedAssistant: assistantSnapshot(assistant),
                    expectedChatflow: null,
                    details: newDetails({ tools: [{ name: 'customTool', inputs: {} }] }),
                    flowData: JSON.stringify(flowData)
                },
                'org-1',
                'workspace-1',
                '',
                dependencies(fake.dataSource)
            )
        ).rejects.toMatchObject({ statusCode: StatusCodes.BAD_REQUEST, message: expect.stringContaining('overrides are not allowed') })
    })
})

describe('custom assistant flow read scope', () => {
    it('returns null before a custom assistant has a linked flow', async () => {
        const assistant = makeAssistant(JSON.stringify({ name: 'A' }))
        const fake = makeFakeDataSource(initialState(assistant))
        await expect(getCustomAssistantFlowWithDataSource(assistant.id, 'workspace-1', fake.dataSource)).resolves.toBeNull()
    })

    it('refuses a linked flow from another workspace', async () => {
        const assistant = makeAssistant(JSON.stringify({ name: 'A', flowId: FLOW_ID }))
        const chatflow = makeChatflow({ workspaceId: 'workspace-2' })
        const fake = makeFakeDataSource(initialState(assistant, [chatflow]))
        await expect(getCustomAssistantFlowWithDataSource(assistant.id, 'workspace-1', fake.dataSource)).rejects.toMatchObject({
            statusCode: StatusCodes.NOT_FOUND
        })
    })

    it('rejects an invalid assistant UUID before querying the database', async () => {
        const assistant = makeAssistant(JSON.stringify({ name: 'A' }))
        const fake = makeFakeDataSource(initialState(assistant))
        await expect(getCustomAssistantFlowWithDataSource('not-a-uuid', 'workspace-1', fake.dataSource)).rejects.toMatchObject({
            statusCode: StatusCodes.BAD_REQUEST
        })
    })
})

describe('custom assistant file-side-effect guard', () => {
    it('rejects inline base64 and stored-file references', () => {
        expect(() => validateCustomAssistantFlowData(newFlowData({ inputs: { file: 'data:text/plain;base64,QQ==' } }))).toThrow(
            'inline base64'
        )
        expect(() => validateCustomAssistantFlowData(newFlowData({ inputs: { file: 'FILE-STORAGE::secret.pdf' } }))).toThrow('file-storage')
        expect(() => validateCustomAssistantDetails(newDetails({ avatar: 'data:image/png;base64,QQ==' }))).toThrow('file payloads')
    })
})
