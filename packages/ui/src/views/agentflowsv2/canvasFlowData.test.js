import {
    applyImportedAgentflowCanvasData,
    applyParsedAgentflowCanvasData,
    isCurrentAgentflowSaveRequest,
    isExpectedAgentflowResource,
    isExpectedAgentflowSaveResponse,
    parseAgentflowCanvasData
} from './canvasFlowData'

const invalidFlowData = [
    ['empty object', '{}'],
    ['null', 'null'],
    ['array', '[]'],
    ['number', '42'],
    ['boolean', 'true'],
    ['string', '"flow"'],
    ['missing edges', '{"nodes":[]}'],
    ['missing nodes', '{"edges":[]}'],
    ['object nodes', '{"nodes":{},"edges":[]}'],
    ['object edges', '{"nodes":[],"edges":{}}'],
    ['null node', '{"nodes":[null],"edges":[]}'],
    ['primitive node', '{"nodes":[7],"edges":[]}'],
    ['node without id', '{"nodes":[{"data":{}}],"edges":[]}'],
    ['node with numeric id', '{"nodes":[{"id":1,"data":{}}],"edges":[]}'],
    ['node with blank id', '{"nodes":[{"id":"  ","data":{}}],"edges":[]}'],
    ['node with array data', '{"nodes":[{"id":"node-1","data":[]}],"edges":[]}'],
    ['node with null data', '{"nodes":[{"id":"node-1","data":null}],"edges":[]}'],
    ['node with array inputs', '{"nodes":[{"id":"node-1","data":{"inputs":[]}}],"edges":[]}'],
    ['node with object inputParams', '{"nodes":[{"id":"node-1","data":{"inputParams":{}}}],"edges":[]}'],
    ['node with null inputParam', '{"nodes":[{"id":"node-1","data":{"inputParams":[null]}}],"edges":[]}'],
    ['duplicate node id', '{"nodes":[{"id":"node-1","data":{}},{"id":"node-1","data":{}}],"edges":[]}'],
    ['null edge', '{"nodes":[],"edges":[null]}'],
    ['primitive edge', '{"nodes":[],"edges":[7]}'],
    ['edge without source', '{"nodes":[],"edges":[{"target":"node-2"}]}'],
    ['edge with numeric source', '{"nodes":[],"edges":[{"source":1,"target":"node-2"}]}'],
    ['edge with blank source', '{"nodes":[],"edges":[{"source":" ","target":"node-2"}]}'],
    ['edge without target', '{"nodes":[],"edges":[{"source":"node-1"}]}'],
    ['edge with blank target', '{"nodes":[],"edges":[{"source":"node-1","target":"\t"}]}'],
    ['edge with missing endpoint', '{"nodes":[{"id":"node-1","data":{}}],"edges":[{"source":"missing","target":"node-1"}]}'],
    ['edge with blank id', '{"nodes":[{"id":"node-1","data":{}}],"edges":[{"id":" ","source":"node-1","target":"node-1"}]}'],
    [
        'duplicate edge id',
        '{"nodes":[{"id":"node-1","data":{}}],"edges":[{"id":"edge-1","source":"node-1","target":"node-1"},{"id":"edge-1","source":"node-1","target":"node-1"}]}'
    ]
]

describe('agentflow canvas data parsing', () => {
    it.each(invalidFlowData)('rejects %s', (_label, serializedFlowData) => {
        expect(() => parseAgentflowCanvasData(serializedFlowData)).toThrow()
    })

    it('preserves valid historical React Flow fields while removing render-only display metadata', () => {
        const historicalFlow = {
            nodes: [
                {
                    id: 'conditionAgentflow_0',
                    type: 'agentFlow',
                    position: { x: 100, y: 200 },
                    positionAbsolute: { x: 300, y: 400 },
                    parentNode: 'iterationAgentflow_0',
                    extent: 'parent',
                    data: {
                        name: 'conditionAgentflow',
                        label: 'Condition',
                        displayLabel: '条件',
                        inputs: { expression: 'true' }
                    }
                },
                {
                    id: 'agentAgentflow_0',
                    data: { name: 'agentAgentflow', inputs: {}, inputParams: [] }
                }
            ],
            edges: [
                {
                    id: 'conditionAgentflow_0-output-agentAgentflow_0',
                    source: 'conditionAgentflow_0',
                    sourceHandle: 'conditionAgentflow_0-output-0',
                    target: 'agentAgentflow_0',
                    targetHandle: null,
                    type: 'agentFlow',
                    data: { edgeLabel: '0' }
                }
            ],
            viewport: { x: 1, y: 2, zoom: 0.75 }
        }

        expect(parseAgentflowCanvasData(JSON.stringify(historicalFlow))).toEqual({
            ...historicalFlow,
            nodes: [
                {
                    ...historicalFlow.nodes[0],
                    data: {
                        name: 'conditionAgentflow',
                        label: 'Condition',
                        inputs: { expression: 'true' },
                        inputParams: []
                    }
                },
                {
                    id: 'agentAgentflow_0',
                    data: { name: 'agentAgentflow', inputs: {}, inputParams: [] }
                }
            ]
        })
    })

    it('normalizes optional node fields required by save and double-click paths', () => {
        expect(parseAgentflowCanvasData('{"nodes":[{"id":"node-1","data":{}}],"edges":[]}')).toEqual({
            nodes: [{ id: 'node-1', data: { inputs: {}, inputParams: [] } }],
            edges: []
        })
    })
})

describe('agentflow canvas data loading', () => {
    it('clears the canvas, reports a safe error, and skips parsed-data callbacks when data is invalid', () => {
        const setNodes = jest.fn()
        const setEdges = jest.fn()
        const onParsed = jest.fn()
        const onError = jest.fn()

        const applied = applyParsedAgentflowCanvasData({
            serializedFlowData: '{"nodes":[null],"edges":[]}',
            setNodes,
            setEdges,
            onParsed,
            onError
        })

        expect(applied).toBe(false)
        expect(setNodes).toHaveBeenCalledWith([])
        expect(setEdges).toHaveBeenCalledWith([])
        expect(onParsed).not.toHaveBeenCalled()
        expect(onError).toHaveBeenCalledWith('流程数据格式无效，请重新导入或刷新后重试')
    })

    it('passes sanitized parsed data to the success callback without clearing the canvas', () => {
        const setNodes = jest.fn()
        const setEdges = jest.fn()
        const onParsed = jest.fn()
        const onError = jest.fn()

        const applied = applyParsedAgentflowCanvasData({
            serializedFlowData: JSON.stringify({
                nodes: [{ id: 'node-1', data: { displayLabel: '旧展示值', label: 'Raw label' } }],
                edges: []
            }),
            setNodes,
            setEdges,
            onParsed,
            onError
        })

        expect(applied).toBe(true)
        expect(onParsed).toHaveBeenCalledWith({
            nodes: [{ id: 'node-1', data: { label: 'Raw label', inputs: {}, inputParams: [] } }],
            edges: []
        })
        expect(setNodes).not.toHaveBeenCalled()
        expect(setEdges).not.toHaveBeenCalled()
        expect(onError).not.toHaveBeenCalled()
    })
})

describe('agentflow canvas imports', () => {
    it('preserves the current graph and dirty state when an imported flow is invalid', () => {
        const setNodes = jest.fn()
        const setEdges = jest.fn()
        const onDirty = jest.fn()
        const onError = jest.fn()

        expect(
            applyImportedAgentflowCanvasData({
                serializedFlowData: '{}',
                setNodes,
                setEdges,
                onDirty,
                onError
            })
        ).toBe(false)
        expect(setNodes).not.toHaveBeenCalled()
        expect(setEdges).not.toHaveBeenCalled()
        expect(onDirty).not.toHaveBeenCalled()
        expect(onError).toHaveBeenCalledWith('导入流程失败，请检查文件格式')
    })

    it('replaces the graph and marks it dirty only after a valid import', () => {
        const setNodes = jest.fn()
        const setEdges = jest.fn()
        const onDirty = jest.fn()
        const onError = jest.fn()
        const nodes = [
            { id: 'node-1', data: {} },
            { id: 'node-2', data: {} }
        ]
        const edges = [{ source: 'node-1', target: 'node-2' }]

        expect(
            applyImportedAgentflowCanvasData({
                serializedFlowData: JSON.stringify({ nodes, edges }),
                setNodes,
                setEdges,
                onDirty,
                onError
            })
        ).toBe(true)
        expect(setNodes).toHaveBeenCalledWith([
            { id: 'node-1', data: { inputs: {}, inputParams: [] } },
            { id: 'node-2', data: { inputs: {}, inputParams: [] } }
        ])
        expect(setEdges).toHaveBeenCalledWith(edges)
        expect(onDirty).toHaveBeenCalledTimes(1)
        expect(onError).not.toHaveBeenCalled()
    })
})

describe('agentflow resource identity', () => {
    it('accepts only an unsaved AGENTFLOW draft on a new route or the exact requested persisted flow', () => {
        expect(isExpectedAgentflowResource(undefined, { type: 'AGENTFLOW', name: 'draft' })).toBe(true)
        expect(isExpectedAgentflowResource('', { type: 'AGENTFLOW', name: 'draft' })).toBe(true)
        expect(isExpectedAgentflowResource(undefined, { id: 'flow-a', type: 'AGENTFLOW' })).toBe(false)
        expect(isExpectedAgentflowResource(undefined, { id: '', type: 'AGENTFLOW' })).toBe(false)
        expect(isExpectedAgentflowResource(undefined, { id: null, type: 'AGENTFLOW' })).toBe(false)
        expect(isExpectedAgentflowResource(undefined, { type: 'CHATFLOW' })).toBe(false)
        expect(isExpectedAgentflowResource(undefined, { type: 'ASSISTANT' })).toBe(false)
        expect(isExpectedAgentflowResource(undefined, null)).toBe(false)
        expect(isExpectedAgentflowResource('flow-a', { id: 'flow-a', type: 'AGENTFLOW' })).toBe(true)
        expect(isExpectedAgentflowResource('flow-a', { id: 'flow-b', type: 'AGENTFLOW' })).toBe(false)
        expect(isExpectedAgentflowResource('flow-a', { id: 'flow-a', type: 'CHATFLOW' })).toBe(false)
        expect(isExpectedAgentflowResource('flow-a', { id: 'flow-a', type: 'ASSISTANT' })).toBe(false)
        expect(isExpectedAgentflowResource('flow-a', null)).toBe(false)
    })

    it('binds update completion to the exact route generation and resource identity', () => {
        const context = { kind: 'update', routeId: 'flow-a', routeGeneration: 7 }

        expect(isCurrentAgentflowSaveRequest({ context, kind: 'update', activeRouteId: 'flow-a', activeGeneration: 7 })).toBe(true)
        expect(
            isExpectedAgentflowSaveResponse({
                context,
                activeRouteId: 'flow-a',
                activeGeneration: 7,
                response: { id: 'flow-a', type: 'AGENTFLOW' }
            })
        ).toBe(true)
        expect(
            isExpectedAgentflowSaveResponse({
                context,
                activeRouteId: 'flow-b',
                activeGeneration: 8,
                response: { id: 'flow-a', type: 'AGENTFLOW' }
            })
        ).toBe(false)
        expect(
            isExpectedAgentflowSaveResponse({
                context,
                activeRouteId: 'flow-a',
                activeGeneration: 7,
                response: { id: 'flow-b', type: 'AGENTFLOW' }
            })
        ).toBe(false)
    })

    it('accepts a create completion only while the same new-route generation remains active', () => {
        const context = { kind: 'create', routeId: '', routeGeneration: 3 }
        const response = { id: 'created-flow', type: 'AGENTFLOW' }

        expect(isExpectedAgentflowSaveResponse({ context, activeRouteId: '', activeGeneration: 3, response })).toBe(true)
        expect(isExpectedAgentflowSaveResponse({ context, activeRouteId: 'flow-b', activeGeneration: 4, response })).toBe(false)
        expect(
            isExpectedAgentflowSaveResponse({
                context,
                activeRouteId: '',
                activeGeneration: 3,
                response: { id: '', type: 'AGENTFLOW' }
            })
        ).toBe(false)
        expect(
            isExpectedAgentflowSaveResponse({
                context,
                activeRouteId: '',
                activeGeneration: 3,
                response: { id: 'created-flow', type: 'CHATFLOW' }
            })
        ).toBe(false)
    })
})
