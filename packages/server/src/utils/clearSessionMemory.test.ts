import { DataSource } from 'typeorm'
import { IComponentNodes, IReactFlowNode } from '../Interface'

const mockClearChatMessages = jest.fn()
const mockOpenAIClearChatMessages = jest.fn()
const mockGetChatMessages = jest.fn()
const mockInit = jest.fn(async (..._args: unknown[]) => ({
    clearChatMessages: mockClearChatMessages,
    getChatMessages: mockGetChatMessages
}))

jest.mock(
    'workspace-scoped-memory-node',
    () => ({
        nodeClass: class {
            init(...args: unknown[]) {
                return mockInit(...args)
            }
        }
    }),
    { virtual: true }
)

jest.mock(
    'workspace-scoped-openai-node',
    () => ({
        nodeClass: class {
            clearChatMessages(...args: unknown[]) {
                return mockOpenAIClearChatMessages(...args)
            }
        }
    }),
    { virtual: true }
)

jest.mock('./logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}))

import { clearSessionMemory, getSessionChatHistory } from '.'

describe('clearSessionMemory workspace credential scope', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it('passes the active workspace to memory node initialization', async () => {
        const nodes = [
            {
                data: {
                    category: 'Memory',
                    type: 'Memory',
                    name: 'testMemory',
                    label: 'Test Memory',
                    inputs: {}
                }
            }
        ] as unknown as IReactFlowNode[]
        const componentNodes = {
            testMemory: { filePath: 'workspace-scoped-memory-node' }
        } as unknown as IComponentNodes

        await clearSessionMemory(
            nodes,
            componentNodes,
            'chat-1',
            {} as DataSource,
            'organization-1',
            'session-1',
            undefined,
            undefined,
            'workspace-1',
            'flow-1'
        )

        expect(mockInit).toHaveBeenCalledWith(
            nodes[0].data,
            '',
            expect.objectContaining({
                orgId: 'organization-1',
                workspaceId: 'workspace-1',
                chatflowid: 'flow-1',
                chatId: 'chat-1'
            })
        )
        expect(mockClearChatMessages).toHaveBeenCalledWith('session-1')
    })

    it('passes workspace and chatflow ownership context to legacy OpenAI cleanup', async () => {
        const nodes = [
            {
                data: {
                    category: 'Agents',
                    type: 'OpenAIAssistant',
                    name: 'openAIAssistant',
                    label: 'OpenAI Assistant',
                    inputs: { selectedAssistant: 'assistant-1' }
                }
            }
        ] as unknown as IReactFlowNode[]
        const componentNodes = {
            openAIAssistant: { filePath: 'workspace-scoped-openai-node' }
        } as unknown as IComponentNodes

        await clearSessionMemory(
            nodes,
            componentNodes,
            'chat-1',
            {} as DataSource,
            'organization-1',
            'thread-1',
            undefined,
            undefined,
            'workspace-1',
            'flow-1'
        )

        expect(mockOpenAIClearChatMessages).toHaveBeenCalledWith(
            nodes[0].data,
            expect.objectContaining({
                orgId: 'organization-1',
                workspaceId: 'workspace-1',
                chatflowid: 'flow-1',
                chatId: 'chat-1'
            }),
            { type: 'threadId', id: 'thread-1' }
        )
    })

    it('passes the active workspace to memory node history reads', async () => {
        mockGetChatMessages.mockResolvedValue([{ role: 'userMessage', content: 'hello' }])
        const memoryNode = {
            data: {
                category: 'Memory',
                type: 'Memory',
                name: 'testMemory',
                label: 'Test Memory',
                inputs: {}
            }
        } as unknown as IReactFlowNode
        const componentNodes = {
            testMemory: { filePath: 'workspace-scoped-memory-node' }
        } as unknown as IComponentNodes

        await expect(
            getSessionChatHistory(
                'flow-1',
                'session-1',
                memoryNode,
                componentNodes,
                {} as DataSource,
                {} as never,
                {},
                [],
                'workspace-1',
                'organization-1'
            )
        ).resolves.toEqual([{ role: 'userMessage', content: 'hello' }])

        expect(mockInit).toHaveBeenCalledWith(
            memoryNode.data,
            '',
            expect.objectContaining({
                chatflowid: 'flow-1',
                workspaceId: 'workspace-1',
                orgId: 'organization-1'
            })
        )
    })
})
