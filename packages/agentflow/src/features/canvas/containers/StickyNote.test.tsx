import { fireEvent, render, screen } from '@testing-library/react'

import type { NodeData, NodeDataSchema } from '@/core/types'

import { StickyNote } from './StickyNote'

const mockUpdateNodeData = jest.fn()
let mockComponentNodes: NodeDataSchema[] = []

jest.mock('@/infrastructure/store', () => ({
    useAgentflowContext: () => ({
        state: { componentNodes: mockComponentNodes },
        updateNodeData: mockUpdateNodeData
    }),
    useConfigContext: () => ({ isDarkMode: false })
}))

jest.mock('../components/NodeToolbarActions', () => ({ NodeToolbarActions: () => null }))
jest.mock('../hooks/useNodeColors', () => ({
    useNodeColors: () => ({ stateColor: '#000', backgroundColor: '#fff' })
}))
jest.mock('../styled', () => ({
    CardWrapper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

const data = {
    id: 'stickyNoteAgentflow_0',
    name: 'stickyNoteAgentflow',
    label: 'Sticky Note',
    inputParams: [
        {
            id: 'note',
            name: 'note',
            label: 'Note',
            type: 'string',
            placeholder: 'Type something here'
        }
    ],
    inputs: { note: '' }
} as NodeData

describe('StickyNote', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockComponentNodes = []
    })

    it('uses the current registry display placeholder while preserving the raw saved input key', () => {
        mockComponentNodes = [
            {
                name: 'stickyNoteAgentflow',
                label: 'Sticky Note',
                inputs: [
                    {
                        id: 'note',
                        name: 'note',
                        label: 'Note',
                        type: 'string',
                        placeholder: 'Type something here',
                        displayPlaceholder: '在此输入备注'
                    }
                ]
            } as NodeDataSchema
        ]

        render(<StickyNote data={data} />)

        const input = screen.getByPlaceholderText('在此输入备注')
        fireEvent.change(input, { target: { value: '新的备注' } })

        expect(mockUpdateNodeData).toHaveBeenCalledWith(data.id, { inputs: { note: '新的备注' } })
    })

    it('falls back to the raw saved placeholder when no current registry definition exists', () => {
        render(<StickyNote data={data} />)

        expect(screen.getByPlaceholderText('Type something here')).toBeInTheDocument()
    })
})
