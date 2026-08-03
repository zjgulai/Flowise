import { ChatMessage } from '../database/entities/ChatMessage'
import { clearScopedChatMessageAction } from './scopedChatMessageAction'

type TestMessage = Pick<ChatMessage, 'id' | 'chatflowid' | 'chatId' | 'sessionId' | 'executionId' | 'action' | 'createdDate'>

const createRepository = (rows: TestMessage[]) => {
    const find = jest.fn(async ({ where }: any) => {
        const scopes = Array.isArray(where) ? where : [where]
        return rows
            .filter((row) =>
                scopes.some((scope: Record<string, unknown>) =>
                    Object.entries(scope).every(([key, expected]) => row[key as keyof TestMessage] === expected)
                )
            )
            .sort((left, right) => right.createdDate.getTime() - left.createdDate.getTime()) as ChatMessage[]
    })
    const update = jest.fn(async (criteria: Record<string, unknown>, patch: Partial<ChatMessage>) => {
        const row = rows.find((candidate) =>
            Object.entries(criteria).every(([key, expected]) => candidate[key as keyof TestMessage] === expected)
        )
        if (!row) return { affected: 0, raw: [], generatedMaps: [] }
        Object.assign(row, patch)
        return { affected: 1, raw: [], generatedMaps: [] }
    })

    return { repository: { find, update } as any, find, update }
}

const message = (overrides: Partial<TestMessage>): TestMessage => ({
    id: 'message-a',
    chatflowid: 'flow-a',
    chatId: 'shared-chat',
    sessionId: 'shared-session',
    executionId: 'execution-a',
    action: JSON.stringify({ id: 'action-a' }),
    createdDate: new Date('2026-08-02T00:00:00.000Z'),
    ...overrides
})

describe('clearScopedChatMessageAction', () => {
    it('clears only the current V2 flow and execution when chat and session identifiers collide', async () => {
        const rows = [
            message({ id: 'victim-flow', chatflowid: 'flow-b', executionId: 'execution-b' }),
            message({ id: 'victim-execution', executionId: 'execution-b' }),
            message({ id: 'owned', createdDate: new Date('2026-08-02T00:00:02.000Z') })
        ]
        const { repository, update } = createRepository(rows)

        await expect(
            clearScopedChatMessageAction(repository, {
                chatflowId: 'flow-a',
                executionId: 'execution-a',
                chatId: 'shared-chat',
                sessionId: 'shared-session'
            })
        ).resolves.toBe(true)

        expect(rows.find((row) => row.id === 'owned')?.action).toBeNull()
        expect(rows.find((row) => row.id === 'victim-flow')?.action).not.toBeNull()
        expect(rows.find((row) => row.id === 'victim-execution')?.action).not.toBeNull()
        expect(update).toHaveBeenCalledWith(expect.objectContaining({ id: 'owned', chatflowid: 'flow-a', executionId: 'execution-a' }), {
            action: null
        })
    })

    it('matches the legacy action id but never clears the same id in another flow', async () => {
        const rows = [
            message({ id: 'victim', chatflowid: 'flow-b' }),
            message({ id: 'wrong-action', action: JSON.stringify({ id: 'action-b' }) }),
            message({ id: 'owned', executionId: undefined })
        ]
        const { repository } = createRepository(rows)

        await expect(
            clearScopedChatMessageAction(repository, {
                chatflowId: 'flow-a',
                chatId: 'shared-chat',
                sessionId: 'shared-session',
                actionId: 'action-a'
            })
        ).resolves.toBe(true)

        expect(rows.find((row) => row.id === 'owned')?.action).toBeNull()
        expect(rows.find((row) => row.id === 'victim')?.action).not.toBeNull()
        expect(rows.find((row) => row.id === 'wrong-action')?.action).not.toBeNull()
    })

    it('performs no update for an invalid or missing owned action', async () => {
        const rows = [message({ id: 'victim', chatflowid: 'flow-b' })]
        const { repository, update } = createRepository(rows)

        await expect(
            clearScopedChatMessageAction(repository, {
                chatflowId: 'flow-a',
                chatId: 'shared-chat',
                sessionId: 'shared-session',
                actionId: 'action-a'
            })
        ).resolves.toBe(false)
        await expect(
            clearScopedChatMessageAction(repository, {
                chatflowId: 'flow-a',
                chatId: 'shared-chat',
                actionId: { attacker: true }
            })
        ).resolves.toBe(false)

        expect(update).not.toHaveBeenCalled()
    })
})
