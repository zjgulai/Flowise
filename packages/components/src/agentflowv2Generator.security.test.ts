import fs from 'fs'
import path from 'path'

const mockSafeModelInit = jest.fn(async (_nodeData: unknown, _input: unknown, _options: unknown) => ({
    invoke: jest.fn(async () => ({ content: JSON.stringify({ nodes: [], edges: [] }) }))
}))
const mockUnsafeModelInit = jest.fn()

jest.mock(
    'safe-agentflow-chat-model',
    () => ({
        nodeClass: class {
            init(...args: [unknown, unknown, unknown]) {
                return mockSafeModelInit(...args)
            }
        }
    }),
    { virtual: true }
)

jest.mock(
    'unsafe-agentflow-component',
    () => ({
        nodeClass: class {
            init(...args: unknown[]) {
                return mockUnsafeModelInit(...args)
            }
        }
    }),
    { virtual: true }
)

import { generateAgentflowv2, resolveSafeChatModelSelection } from './agentflowv2Generator'

const validComponent = {
    name: 'safeChatModel',
    category: 'Chat Models',
    baseClasses: ['BaseChatModel'],
    filePath: 'safe-agentflow-chat-model',
    inputs: [{ name: 'modelName' }]
}

describe('Agentflow V2 chat model execution boundary', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it('strictly resolves and minimizes a legitimate BaseChatModel selection', () => {
        expect(
            resolveSafeChatModelSelection(
                { safeChatModel: validComponent },
                { name: 'safeChatModel', inputs: { modelName: 'gpt-safe' }, credential: 'credential-1', ignoredTopLevel: 'drop' }
            )
        ).toEqual({
            component: validComponent,
            nodeData: {
                id: 'safeChatModel_0',
                name: 'safeChatModel',
                inputs: { modelName: 'gpt-safe' },
                credential: 'credential-1'
            },
            credentialId: 'credential-1'
        })
    })

    it.each([
        ['unknown component', {}, { name: 'missing', inputs: {} }],
        [
            'custom function component',
            {
                customFunction: {
                    name: 'customFunction',
                    category: 'Utilities',
                    baseClasses: ['BaseChatModel'],
                    filePath: 'unsafe-agentflow-component',
                    inputs: []
                }
            },
            { name: 'customFunction', inputs: {} }
        ],
        [
            'forged chat model without BaseChatModel',
            {
                customFunction: {
                    name: 'customFunction',
                    category: 'Chat Models',
                    baseClasses: ['Tool'],
                    filePath: 'unsafe-agentflow-component',
                    inputs: []
                }
            },
            { name: 'customFunction', inputs: {} }
        ],
        ['missing inputs', { safeChatModel: validComponent }, { name: 'safeChatModel' }],
        [
            'unregistered input',
            { safeChatModel: validComponent },
            { name: 'safeChatModel', inputs: { modelName: 'gpt-safe', code: 'sentinel()' } }
        ]
    ])('rejects %s before component initialization', async (_label, componentNodes, selectedChatModel) => {
        await expect(
            generateAgentflowv2({ componentNodes, selectedChatModel, prompt: 'safe', toolNodes: '[]' }, 'question', {
                workspaceId: 'workspace-1'
            })
        ).resolves.toEqual({ error: 'Agentflow generation failed' })

        expect(mockUnsafeModelInit).not.toHaveBeenCalled()
        expect(mockSafeModelInit).not.toHaveBeenCalled()
    })

    it('initializes a legitimate model with minimized data and variable loading disabled', async () => {
        await expect(
            generateAgentflowv2(
                {
                    componentNodes: { safeChatModel: validComponent },
                    selectedChatModel: { name: 'safeChatModel', inputs: { modelName: 'gpt-safe' }, credential: 'credential-1' },
                    prompt: 'safe',
                    toolNodes: '[]'
                },
                'question',
                { workspaceId: 'workspace-1', skipVariables: false }
            )
        ).resolves.toEqual({ nodes: [], edges: [] })

        expect(mockSafeModelInit).toHaveBeenCalledWith(
            {
                id: 'safeChatModel_0',
                name: 'safeChatModel',
                inputs: { modelName: 'gpt-safe' },
                credential: 'credential-1'
            },
            '',
            expect.objectContaining({ workspaceId: 'workspace-1', skipVariables: true })
        )
    })

    it('guards both dynamic import sites with the strict resolver', () => {
        const source = fs.readFileSync(path.join(__dirname, 'agentflowv2Generator.ts'), 'utf8')
        const toolBlock = source.slice(source.indexOf('const _generateSelectedTools'), source.indexOf('const generateNodesEdges'))
        const nodeBlock = source.slice(source.indexOf('const generateNodesEdges'), source.indexOf('const generateNodesData'))

        for (const block of [toolBlock, nodeBlock]) {
            expect(block).toContain('resolveSafeChatModelSelection')
            expect(block.indexOf('resolveSafeChatModelSelection')).toBeLessThan(block.indexOf('await import'))
        }
    })
})
