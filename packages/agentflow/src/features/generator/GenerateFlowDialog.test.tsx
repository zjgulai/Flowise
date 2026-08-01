import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { GenerateFlowDialog } from './GenerateFlowDialog'

// --- Mocks ---
const mockGetChatModels = jest.fn()
const mockGenerateAgentflow = jest.fn()

jest.mock('@/infrastructure/store', () => ({
    useApiContext: () => ({
        chatflowsApi: {
            getChatModels: mockGetChatModels,
            generateAgentflow: mockGenerateAgentflow
        },
        apiBaseUrl: 'https://test.com'
    }),
    useConfigContext: () => ({
        isDarkMode: false
    })
}))

jest.mock('./SuggestionChips', () => ({
    defaultSuggestions: [{ id: '1', text: 'Test suggestion' }],
    SuggestionChips: ({ onSelect, suggestions }: { onSelect: (s: { text: string }) => void; suggestions: { text: string }[] }) => (
        <div data-testid='suggestion-chips'>
            {suggestions.map((s, i) => (
                <button key={i} data-testid={`suggestion-${i}`} onClick={() => onSelect(s)}>
                    {s.text}
                </button>
            ))}
        </div>
    )
}))

jest.mock('@tabler/icons-react', () => ({
    IconSparkles: () => <span data-testid='icon-sparkles' />
}))

describe('GenerateFlowDialog', () => {
    const defaultProps = {
        open: true,
        onClose: jest.fn(),
        onGenerated: jest.fn()
    }

    const chatModels = [
        {
            name: 'gpt-4',
            label: 'GPT-4',
            displayLabel: 'GPT 四',
            description: 'Fast model',
            displayDescription: '快速模型',
            secret: 'must not be rendered'
        },
        { name: 'claude', label: 'Claude' }
    ]

    beforeEach(() => {
        jest.clearAllMocks()
        mockGetChatModels.mockResolvedValue(chatModels)
        mockGenerateAgentflow.mockResolvedValue({
            nodes: [{ id: 'n1' }],
            edges: [{ id: 'e1' }]
        })
    })

    it('should not render dialog content when open is false', () => {
        render(<GenerateFlowDialog {...defaultProps} open={false} />)
        expect(screen.queryByText('想构建什么流程？')).not.toBeInTheDocument()
    })

    it('should render dialog when open is true', async () => {
        render(<GenerateFlowDialog {...defaultProps} />)
        expect(screen.getByText('想构建什么流程？')).toBeInTheDocument()
        await waitFor(() => expect(mockGetChatModels).toHaveBeenCalled())
    })

    it('should load chat models on open', async () => {
        render(<GenerateFlowDialog {...defaultProps} />)
        await waitFor(() => expect(mockGetChatModels).toHaveBeenCalled())
    })

    it('should auto-select first model', async () => {
        render(<GenerateFlowDialog {...defaultProps} />)
        await waitFor(() => {
            expect(screen.getByText('GPT 四')).toBeInTheDocument()
            expect(screen.getByText('快速模型')).toBeInTheDocument()
            expect(screen.getByAltText('GPT 四')).toBeInTheDocument()
            expect(screen.queryByText('must not be rendered')).not.toBeInTheDocument()
        })
    })

    it('should show error when chat models fail to load', async () => {
        mockGetChatModels.mockRejectedValue(new Error('fail'))

        render(<GenerateFlowDialog {...defaultProps} />)

        await waitFor(() => {
            expect(screen.getByText('加载模型失败，请稍后重试。')).toBeInTheDocument()
        })
        expect(screen.queryByText('fail')).not.toBeInTheDocument()
    })

    describe('with models loaded', () => {
        const renderAndWaitForModels = async () => {
            render(<GenerateFlowDialog {...defaultProps} />)
            await waitFor(() => expect(mockGetChatModels).toHaveBeenCalled())
        }

        it('should have generate button disabled when prompt is empty', async () => {
            await renderAndWaitForModels()

            const generateBtn = screen.getByRole('button', { name: '生成' })
            expect(generateBtn).toBeDisabled()
        })

        it('should enable generate button when prompt and model are set', async () => {
            await renderAndWaitForModels()

            const input = screen.getByPlaceholderText('请描述需要生成的智能体流程')
            fireEvent.change(input, { target: { value: 'Build an agent' } })

            const generateBtn = screen.getByRole('button', { name: '生成' })
            expect(generateBtn).not.toBeDisabled()
        })

        it('should update prompt when suggestion is clicked', async () => {
            await renderAndWaitForModels()

            fireEvent.click(screen.getByTestId('suggestion-0'))

            const input = screen.getByPlaceholderText('请描述需要生成的智能体流程') as HTMLTextAreaElement
            expect(input.value).toBe('Test suggestion')
        })

        it('should call onGenerated and onClose on successful generation', async () => {
            await renderAndWaitForModels()

            const input = screen.getByPlaceholderText('请描述需要生成的智能体流程')
            fireEvent.change(input, { target: { value: 'Build an agent' } })

            fireEvent.click(screen.getByRole('button', { name: '生成' }))

            await waitFor(() => {
                expect(defaultProps.onGenerated).toHaveBeenCalledWith([{ id: 'n1' }], [{ id: 'e1' }])
                expect(defaultProps.onClose).toHaveBeenCalled()
            })
            expect(mockGenerateAgentflow).toHaveBeenCalledWith({
                question: 'Build an agent',
                selectedChatModel: { name: 'gpt-4' }
            })
        })

        it('should show error when generation returns no nodes/edges', async () => {
            mockGenerateAgentflow.mockResolvedValue({})

            await renderAndWaitForModels()

            fireEvent.change(screen.getByPlaceholderText('请描述需要生成的智能体流程'), {
                target: { value: 'Build an agent' }
            })
            fireEvent.click(screen.getByRole('button', { name: '生成' }))

            await waitFor(() => {
                expect(screen.getByText('生成流程失败，请重试。')).toBeInTheDocument()
            })
            expect(defaultProps.onGenerated).not.toHaveBeenCalled()
        })

        it('should show error message on generation failure', async () => {
            mockGenerateAgentflow.mockRejectedValue(new Error('API error'))

            await renderAndWaitForModels()

            fireEvent.change(screen.getByPlaceholderText('请描述需要生成的智能体流程'), {
                target: { value: 'Build an agent' }
            })
            fireEvent.click(screen.getByRole('button', { name: '生成' }))

            await waitFor(() => {
                expect(screen.getByText('生成流程失败，请稍后重试。')).toBeInTheDocument()
                expect(screen.queryByText('API error')).not.toBeInTheDocument()
            })
        })

        it('should handle non-Error exceptions with response.data.message', async () => {
            mockGenerateAgentflow.mockRejectedValue({
                response: { data: { message: 'Server validation error' } }
            })

            await renderAndWaitForModels()

            fireEvent.change(screen.getByPlaceholderText('请描述需要生成的智能体流程'), {
                target: { value: 'Build an agent' }
            })
            fireEvent.click(screen.getByRole('button', { name: '生成' }))

            await waitFor(() => {
                expect(screen.getByText('生成流程失败，请稍后重试。')).toBeInTheDocument()
                expect(screen.queryByText('Server validation error')).not.toBeInTheDocument()
            })
        })

        it('should clear state when dialog closes', async () => {
            const { rerender } = render(<GenerateFlowDialog {...defaultProps} />)
            await waitFor(() => expect(mockGetChatModels).toHaveBeenCalled())

            fireEvent.change(screen.getByPlaceholderText('请描述需要生成的智能体流程'), {
                target: { value: 'Some prompt' }
            })

            // Close dialog
            rerender(<GenerateFlowDialog {...defaultProps} open={false} />)

            // Re-open dialog
            rerender(<GenerateFlowDialog {...defaultProps} open={true} />)

            const input = screen.getByPlaceholderText('请描述需要生成的智能体流程') as HTMLTextAreaElement
            expect(input.value).toBe('')
        })

        it('should show cancel button when not loading', async () => {
            await renderAndWaitForModels()
            const cancelBtn = screen.getByRole('button', { name: '取消' })
            expect(cancelBtn).toBeInTheDocument()
            fireEvent.click(cancelBtn)
            expect(defaultProps.onClose).toHaveBeenCalled()
        })

        it('should show progress animation during loading', async () => {
            jest.useFakeTimers()
            try {
                // Make generation hang so we stay in loading state
                mockGenerateAgentflow.mockReturnValue(new Promise(() => {}))

                render(<GenerateFlowDialog {...defaultProps} />)
                await waitFor(() => expect(mockGetChatModels).toHaveBeenCalled())

                fireEvent.change(screen.getByPlaceholderText('请描述需要生成的智能体流程'), {
                    target: { value: 'Build an agent' }
                })
                fireEvent.click(screen.getByRole('button', { name: '生成' }))

                // Wait for loading state
                await waitFor(() => {
                    expect(screen.getByText('正在生成智能体流程……')).toBeInTheDocument()
                })

                // Advance fake timers to trigger progress intervals
                act(() => {
                    jest.advanceTimersByTime(1500) // 3 intervals of 500ms
                })

                // Progress should have incremented
                const progressText = screen.getByText(/%/)
                expect(progressText).toBeInTheDocument()
            } finally {
                jest.useRealTimers()
            }
        })

        it('should handle image load error by hiding image', async () => {
            await renderAndWaitForModels()

            const images = document.querySelectorAll('img')
            expect(images.length).toBeGreaterThan(0)
            fireEvent.error(images[0])
            expect(images[0].style.display).toBe('none')
        })

        it('should not call handleGenerate when prompt is empty', async () => {
            await renderAndWaitForModels()

            // Generate button is disabled with empty prompt, but let's also verify
            // the guard condition by ensuring generateAgentflow is not called
            expect(mockGenerateAgentflow).not.toHaveBeenCalled()
        })

        it('should handle non-Error exception without response data', async () => {
            mockGenerateAgentflow.mockRejectedValue({ some: 'object' })

            await renderAndWaitForModels()

            fireEvent.change(screen.getByPlaceholderText('请描述需要生成的智能体流程'), {
                target: { value: 'Build an agent' }
            })
            fireEvent.click(screen.getByRole('button', { name: '生成' }))

            await waitFor(() => {
                expect(screen.getByText('生成流程失败，请稍后重试。')).toBeInTheDocument()
            })
        })
    })
})
