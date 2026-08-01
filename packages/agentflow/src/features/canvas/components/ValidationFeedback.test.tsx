import { fireEvent, render, screen } from '@testing-library/react'

import type { FlowNode, NodeDataSchema } from '@/core/types'

import { ValidationFeedback } from './ValidationFeedback'

jest.mock('@/infrastructure/store', () => ({
    useConfigContext: () => ({ isDarkMode: false })
}))

jest.mock('@/core/node-config', () => ({
    getAgentflowIcon: () => null
}))

const component = { name: 'startAgentflow', label: 'Start', displayLabel: '开始', inputs: [] } as NodeDataSchema

function makeStartNode(label: string): FlowNode {
    return {
        id: 'start_0',
        type: 'agentflowNode',
        position: { x: 0, y: 0 },
        data: { id: 'start_0', name: 'startAgentflow', label, inputs: {} }
    } as FlowNode
}

function renderFeedback(label: string) {
    return render(<ValidationFeedback nodes={[makeStartNode(label)]} edges={[]} availableNodes={[component]} setNodes={jest.fn()} />)
}

describe('ValidationFeedback', () => {
    it('shows the current localized component label for a default node name', () => {
        renderFeedback('Start')

        fireEvent.click(screen.getByTitle('验证流程'))
        fireEvent.click(screen.getAllByRole('button', { name: '验证流程' })[1])

        expect(screen.getByText('开始')).toBeInTheDocument()
        expect(screen.getByText('此节点尚未连接到任何节点')).toBeInTheDocument()
    })

    it('preserves a user-authored node label', () => {
        renderFeedback('我的起点')

        fireEvent.click(screen.getByTitle('验证流程'))
        fireEvent.click(screen.getAllByRole('button', { name: '验证流程' })[1])

        expect(screen.getByText('我的起点')).toBeInTheDocument()
    })
})
