import { makeFlowNode, makeNodeData } from '@test-utils/factories'
import { act, renderHook } from '@testing-library/react'

import type { FlowNode, NodeData } from '@/core/types'
import { checkNodePlacementConstraints } from '@/core/validation'

// --- Tests ---
import { DROP_OFFSET_X, DROP_OFFSET_Y, useDragAndDrop } from './useDragAndDrop'

// --- Mocks ---
const mockSetDirty = jest.fn()
const mockScreenToFlowPosition = jest.fn((pos: { x: number; y: number }) => pos)

jest.mock('reactflow', () => ({
    ...jest.requireActual('reactflow'),
    useReactFlow: () => ({
        screenToFlowPosition: mockScreenToFlowPosition
    })
}))

jest.mock('@/infrastructure/store', () => ({
    useAgentflowContext: () => ({
        setDirty: mockSetDirty
    })
}))

jest.mock('@/core', () => ({
    getUniqueNodeId: jest.fn((_data: NodeData, _nodes: FlowNode[]) => 'new-node-1'),
    getUniqueNodeLabel: jest.fn((_data: NodeData, _nodes: FlowNode[]) => 'New Node 1'),
    initNode: jest.fn((data: NodeData, id: string) => ({ ...data, id })),
    resolveNodeType: jest.fn(() => 'agentflowNode')
}))

jest.mock('@/core/validation', () => ({
    checkNodePlacementConstraints: jest.fn(() => ({ valid: true })),
    findParentIterationNode: jest.fn(() => null)
}))

function makeDragEvent(data?: string): React.DragEvent {
    return {
        preventDefault: jest.fn(),
        dataTransfer: {
            getData: jest.fn(() => data ?? ''),
            dropEffect: ''
        },
        clientX: 300,
        clientY: 400
    } as unknown as React.DragEvent
}

describe('useDragAndDrop', () => {
    let nodes: FlowNode[]
    let setLocalNodes: jest.Mock
    let reactFlowWrapper: { current: HTMLDivElement | null }

    beforeEach(() => {
        jest.clearAllMocks()
        nodes = [makeFlowNode('a')]
        setLocalNodes = jest.fn()
        reactFlowWrapper = {
            current: {
                getBoundingClientRect: () => ({ left: 50, top: 50, width: 800, height: 600 })
            } as HTMLDivElement
        }
    })

    function renderUseDragAndDrop(overrides = {}) {
        return renderHook(() => useDragAndDrop({ nodes, setLocalNodes, reactFlowWrapper, ...overrides }))
    }

    describe('handleDragOver', () => {
        it('should prevent default and set dropEffect to move', () => {
            const { result } = renderUseDragAndDrop()
            const event = makeDragEvent()

            act(() => {
                result.current.handleDragOver(event)
            })

            expect(event.preventDefault).toHaveBeenCalled()
            expect(event.dataTransfer.dropEffect).toBe('move')
        })
    })

    describe('handleDrop', () => {
        const nodeData = makeNodeData({ name: 'llmAgentflow', label: 'LLM' })

        it('should create and add a node on valid drop', () => {
            const { result } = renderUseDragAndDrop()
            const event = makeDragEvent(JSON.stringify(nodeData))

            act(() => {
                result.current.handleDrop(event)
            })

            expect(event.preventDefault).toHaveBeenCalled()
            expect(mockScreenToFlowPosition).toHaveBeenCalledWith({
                x: 300,
                y: 400
            })
            expect(setLocalNodes).toHaveBeenCalled()
            expect(mockSetDirty).toHaveBeenCalledWith(true)
        })

        it('converts the cursor from screen space before subtracting flow-unit offsets at non-100% zoom', () => {
            mockScreenToFlowPosition.mockImplementationOnce(({ x, y }) => ({ x: x / 2, y: y / 2 }))
            const { result } = renderUseDragAndDrop()
            const event = makeDragEvent(JSON.stringify(nodeData))

            act(() => {
                result.current.handleDrop(event)
            })

            expect(mockScreenToFlowPosition).toHaveBeenCalledWith({ x: 300, y: 400 })
            expect(checkNodePlacementConstraints).toHaveBeenCalledWith(nodes, 'llmAgentflow', {
                x: 300 / 2 - DROP_OFFSET_X,
                y: 400 / 2 - DROP_OFFSET_Y
            })
            const updater = setLocalNodes.mock.calls[0][0]
            const [addedNode] = updater([])
            expect(addedNode.position).toEqual({ x: 50, y: 150 })
        })

        it('should use functional updater to append node', () => {
            const { result } = renderUseDragAndDrop()
            const event = makeDragEvent(JSON.stringify(nodeData))

            act(() => {
                result.current.handleDrop(event)
            })

            // Call the functional updater passed to setLocalNodes
            const updater = setLocalNodes.mock.calls[0][0]
            const existingNodes = [makeFlowNode('existing')]
            const updated = updater(existingNodes)
            expect(updated).toHaveLength(2)
            expect(updated[1].id).toBe('new-node-1')
            expect(updated[1].type).toBe('agentflowNode')
        })

        it('should early return when no data in drag event', () => {
            const { result } = renderUseDragAndDrop()
            const event = makeDragEvent('')

            act(() => {
                result.current.handleDrop(event)
            })

            expect(setLocalNodes).not.toHaveBeenCalled()
            expect(mockSetDirty).not.toHaveBeenCalled()
        })

        it('should early return when the canvas wrapper is unavailable', () => {
            reactFlowWrapper.current = null
            const { result } = renderUseDragAndDrop()
            const event = makeDragEvent(JSON.stringify(nodeData))

            act(() => {
                result.current.handleDrop(event)
            })

            expect(setLocalNodes).not.toHaveBeenCalled()
            expect(mockSetDirty).not.toHaveBeenCalled()
        })

        it('should not add node when placement constraint fails', () => {
            ;(checkNodePlacementConstraints as jest.Mock).mockReturnValueOnce({ valid: false, message: 'Only one start node' })
            const onConstraintViolation = jest.fn()
            const { result } = renderUseDragAndDrop({ onConstraintViolation })
            const event = makeDragEvent(JSON.stringify(nodeData))

            act(() => {
                result.current.handleDrop(event)
            })

            expect(onConstraintViolation).toHaveBeenCalledWith('Only one start node')
            expect(setLocalNodes).not.toHaveBeenCalled()
        })

        it('should catch and log JSON parse errors', () => {
            const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
            const { result } = renderUseDragAndDrop()
            const event = makeDragEvent('{invalid json')

            act(() => {
                result.current.handleDrop(event)
            })

            expect(spy).toHaveBeenCalledWith('[Agentflow] Failed to parse dropped node data:', expect.any(SyntaxError))
            expect(setLocalNodes).not.toHaveBeenCalled()
            spy.mockRestore()
        })
    })
})
