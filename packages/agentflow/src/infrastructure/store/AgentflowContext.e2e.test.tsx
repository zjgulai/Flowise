import { ReactNode } from 'react'

import { makeFlowEdge, makeFlowNode } from '@test-utils/factories'
import { act, renderHook } from '@testing-library/react'

import type { FlowData } from '@/core/types'

import { AgentflowStateProvider, useAgentflowContext } from './AgentflowContext'

const makeNode = (id: string, type = 'agentFlow') => makeFlowNode(id, { type })
const makeEdge = makeFlowEdge

const createWrapper = (initialFlow?: FlowData) => {
    function Wrapper({ children }: { children: ReactNode }) {
        return <AgentflowStateProvider initialFlow={initialFlow}>{children}</AgentflowStateProvider>
    }
    return Wrapper
}

describe('AgentflowContext E2E', () => {
    describe('composite workflow', () => {
        it('should support add nodes → connect → edit → save lifecycle', () => {
            const initialFlow: FlowData = {
                nodes: [],
                edges: []
            }

            const { result } = renderHook(() => useAgentflowContext(), {
                wrapper: createWrapper(initialFlow)
            })

            // Step 1: Add 3 nodes (simulating what addNode does via setNodes)
            const startNode = makeNode('start-1', 'agentFlow')
            startNode.data = { ...startNode.data, name: 'startAgentflow', label: 'Start' }
            startNode.position = { x: 100, y: 100 }

            const agentNode = makeNode('agent-1', 'agentFlow')
            agentNode.data = { ...agentNode.data, name: 'llmAgentflow', label: 'Agent' }
            agentNode.position = { x: 300, y: 100 }

            const endNode = makeNode('end-1', 'agentFlow')
            endNode.data = { ...endNode.data, name: 'endAgentflow', label: 'End' }
            endNode.position = { x: 500, y: 100 }

            act(() => {
                result.current.setNodes([startNode, agentNode, endNode])
            })

            expect(result.current.state.nodes).toHaveLength(3)

            // Step 2: Connect Start → Agent → End
            act(() => {
                result.current.setEdges([
                    makeEdge('start-1', 'agent-1', { id: 'edge-start-agent', type: 'agentflowEdge' }),
                    makeEdge('agent-1', 'end-1', { id: 'edge-agent-end', type: 'agentflowEdge' })
                ])
            })

            expect(result.current.state.edges).toHaveLength(2)

            // Step 3: Edit agent node parameters
            act(() => {
                result.current.updateNodeData('agent-1', {
                    inputs: { model: 'gpt-4', temperature: 0.7 }
                })
            })

            const updatedAgent = result.current.state.nodes.find((n) => n.id === 'agent-1')
            expect(updatedAgent?.data.inputs).toEqual({ model: 'gpt-4', temperature: 0.7 })

            // Step 4: Verify flow data is complete for save
            const flowData = result.current.getFlowData()
            expect(flowData.nodes).toHaveLength(3)
            expect(flowData.edges).toHaveLength(2)
            expect(flowData.nodes.find((n) => n.id === 'agent-1')?.data.inputs).toEqual({
                model: 'gpt-4',
                temperature: 0.7
            })
        })

        it('should support load → modify → save roundtrip', () => {
            // Simulate loading a saved flow
            const savedFlow: FlowData = {
                nodes: [makeNode('start-1', 'agentFlow'), makeNode('agent-1', 'agentFlow'), makeNode('end-1', 'agentFlow')],
                edges: [
                    makeEdge('start-1', 'agent-1', { id: 'edge-1', type: 'agentflowEdge' }),
                    makeEdge('agent-1', 'end-1', { id: 'edge-2', type: 'agentflowEdge' })
                ]
            }

            const { result } = renderHook(() => useAgentflowContext(), {
                wrapper: createWrapper(savedFlow)
            })

            // Verify loaded correctly
            expect(result.current.state.nodes).toHaveLength(3)
            expect(result.current.state.edges).toHaveLength(2)
            expect(result.current.state.isDirty).toBe(false)

            // Modify: delete the agent node
            act(() => {
                result.current.deleteNode('agent-1')
            })

            // Verify modification
            expect(result.current.state.nodes).toHaveLength(2)
            expect(result.current.state.edges).toHaveLength(0) // both edges removed
            expect(result.current.state.isDirty).toBe(true)

            // Get flow data for save
            const flowData = result.current.getFlowData()
            expect(flowData.nodes).toHaveLength(2)
            expect(flowData.edges).toHaveLength(0)
        })

        it('should sanitize render-only metadata at save while preserving Teams and nested runtime payload fields', () => {
            const createChannelName = 'Create｜customer channel 📣\r\nkeep bytes'
            const updateChannelName = 'Update｜customer channel 🛠️\n保留'
            const runtimePayload = {
                displayLabel: '<user-authored-displayLabel>',
                nested: { displayDescription: 'legitimate runtime field' }
            }
            const teamsNode = makeNode('teams-1', 'agentFlow')
            teamsNode.data = {
                ...teamsNode.data,
                name: 'microsoftTeams',
                label: 'Microsoft Teams',
                displayLabel: '<img src=x onerror="globalThis.pwned=true">',
                displayLocale: 'zh-CN',
                inputParams: [
                    {
                        id: 'teams-1-input-payload-json',
                        name: 'payload',
                        label: 'Payload',
                        displayLabel: '载荷',
                        type: 'json',
                        default: { displayLabel: 'legitimate schema default value' }
                    }
                ],
                outputAnchors: [
                    {
                        id: 'teams-1-output-output-string',
                        name: 'output',
                        label: 'Output',
                        displayLabel: '输出',
                        type: 'string'
                    }
                ],
                inputs: {
                    displayNameCreateChannel: createChannelName,
                    displayNameUpdateChannel: updateChannelName,
                    payload: runtimePayload
                }
            }

            const { result } = renderHook(() => useAgentflowContext(), {
                wrapper: createWrapper({ nodes: [teamsNode], edges: [] })
            })

            const flowData = result.current.getFlowData()
            const savedNodeData = flowData.nodes[0].data

            expect(savedNodeData.displayLabel).toBeUndefined()
            expect(savedNodeData.displayLocale).toBeUndefined()
            expect(savedNodeData.inputParams?.[0].displayLabel).toBeUndefined()
            expect(savedNodeData.outputAnchors?.[0].displayLabel).toBeUndefined()
            expect(savedNodeData.inputParams?.[0].default).toEqual({
                displayLabel: 'legitimate schema default value'
            })
            expect(savedNodeData.inputs?.displayNameCreateChannel).toBe(createChannelName)
            expect(savedNodeData.inputs?.displayNameUpdateChannel).toBe(updateChannelName)
            expect(savedNodeData.inputs?.payload).toEqual(runtimePayload)
            expect(result.current.state.nodes[0].data.displayLabel).toContain('onerror')
        })

        it('should sanitize initial-flow metadata from change callbacks while preserving runtime and edge payloads', () => {
            const runtimePayload = {
                displayLabel: 'legitimate runtime display label',
                nested: { displayDescription: 'legitimate runtime description' }
            }
            const edgePayload = {
                displayLabel: 'legitimate edge display label',
                nested: { displayDescription: 'legitimate edge description' }
            }
            const sourceNode = makeNode('source-1')
            sourceNode.data = {
                ...sourceNode.data,
                displayLabel: '<img src=x onerror="globalThis.pwned=true">',
                displayLocale: 'zh-CN',
                inputParams: [
                    {
                        id: 'source-1-input-payload-json',
                        name: 'payload',
                        label: 'Payload',
                        displayLabel: '载荷',
                        type: 'json',
                        default: { displayLabel: 'legitimate schema default value' }
                    }
                ],
                inputs: { payload: runtimePayload }
            }
            const initialEdge = makeEdge('source-1', 'target-1', { id: 'edge-1' })
            initialEdge.data = edgePayload
            const onFlowChange = jest.fn()
            const { result } = renderHook(() => useAgentflowContext(), {
                wrapper: createWrapper({ nodes: [sourceNode, makeNode('target-1')], edges: [initialEdge] })
            })

            act(() => {
                result.current.registerOnFlowChange(onFlowChange)
                result.current.updateNodeData('source-1', { inputs: { payload: runtimePayload, changed: true } })
            })

            const emittedFlow = onFlowChange.mock.calls[0][0] as FlowData
            const emittedNodeData = emittedFlow.nodes.find((node) => node.id === 'source-1')!.data

            expect(emittedNodeData.displayLabel).toBeUndefined()
            expect(emittedNodeData.displayLocale).toBeUndefined()
            expect(emittedNodeData.inputParams?.[0].displayLabel).toBeUndefined()
            expect(emittedNodeData.inputParams?.[0].default).toEqual({
                displayLabel: 'legitimate schema default value'
            })
            expect(emittedNodeData.inputs).toEqual({ payload: runtimePayload, changed: true })
            expect(emittedFlow.edges[0].data).toEqual(edgePayload)
            expect(result.current.state.nodes[0].data.displayLabel).toContain('onerror')
        })
    })

    describe('multiple edges from single node', () => {
        it('should support multiple outgoing edges from one source node', () => {
            const initialFlow: FlowData = {
                nodes: [makeNode('source'), makeNode('target-a'), makeNode('target-b'), makeNode('target-c')],
                edges: [
                    makeEdge('source', 'target-a', { id: 'edge-a' }),
                    makeEdge('source', 'target-b', { id: 'edge-b' }),
                    makeEdge('source', 'target-c', { id: 'edge-c' })
                ]
            }

            const { result } = renderHook(() => useAgentflowContext(), {
                wrapper: createWrapper(initialFlow)
            })

            expect(result.current.state.edges).toHaveLength(3)

            // All edges should have the same source
            const sourceEdges = result.current.state.edges.filter((e) => e.source === 'source')
            expect(sourceEdges).toHaveLength(3)

            // Deleting one target should only remove its edge
            act(() => {
                result.current.deleteNode('target-b')
            })

            expect(result.current.state.edges).toHaveLength(2)
            expect(result.current.state.edges.map((e) => e.id)).toEqual(['edge-a', 'edge-c'])
        })

        it('should support multiple incoming edges to one target node', () => {
            const initialFlow: FlowData = {
                nodes: [makeNode('source-a'), makeNode('source-b'), makeNode('target')],
                edges: [makeEdge('source-a', 'target', { id: 'edge-a' }), makeEdge('source-b', 'target', { id: 'edge-b' })]
            }

            const { result } = renderHook(() => useAgentflowContext(), {
                wrapper: createWrapper(initialFlow)
            })

            expect(result.current.state.edges).toHaveLength(2)

            // Deleting target removes all incoming edges
            act(() => {
                result.current.deleteNode('target')
            })

            expect(result.current.state.edges).toHaveLength(0)
        })
    })

    describe('rapid connect/disconnect cycles', () => {
        it('should handle rapid edge add/delete cycles without corrupting state', () => {
            const initialFlow: FlowData = {
                nodes: [makeNode('a'), makeNode('b')],
                edges: []
            }

            const { result } = renderHook(() => useAgentflowContext(), {
                wrapper: createWrapper(initialFlow)
            })

            // Perform 10 rapid connect/disconnect cycles
            for (let i = 0; i < 10; i++) {
                act(() => {
                    result.current.setEdges([makeEdge('a', 'b', { id: `edge-${i}`, type: 'agentflowEdge' })])
                })

                expect(result.current.state.edges).toHaveLength(1)
                expect(result.current.state.edges[0].id).toBe(`edge-${i}`)

                act(() => {
                    result.current.deleteEdge(`edge-${i}`)
                })

                expect(result.current.state.edges).toHaveLength(0)
            }

            // Final state: no edges, both nodes intact
            expect(result.current.state.nodes).toHaveLength(2)
            expect(result.current.state.edges).toHaveLength(0)
        })

        it('should handle rapid node delete cycles without orphaned edges', () => {
            const initialFlow: FlowData = {
                nodes: [makeNode('a'), makeNode('b'), makeNode('c')],
                edges: [makeEdge('a', 'b', { id: 'edge-ab' }), makeEdge('b', 'c', { id: 'edge-bc' })]
            }

            const { result } = renderHook(() => useAgentflowContext(), {
                wrapper: createWrapper(initialFlow)
            })

            // Delete middle node
            act(() => {
                result.current.deleteNode('b')
            })

            // No orphaned edges should remain
            expect(result.current.state.edges).toHaveLength(0)

            // Remaining nodes should be intact
            expect(result.current.state.nodes).toHaveLength(2)
            expect(result.current.state.nodes.map((n) => n.id)).toEqual(['a', 'c'])

            // Verify no edge references deleted nodes
            for (const edge of result.current.state.edges) {
                const nodeIds = result.current.state.nodes.map((n) => n.id)
                expect(nodeIds).toContain(edge.source)
                expect(nodeIds).toContain(edge.target)
            }
        })
    })

    describe('edge deletion', () => {
        it('should delete a specific edge without affecting other edges', () => {
            const initialFlow: FlowData = {
                nodes: [makeNode('a'), makeNode('b'), makeNode('c')],
                edges: [makeEdge('a', 'b', { id: 'edge-1' }), makeEdge('b', 'c', { id: 'edge-2' })]
            }

            const { result } = renderHook(() => useAgentflowContext(), {
                wrapper: createWrapper(initialFlow)
            })

            act(() => {
                result.current.deleteEdge('edge-1')
            })

            expect(result.current.state.edges).toHaveLength(1)
            expect(result.current.state.edges[0].id).toBe('edge-2')

            // All nodes should still exist
            expect(result.current.state.nodes).toHaveLength(3)
        })

        it('should mark state as dirty when edge is deleted', () => {
            const initialFlow: FlowData = {
                nodes: [makeNode('a'), makeNode('b')],
                edges: [makeEdge('a', 'b', { id: 'edge-1' })]
            }

            const { result } = renderHook(() => useAgentflowContext(), {
                wrapper: createWrapper(initialFlow)
            })

            expect(result.current.state.isDirty).toBe(false)

            act(() => {
                result.current.deleteEdge('edge-1')
            })

            expect(result.current.state.isDirty).toBe(true)
        })
    })
})
