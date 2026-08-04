import {
    canonicalizeSameOriginFlowReferencesForExport,
    extractTypedFlowReferencesForImport,
    remapFlowReferencesForImport
} from './flowReferenceImport'

const IDS = {
    agent: '11111111-1111-4111-8111-111111111111',
    chat: '22222222-2222-4222-8222-222222222222',
    execute: '33333333-3333-4333-8333-333333333333',
    sequential: '44444444-4444-4444-8444-444444444444'
}

const makeFlowData = () =>
    JSON.stringify({
        nodes: [
            { data: { name: 'agentAsTool', inputs: { selectedAgentflow: IDS.agent, prompt: `keep:${IDS.agent}` } } },
            { data: { name: 'ChatflowTool', inputs: { selectedChatflow: IDS.chat } } },
            { data: { name: 'executeFlowAgentflow', inputs: { executeFlowSelectedFlow: IDS.execute } } },
            { data: { name: 'seqExecuteFlow', inputs: { selectedFlow: IDS.sequential } } },
            {
                data: {
                    name: 'agentAgentflow',
                    inputs: {
                        agentTools: [
                            {
                                agentSelectedTool: 'ChatflowTool',
                                agentSelectedToolConfig: { selectedChatflow: IDS.chat, baseURL: '' }
                            }
                        ]
                    }
                }
            },
            {
                data: {
                    name: 'toolAgentflow',
                    inputs: {
                        toolAgentflowSelectedTool: 'agentAsTool',
                        toolAgentflowSelectedToolConfig: { selectedAgentflow: IDS.agent, baseURL: '' }
                    }
                }
            }
        ],
        edges: []
    })

describe('typed flow references for workspace import', () => {
    it('extracts all runtime flow references with the agent type constraint', () => {
        expect(extractTypedFlowReferencesForImport(makeFlowData())).toEqual([
            { targetId: IDS.agent, expectedType: 'AGENTFLOW' },
            { targetId: IDS.chat },
            { targetId: IDS.execute },
            { targetId: IDS.sequential },
            { targetId: IDS.chat },
            { targetId: IDS.agent, expectedType: 'AGENTFLOW' }
        ])
    })

    it('remaps only typed reference fields and preserves arbitrary user text', () => {
        const replacements = new Map(Object.values(IDS).map((id, index) => [id, `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${index}`]))
        const remapped = JSON.parse(remapFlowReferencesForImport(makeFlowData(), replacements))

        expect(remapped.nodes[0].data.inputs.selectedAgentflow).toBe(replacements.get(IDS.agent))
        expect(remapped.nodes[1].data.inputs.selectedChatflow).toBe(replacements.get(IDS.chat))
        expect(remapped.nodes[2].data.inputs.executeFlowSelectedFlow).toBe(replacements.get(IDS.execute))
        expect(remapped.nodes[3].data.inputs.selectedFlow).toBe(replacements.get(IDS.sequential))
        expect(remapped.nodes[4].data.inputs.agentTools[0].agentSelectedToolConfig.selectedChatflow).toBe(replacements.get(IDS.chat))
        expect(remapped.nodes[5].data.inputs.toolAgentflowSelectedToolConfig.selectedAgentflow).toBe(replacements.get(IDS.agent))
        expect(remapped.nodes[0].data.inputs.prompt).toBe(`keep:${IDS.agent}`)
    })

    it('rejects a malformed configured reference but permits an unconfigured draft node', () => {
        expect(() =>
            extractTypedFlowReferencesForImport(
                JSON.stringify({ nodes: [{ data: { name: 'ChatflowTool', inputs: { selectedChatflow: 'bad' } } }] })
            )
        ).toThrow('Invalid workspace import')
        expect(
            extractTypedFlowReferencesForImport(
                JSON.stringify({ nodes: [{ data: { name: 'ChatflowTool', inputs: { selectedChatflow: '' } } }] })
            )
        ).toEqual([])
    })

    it('preserves an explicit external flow target without treating it as a local relation', () => {
        const externalFlowData = JSON.stringify({
            nodes: [
                {
                    data: {
                        name: 'ChatflowTool',
                        inputs: { selectedChatflow: IDS.chat, baseURL: 'https://external.example.com' }
                    }
                }
            ]
        })
        expect(extractTypedFlowReferencesForImport(externalFlowData)).toEqual([])
        expect(remapFlowReferencesForImport(externalFlowData, new Map([[IDS.chat, IDS.agent]]))).toBe(externalFlowData)
    })

    it.each([
        ['userinfo', 'https://user:password@external.example.invalid'],
        ['query', 'https://external.example.invalid/?apiKey=secret'],
        ['path', 'https://external.example.invalid/api/v1']
    ])('rejects an invalid %s external base URL', (_name, baseURL) => {
        const flowData = JSON.stringify({
            nodes: [{ data: { name: 'ChatflowTool', inputs: { selectedChatflow: IDS.chat, baseURL } } }],
            edges: []
        })
        expect(() => extractTypedFlowReferencesForImport(flowData, 'https://flowise.example.invalid')).toThrow('Invalid workspace import')
    })

    it('validates an external selected-flow ID even though the reference is not included locally', () => {
        const flowData = JSON.stringify({
            nodes: [
                {
                    data: {
                        name: 'ChatflowTool',
                        inputs: { selectedChatflow: 'not-a-uuid', baseURL: 'https://external.example.invalid' }
                    }
                }
            ],
            edges: []
        })
        expect(() => extractTypedFlowReferencesForImport(flowData, 'https://flowise.example.invalid')).toThrow('Invalid workspace import')
    })

    it('includes and canonicalizes an explicit source-site reference while preserving a truly external target', () => {
        const canonicalOrigin = 'https://flowise.example.invalid'
        const flowData = JSON.stringify({
            nodes: [
                {
                    data: {
                        name: 'ChatflowTool',
                        inputs: { selectedChatflow: IDS.chat, baseURL: canonicalOrigin }
                    }
                },
                {
                    data: {
                        name: 'ChatflowTool',
                        inputs: { selectedChatflow: IDS.agent, baseURL: 'https://external.example.invalid' }
                    }
                }
            ],
            edges: []
        })

        expect(extractTypedFlowReferencesForImport(flowData, canonicalOrigin)).toEqual([{ targetId: IDS.chat }])
        const canonicalized = JSON.parse(canonicalizeSameOriginFlowReferencesForExport(flowData, canonicalOrigin))
        expect(canonicalized.nodes[0].data.inputs.baseURL).toBe('')
        expect(canonicalized.nodes[1].data.inputs.baseURL).toBe('https://external.example.invalid')
    })

    it('mirrors Tool wrapper name/config fallback and removes inactive alias configuration', () => {
        const flowData = JSON.stringify({
            nodes: [
                {
                    data: {
                        name: 'toolAgentflow',
                        inputs: {
                            selectedTool: 'ChatflowTool',
                            toolAgentflowSelectedTool: 'agentAsTool',
                            toolAgentflowSelectedToolConfig: { selectedChatflow: IDS.chat, staleSecret: 'remove-me' }
                        }
                    }
                },
                {
                    data: {
                        name: 'toolAgentflow',
                        inputs: { selectedToolConfig: { mcpServerConfig: 'stale' } }
                    }
                }
            ],
            edges: []
        })

        const remapped = JSON.parse(remapFlowReferencesForImport(flowData, new Map([[IDS.chat, IDS.agent]])))
        expect(remapped.nodes[0].data.inputs).toEqual({
            selectedTool: 'ChatflowTool',
            selectedToolConfig: { selectedChatflow: IDS.agent, staleSecret: 'remove-me' }
        })
        expect(remapped.nodes[1].data.inputs).toEqual({})
    })
})
