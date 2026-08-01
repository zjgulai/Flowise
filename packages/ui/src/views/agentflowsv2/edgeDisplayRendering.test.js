import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import AgentFlowEdge from './AgentFlowEdge'
import ConnectionLine from './ConnectionLine'

const mockUseStore = jest.fn()

jest.mock('react-redux', () => ({
    useDispatch: () => jest.fn()
}))

jest.mock('@/store/constant', () => ({
    AGENTFLOW_ICONS: [{ name: 'humanInputAgentflow', color: '#123456' }]
}))

jest.mock('reactflow', () => ({
    EdgeLabelRenderer: ({ children }) => children,
    getBezierPath: () => ['M0 0', 0, 0],
    useStore: () => mockUseStore()
}))

describe('Agentflow V2 edge label rendering', () => {
    const originalGlobalReact = global.React

    beforeAll(() => {
        global.React = React
    })

    afterAll(() => {
        if (originalGlobalReact === undefined) delete global.React
        else global.React = originalGlobalReact
    })

    it('renders a localized human-input label while previewing a connection', () => {
        mockUseStore.mockReturnValue({ connectionHandleId: 'humanInputAgentflow_source-0' })

        const markup = renderToStaticMarkup(
            React.createElement(
                'svg',
                null,
                React.createElement(ConnectionLine, {
                    fromX: 0,
                    fromY: 0,
                    toX: 100,
                    toY: 100,
                    fromPosition: 'right',
                    toPosition: 'left'
                })
            )
        )

        expect(markup).toContain('>继续<')
        expect(markup).not.toContain('>proceed<')
    })

    it('renders a localized saved label without modifying edge machine data', () => {
        const data = {
            edgeLabel: 'Proceed',
            isHumanInput: true,
            sourceColor: '#000000',
            targetColor: '#ffffff'
        }

        const markup = renderToStaticMarkup(
            React.createElement(
                'svg',
                null,
                React.createElement(AgentFlowEdge, {
                    id: 'edge-1',
                    sourceX: 0,
                    sourceY: 0,
                    targetX: 100,
                    targetY: 100,
                    sourcePosition: 'right',
                    targetPosition: 'left',
                    data,
                    selected: false
                })
            )
        )

        expect(markup).toContain('>继续<')
        expect(markup).not.toContain('>Proceed<')
        expect(data.edgeLabel).toBe('Proceed')
    })
})
