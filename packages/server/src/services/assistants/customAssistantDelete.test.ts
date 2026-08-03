import { StatusCodes } from 'http-status-codes'
import { Assistant } from '../../database/entities/Assistant'
import { ChatFlow, EnumChatflowType } from '../../database/entities/ChatFlow'
import { ChatMessage } from '../../database/entities/ChatMessage'
import { ChatMessageFeedback } from '../../database/entities/ChatMessageFeedback'
import { DocumentStore } from '../../database/entities/DocumentStore'
import { Evaluation } from '../../database/entities/Evaluation'
import { Execution } from '../../database/entities/Execution'
import { Lead } from '../../database/entities/Lead'
import { UpsertHistory } from '../../database/entities/UpsertHistory'
import { Workspace } from '../../enterprise/database/entities/workspace.entity'
import { deleteCustomAssistantWithDependencies } from './customAssistantDelete'

const ASSISTANT_ID = '11111111-1111-4111-8111-111111111111'
const SECOND_ASSISTANT_ID = '22222222-2222-4222-8222-222222222222'
const FLOW_ID = '33333333-3333-4333-8333-333333333333'
const DOCUMENT_STORE_GENERATION_ID = '44444444-4444-4444-8444-444444444444'
const FOREIGN_DOCUMENT_STORE_GENERATION_ID = '55555555-5555-4555-8555-555555555555'
const ASSISTANT_DATE = new Date('2026-08-02T01:00:00.000Z')
const FLOW_DATE = new Date('2026-08-02T01:05:00.000Z')

type State = {
    assistants: Assistant[]
    chatflows: ChatFlow[]
    feedback: Array<Record<string, any>>
    messages: Array<Record<string, any>>
    executions: Array<Record<string, any>>
    leads: Array<Record<string, any>>
    histories: Array<Record<string, any>>
    documentStores: DocumentStore[]
    evaluations: Evaluation[]
    workspaces: Array<Record<string, any>>
}

type FakeBehavior = {
    failDeleteEntity?: unknown
    failAssistantCas?: boolean
    failFlowCas?: boolean
    failDocumentStoreCas?: boolean
}

const cloneState = (state: State): State => structuredClone(state)

const matches = (entity: Record<string, any>, where: Record<string, any>) =>
    Object.entries(where).every(([key, expected]) => {
        const actual = entity[key]
        if (expected instanceof Date && actual instanceof Date) return expected.getTime() === actual.getTime()
        return actual === expected
    })

const makeFakeDataSource = (initialState: State, behavior: FakeBehavior = {}) => {
    let committed = cloneState(initialState)
    const events: string[] = []
    const repository = (entity: unknown, state: State) => {
        const [name, rows]: [string, Array<Record<string, any>>] =
            entity === Assistant
                ? ['Assistant', state.assistants]
                : entity === ChatFlow
                ? ['ChatFlow', state.chatflows]
                : entity === ChatMessageFeedback
                ? ['Feedback', state.feedback]
                : entity === ChatMessage
                ? ['Message', state.messages]
                : entity === Execution
                ? ['Execution', state.executions]
                : entity === Lead
                ? ['Lead', state.leads]
                : entity === UpsertHistory
                ? ['UpsertHistory', state.histories]
                : entity === DocumentStore
                ? ['DocumentStore', state.documentStores]
                : entity === Evaluation
                ? ['Evaluation', state.evaluations]
                : entity === Workspace
                ? ['Workspace', state.workspaces]
                : ['Unknown', []]
        return {
            findOneBy: jest.fn(async (where: Record<string, any>) => rows.find((row) => matches(row, where)) ?? null),
            findBy: jest.fn(async (where: Record<string, any>) => rows.filter((row) => matches(row, where))),
            delete: jest.fn(async (where: Record<string, any>) => {
                events.push(`delete:${name}`)
                if (behavior.failDeleteEntity === entity) throw new Error('injected delete failure')
                if ((entity === Assistant && behavior.failAssistantCas) || (entity === ChatFlow && behavior.failFlowCas)) {
                    return { affected: 0 }
                }
                let affected = 0
                for (let index = rows.length - 1; index >= 0; index -= 1) {
                    if (!matches(rows[index], where)) continue
                    rows.splice(index, 1)
                    affected += 1
                }
                return { affected }
            }),
            update: jest.fn(async (where: Record<string, any>, changes: Record<string, any>) => {
                events.push(`update:${name}`)
                if (entity === DocumentStore && behavior.failDocumentStoreCas) return { affected: 0 }
                const index = rows.findIndex((row) => matches(row, where))
                if (index < 0) return { affected: 0 }
                rows[index] = {
                    ...rows[index],
                    ...changes,
                    ...(entity === DocumentStore ? { revision: rows[index].revision + 1 } : {})
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
            events.push('commit')
            return result
        }
    }
    return { dataSource: dataSource as any, getState: () => committed, events }
}

const makeAssistant = (overrides: Partial<Assistant> = {}): Assistant =>
    ({
        id: ASSISTANT_ID,
        details: JSON.stringify({ name: 'Assistant', flowId: FLOW_ID }),
        credential: 'internal-id',
        type: 'CUSTOM',
        createdDate: new Date('2026-08-02T00:00:00.000Z'),
        updatedDate: ASSISTANT_DATE,
        workspaceId: 'workspace-1',
        ...overrides
    } as Assistant)

const makeChatflow = (overrides: Partial<ChatFlow> = {}): ChatFlow =>
    ({
        id: FLOW_ID,
        name: 'Assistant',
        flowData: JSON.stringify({ nodes: [], edges: [] }),
        type: EnumChatflowType.ASSISTANT,
        createdDate: new Date('2026-08-02T00:05:00.000Z'),
        updatedDate: FLOW_DATE,
        workspaceId: 'workspace-1',
        ...overrides
    } as ChatFlow)

const assistantSnapshot = (assistant: Assistant) => ({
    updatedDate: assistant.updatedDate.toISOString(),
    details: assistant.details,
    type: 'CUSTOM' as const
})

const flowSnapshot = (flow: ChatFlow) => ({
    id: flow.id,
    updatedDate: flow.updatedDate.toISOString(),
    name: flow.name,
    flowData: flow.flowData,
    type: EnumChatflowType.ASSISTANT
})

const initialState = (): State => {
    const assistant = makeAssistant()
    const flow = makeChatflow()
    return {
        assistants: [assistant],
        chatflows: [flow],
        feedback: [{ id: 'feedback-1', chatflowid: FLOW_ID }],
        messages: [{ id: 'message-1', chatflowid: FLOW_ID }],
        executions: [
            { id: 'execution-1', agentflowId: FLOW_ID, workspaceId: 'workspace-1' },
            { id: 'foreign-execution', agentflowId: FLOW_ID, workspaceId: 'workspace-2' }
        ],
        leads: [{ id: 'lead-1', chatflowid: FLOW_ID }],
        histories: [{ id: 'history-1', chatflowid: FLOW_ID }],
        documentStores: [
            {
                id: 'store-1',
                workspaceId: 'workspace-1',
                generationId: DOCUMENT_STORE_GENERATION_ID,
                revision: 1,
                whereUsed: JSON.stringify([FLOW_ID, 'other-flow', FLOW_ID])
            } as DocumentStore,
            {
                id: 'foreign-store',
                workspaceId: 'workspace-2',
                generationId: FOREIGN_DOCUMENT_STORE_GENERATION_ID,
                revision: 1,
                whereUsed: JSON.stringify([FLOW_ID])
            } as DocumentStore
        ],
        evaluations: [],
        workspaces: [{ id: 'workspace-1', organizationId: 'organization-1' }]
    }
}

const requestBody = (state: State) => ({
    expectedAssistant: assistantSnapshot(state.assistants[0]),
    expectedChatflow: flowSnapshot(state.chatflows[0])
})

const dependencies = (
    dataSource: any,
    removeFolderFromStorageFn = jest.fn().mockResolvedValue({ totalSize: 7 }),
    updateStorageUsageFn = jest.fn().mockResolvedValue(undefined),
    cleanupLogger = { error: jest.fn() }
) => ({ dataSource, usageCacheManager: {} as any, removeFolderFromStorageFn, updateStorageUsageFn, cleanupLogger })

describe('atomic custom assistant aggregate deletion', () => {
    it('deletes the scoped aggregate in order, removes duplicate usage references, and cleans storage only after commit', async () => {
        const state = initialState()
        const fake = makeFakeDataSource(state)
        const removeStorage = jest.fn(async () => {
            fake.events.push('storage')
            return { totalSize: 7 }
        })
        const updateUsage = jest.fn(async () => {
            fake.events.push('usage')
        })

        await expect(
            deleteCustomAssistantWithDependencies(
                ASSISTANT_ID,
                requestBody(state),
                'organization-1',
                'workspace-1',
                dependencies(fake.dataSource, removeStorage, updateUsage)
            )
        ).resolves.toEqual({ assistantId: ASSISTANT_ID, chatflowId: FLOW_ID, deleted: true })

        expect(fake.events).toEqual([
            'delete:Feedback',
            'delete:Message',
            'delete:Execution',
            'delete:Lead',
            'delete:UpsertHistory',
            'update:DocumentStore',
            'delete:ChatFlow',
            'delete:Assistant',
            'commit',
            'storage',
            'usage'
        ])
        expect(fake.getState().assistants).toHaveLength(0)
        expect(fake.getState().chatflows).toHaveLength(0)
        expect(fake.getState().executions).toEqual([{ id: 'foreign-execution', agentflowId: FLOW_ID, workspaceId: 'workspace-2' }])
        expect(JSON.parse(fake.getState().documentStores[0].whereUsed)).toEqual(['other-flow'])
        expect(fake.getState().documentStores[0].revision).toBe(2)
        expect(JSON.parse(fake.getState().documentStores[1].whereUsed)).toEqual([FLOW_ID])
        expect(fake.getState().documentStores[1].revision).toBe(1)
        expect(removeStorage).toHaveBeenCalledWith('organization-1', FLOW_ID)
        expect(updateUsage).toHaveBeenCalledWith('organization-1', 'workspace-1', 7, expect.anything())
    })

    it('rolls back every prior child and flow delete when the assistant CAS loses', async () => {
        const state = initialState()
        const fake = makeFakeDataSource(state, { failAssistantCas: true })
        const removeStorage = jest.fn()

        await expect(
            deleteCustomAssistantWithDependencies(
                ASSISTANT_ID,
                requestBody(state),
                'organization-1',
                'workspace-1',
                dependencies(fake.dataSource, removeStorage)
            )
        ).rejects.toMatchObject({ statusCode: StatusCodes.CONFLICT, message: 'Assistant was modified concurrently' })

        expect(fake.getState()).toEqual(state)
        expect(removeStorage).not.toHaveBeenCalled()
    })

    it('rolls back every child deletion when the linked-flow CAS loses', async () => {
        const state = initialState()
        const fake = makeFakeDataSource(state, { failFlowCas: true })

        await expect(
            deleteCustomAssistantWithDependencies(
                ASSISTANT_ID,
                requestBody(state),
                'organization-1',
                'workspace-1',
                dependencies(fake.dataSource)
            )
        ).rejects.toMatchObject({ statusCode: StatusCodes.CONFLICT, message: 'Linked assistant flow was modified concurrently' })
        expect(fake.getState()).toEqual(state)
        expect(fake.events).not.toContain('delete:Assistant')
    })

    it('rejects a stale assistant snapshot before any delete', async () => {
        const state = initialState()
        const fake = makeFakeDataSource(state)
        const body = requestBody(state)
        body.expectedAssistant.details = JSON.stringify({ name: 'stale', flowId: FLOW_ID })

        await expect(
            deleteCustomAssistantWithDependencies(ASSISTANT_ID, body, 'organization-1', 'workspace-1', dependencies(fake.dataSource))
        ).rejects.toMatchObject({ statusCode: StatusCodes.CONFLICT, message: 'Assistant changed after it was loaded' })
        expect(fake.events).toEqual([])
    })

    it('rejects a linked flow outside the active workspace before any delete', async () => {
        const state = initialState()
        state.chatflows[0].workspaceId = 'workspace-2'
        const fake = makeFakeDataSource(state)

        await expect(
            deleteCustomAssistantWithDependencies(
                ASSISTANT_ID,
                requestBody(state),
                'organization-1',
                'workspace-1',
                dependencies(fake.dataSource)
            )
        ).rejects.toMatchObject({
            statusCode: StatusCodes.CONFLICT,
            message: 'Linked assistant flow is missing or outside the active workspace'
        })
        expect(fake.events).toEqual([])
    })

    it('rolls back on a child deletion failure and never starts post-commit cleanup', async () => {
        const state = initialState()
        const fake = makeFakeDataSource(state, { failDeleteEntity: ChatMessage })
        const removeStorage = jest.fn()

        await expect(
            deleteCustomAssistantWithDependencies(
                ASSISTANT_ID,
                requestBody(state),
                'organization-1',
                'workspace-1',
                dependencies(fake.dataSource, removeStorage)
            )
        ).rejects.toThrow('injected delete failure')
        expect(fake.getState()).toEqual(state)
        expect(removeStorage).not.toHaveBeenCalled()
    })

    it.each([
        ['invalid JSON', '{'],
        ['invalid shape', JSON.stringify({ value: FLOW_ID })]
    ])('fails closed and rolls back when DocumentStore.whereUsed has %s', async (_label, whereUsed) => {
        const state = initialState()
        state.documentStores[0].whereUsed = whereUsed
        const fake = makeFakeDataSource(state)

        await expect(
            deleteCustomAssistantWithDependencies(
                ASSISTANT_ID,
                requestBody(state),
                'organization-1',
                'workspace-1',
                dependencies(fake.dataSource)
            )
        ).rejects.toMatchObject({ statusCode: StatusCodes.CONFLICT, message: 'Document store usage is invalid' })
        expect(fake.getState()).toEqual(state)
    })

    it('rolls back when the DocumentStore usage CAS loses', async () => {
        const state = initialState()
        const fake = makeFakeDataSource(state, { failDocumentStoreCas: true })

        await expect(
            deleteCustomAssistantWithDependencies(
                ASSISTANT_ID,
                requestBody(state),
                'organization-1',
                'workspace-1',
                dependencies(fake.dataSource)
            )
        ).rejects.toMatchObject({ statusCode: StatusCodes.CONFLICT, message: 'Document store usage changed concurrently' })
        expect(fake.getState()).toEqual(state)
    })

    it('rejects a second custom assistant reference before any deletion', async () => {
        const state = initialState()
        state.assistants.push(makeAssistant({ id: SECOND_ASSISTANT_ID }))
        const fake = makeFakeDataSource(state)

        await expect(
            deleteCustomAssistantWithDependencies(
                ASSISTANT_ID,
                requestBody(state),
                'organization-1',
                'workspace-1',
                dependencies(fake.dataSource)
            )
        ).rejects.toMatchObject({ statusCode: StatusCodes.CONFLICT, message: 'Linked flow is referenced by another custom assistant' })
        expect(fake.events).toEqual([])
    })

    it('rejects an active-workspace evaluation Custom Assistant reference before any deletion', async () => {
        const state = initialState()
        state.evaluations.push({
            id: 'evaluation-1',
            workspaceId: 'workspace-1',
            chatflowId: JSON.stringify([ASSISTANT_ID]),
            additionalConfig: JSON.stringify({ chatflowTypes: ['Custom Assistant'] })
        } as Evaluation)
        const fake = makeFakeDataSource(state)

        await expect(
            deleteCustomAssistantWithDependencies(
                ASSISTANT_ID,
                requestBody(state),
                'organization-1',
                'workspace-1',
                dependencies(fake.dataSource)
            )
        ).rejects.toMatchObject({ statusCode: StatusCodes.CONFLICT, message: 'Custom assistant is referenced by an evaluation' })
        expect(fake.events).toEqual([])
    })

    it('ignores foreign-workspace and non-Custom-Assistant evaluation references', async () => {
        const state = initialState()
        state.evaluations.push(
            {
                id: 'evaluation-foreign',
                workspaceId: 'workspace-2',
                chatflowId: JSON.stringify([ASSISTANT_ID]),
                additionalConfig: JSON.stringify({ chatflowTypes: ['Custom Assistant'] })
            } as Evaluation,
            {
                id: 'evaluation-flow',
                workspaceId: 'workspace-1',
                chatflowId: JSON.stringify([ASSISTANT_ID]),
                additionalConfig: JSON.stringify({ chatflowTypes: ['Chatflow'] })
            } as Evaluation
        )
        const fake = makeFakeDataSource(state)

        await expect(
            deleteCustomAssistantWithDependencies(
                ASSISTANT_ID,
                requestBody(state),
                'organization-1',
                'workspace-1',
                dependencies(fake.dataSource)
            )
        ).resolves.toMatchObject({ deleted: true })
    })

    it.each([
        ['broken chatflowId', '{', JSON.stringify({ chatflowTypes: [] })],
        ['broken additionalConfig', JSON.stringify([]), '{'],
        ['misaligned chatflowTypes', JSON.stringify([ASSISTANT_ID]), JSON.stringify({ chatflowTypes: [] })]
    ])('fails closed on %s evaluation reference data', async (_label, chatflowId, additionalConfig) => {
        const state = initialState()
        state.evaluations.push({ id: 'evaluation-1', workspaceId: 'workspace-1', chatflowId, additionalConfig } as Evaluation)
        const fake = makeFakeDataSource(state)

        await expect(
            deleteCustomAssistantWithDependencies(
                ASSISTANT_ID,
                requestBody(state),
                'organization-1',
                'workspace-1',
                dependencies(fake.dataSource)
            )
        ).rejects.toMatchObject({
            statusCode: StatusCodes.CONFLICT,
            message: 'Unable to verify custom assistant evaluation references'
        })
        expect(fake.events).toEqual([])
    })

    it('preserves the committed DB deletion when post-commit storage cleanup fails', async () => {
        const state = initialState()
        const fake = makeFakeDataSource(state)
        const removeStorage = jest.fn().mockRejectedValue(new Error('secret provider detail'))
        const updateUsage = jest.fn()
        const cleanupLogger = { error: jest.fn() }

        await expect(
            deleteCustomAssistantWithDependencies(
                ASSISTANT_ID,
                requestBody(state),
                'organization-1',
                'workspace-1',
                dependencies(fake.dataSource, removeStorage, updateUsage, cleanupLogger)
            )
        ).resolves.toMatchObject({ deleted: true })
        expect(fake.getState().assistants).toHaveLength(0)
        expect(updateUsage).not.toHaveBeenCalled()
        expect(cleanupLogger.error).toHaveBeenCalledWith('[server]: Custom assistant post-commit storage cleanup failed', {
            failedCount: 1
        })
        expect(JSON.stringify(cleanupLogger.error.mock.calls)).not.toContain('secret provider detail')
    })

    it('preserves the committed DB deletion when the post-commit usage update fails', async () => {
        const state = initialState()
        const fake = makeFakeDataSource(state)
        const updateUsage = jest.fn().mockRejectedValue(new Error('secret cache detail'))
        const cleanupLogger = { error: jest.fn() }

        await expect(
            deleteCustomAssistantWithDependencies(
                ASSISTANT_ID,
                requestBody(state),
                'organization-1',
                'workspace-1',
                dependencies(fake.dataSource, undefined, updateUsage, cleanupLogger)
            )
        ).resolves.toMatchObject({ deleted: true })
        expect(cleanupLogger.error).toHaveBeenCalledWith('[server]: Custom assistant post-commit usage update failed', {
            failedCount: 1
        })
        expect(JSON.stringify(cleanupLogger.error.mock.calls)).not.toContain('secret cache detail')
    })
})
