import OpenAI from 'openai'
import { getCredentialData, getCredentialParam } from '../../../src/utils'
import { AnalyticHandler } from '../../../src/handler'
import { checkInputs, streamResponse } from '../../moderation/Moderation'
import { formatResponse } from '../../outputparsers/OutputParserHelpers'
import { addSingleFileToStorage } from '../../../src/storageUtils'

const mockAnalytics = {
    init: jest.fn().mockResolvedValue(undefined),
    onChainStart: jest.fn().mockResolvedValue({ chain: 'chain' }),
    onChainEnd: jest.fn().mockResolvedValue(undefined),
    onChainError: jest.fn().mockResolvedValue(undefined),
    onLLMStart: jest.fn().mockResolvedValue({ llm: 'llm' }),
    onLLMEnd: jest.fn().mockResolvedValue(undefined),
    onLLMError: jest.fn().mockResolvedValue(undefined),
    onToolStart: jest.fn().mockResolvedValue({ tool: 'tool' }),
    onToolEnd: jest.fn().mockResolvedValue(undefined),
    onToolError: jest.fn().mockResolvedValue(undefined)
}

const mockOpenAIClient: any = {
    beta: {
        assistants: {
            retrieve: jest.fn(),
            update: jest.fn()
        },
        threads: {
            create: jest.fn(),
            retrieve: jest.fn(),
            delete: jest.fn(),
            messages: {
                create: jest.fn(),
                list: jest.fn()
            },
            runs: {
                create: jest.fn(),
                retrieve: jest.fn(),
                list: jest.fn(),
                cancel: jest.fn(),
                submitToolOutputs: jest.fn(),
                submitToolOutputsStream: jest.fn()
            }
        }
    },
    files: {
        retrieve: jest.fn(),
        content: jest.fn()
    }
}

jest.mock('openai', () => ({
    __esModule: true,
    default: jest.fn(() => mockOpenAIClient)
}))

jest.mock('../../../src/utils', () => ({
    getCredentialData: jest.fn(),
    getCredentialParam: jest.fn(),
    toolSchemaToJsonSchema: jest.fn(() => ({ type: 'object', properties: {} }))
}))

jest.mock('../../../src/handler', () => ({
    AnalyticHandler: { getInstance: jest.fn(() => mockAnalytics) }
}))

jest.mock('../../moderation/Moderation', () => ({
    checkInputs: jest.fn(),
    streamResponse: jest.fn()
}))

jest.mock('../../outputparsers/OutputParserHelpers', () => ({
    formatResponse: jest.fn((value) => value)
}))

jest.mock('../../../src/storageUtils', () => ({
    addSingleFileToStorage: jest.fn()
}))

jest.mock('../../tools/OpenAPIToolkit/core', () => ({
    DynamicStructuredTool: class DynamicStructuredTool {}
}))

const { nodeClass: OpenAIAssistantNode } = require('./OpenAIAssistant')

const ASSISTANT_ENTITY = 'AssistantEntity'
const CHAT_MESSAGE_ENTITY = 'ChatMessageEntity'

function nodeData(id = 'local-assistant', tools: any[] = [], toolChoice?: string) {
    return {
        inputs: {
            selectedAssistant: id,
            tools,
            toolChoice,
            parallelToolCalls: true
        }
    }
}

function logger() {
    return { error: jest.fn(), warn: jest.fn(), info: jest.fn() }
}

function options(appDataSource: any, overrides: Record<string, unknown> = {}) {
    return {
        workspaceId: 'workspace-a',
        chatflowid: 'flow-a',
        chatId: 'chat-a',
        orgId: 'org-a',
        appDataSource,
        databaseEntities: { Assistant: ASSISTANT_ENTITY, ChatMessage: CHAT_MESSAGE_ENTITY },
        logger: logger(),
        ...overrides
    }
}

function dataSource(assistantRows: Record<string, any> = {}, chatMessage: any = null) {
    const assistantRepository = {
        findBy: jest.fn().mockResolvedValue(Object.values(assistantRows)),
        findOneBy: jest.fn(async ({ id }: { id: string }) => assistantRows[id] ?? null)
    }
    const chatMessageRepository = {
        findOneBy: jest.fn().mockResolvedValue(chatMessage)
    }
    const appDataSource = {
        getRepository: jest.fn((entity) => (entity === ASSISTANT_ENTITY ? assistantRepository : chatMessageRepository))
    }
    return { appDataSource, assistantRepository, chatMessageRepository }
}

function assistant(id: string, workspaceId = 'workspace-a', type = 'OPENAI', details: Record<string, unknown> = {}) {
    return {
        id,
        workspaceId,
        type,
        credential: 'credential-a',
        details: JSON.stringify({ id: `asst-provider-${id}`, name: id, ...details })
    }
}

describe('OpenAI Assistant node security contracts', () => {
    afterEach(() => {
        jest.useRealTimers()
    })

    beforeEach(() => {
        jest.clearAllMocks()
        ;(getCredentialData as jest.Mock).mockResolvedValue({ openAIApiKey: 'sk-sensitive-sentinel' })
        ;(getCredentialParam as jest.Mock).mockReturnValue('sk-sensitive-sentinel')
        ;(AnalyticHandler.getInstance as jest.Mock).mockReturnValue(mockAnalytics)
        mockOpenAIClient.beta.assistants.retrieve.mockImplementation(async (id: string) => ({ id, tools: [{ type: 'file_search' }] }))
        mockOpenAIClient.beta.threads.create.mockResolvedValue({ id: 'thread_new' })
        mockOpenAIClient.beta.threads.retrieve.mockImplementation(async (id: string) => ({ id }))
        mockOpenAIClient.beta.threads.delete.mockImplementation(async (id: string) => ({ id, deleted: true }))
        mockOpenAIClient.beta.threads.messages.create.mockResolvedValue({})
        mockOpenAIClient.beta.threads.messages.list.mockResolvedValue({
            data: [{ role: 'assistant', content: [{ type: 'text', text: { value: 'done' } }] }]
        })
        mockOpenAIClient.beta.threads.runs.create.mockImplementation(async () => ({ id: 'run-new' }))
        mockOpenAIClient.beta.threads.runs.retrieve.mockResolvedValue({ id: 'run-new', status: 'completed' })
        mockOpenAIClient.beta.threads.runs.list.mockResolvedValue({ data: [] })
        mockOpenAIClient.beta.threads.runs.cancel.mockResolvedValue({ id: 'run-new', status: 'cancelled' })
    })

    it('lists only workspace-scoped OpenAI assistants without leaking details', async () => {
        const rows = {
            good: assistant('good', 'workspace-a', 'OPENAI', { name: '客服助手', instructions: 'secret instructions' }),
            unnamed: assistant('unnamed', 'workspace-a', 'OPENAI', { name: '', instructions: 'secret instructions' }),
            broken: { id: 'broken', details: '{bad', workspaceId: 'workspace-a', type: 'OPENAI' }
        }
        const { appDataSource, assistantRepository } = dataSource(rows)
        const node = new OpenAIAssistantNode()

        const result = await node.loadMethods.listAssistants({}, options(appDataSource))

        expect(assistantRepository.findBy).toHaveBeenCalledWith({ workspaceId: 'workspace-a', type: 'OPENAI' })
        expect(result).toEqual([
            { name: 'good', label: '客服助手' },
            { name: 'unnamed', label: '未命名助手（unnamed）' }
        ])
        expect(JSON.stringify(result)).not.toContain('secret instructions')
    })

    it.each([
        ['workspaceId', { workspaceId: undefined }],
        ['chatflowid', { chatflowid: undefined }],
        ['chatId', { chatId: undefined }]
    ])('fails run on missing %s before database, credential or Provider access', async (_field, override) => {
        const { appDataSource } = dataSource({})
        const node = new OpenAIAssistantNode()

        await expect(node.run(nodeData(), 'hello', options(appDataSource, override))).rejects.toThrow()
        expect(appDataSource.getRepository).not.toHaveBeenCalled()
        expect(getCredentialData).not.toHaveBeenCalled()
        expect(OpenAI).not.toHaveBeenCalled()
    })

    it('queries the selected assistant by id, workspace and OPENAI type before decrypting', async () => {
        const { appDataSource, assistantRepository } = dataSource({})
        const node = new OpenAIAssistantNode()

        await expect(node.run(nodeData('foreign'), 'hello', options(appDataSource))).rejects.toThrow('OpenAI Assistant not found')
        expect(assistantRepository.findOneBy).toHaveBeenCalledWith({
            id: 'foreign',
            workspaceId: 'workspace-a',
            type: 'OPENAI'
        })
        expect(getCredentialData).not.toHaveBeenCalled()
        expect(OpenAI).not.toHaveBeenCalled()
    })

    it('returns only a fixed moderation error when the moderation Provider leaks a raw sentinel', async () => {
        jest.useFakeTimers()
        const row = assistant('local-assistant')
        const { appDataSource } = dataSource({ 'local-assistant': row })
        const runtimeOptions = options(appDataSource, { shouldStreamResponse: true, sseStreamer: {} })
        ;(checkInputs as jest.Mock).mockRejectedValueOnce(
            new Error('raw-moderation-provider-sentinel sk-sensitive thread-sensitive args-sensitive')
        )
        const data = nodeData() as any
        data.inputs.inputModeration = [{ moderationErrorMessage: 'Configured safe rejection' }]
        const node = new OpenAIAssistantNode()
        const result = node.run(data, 'hello', runtimeOptions)

        await jest.advanceTimersByTimeAsync(500)
        await expect(result).resolves.toBe('Input moderation failed')
        expect(formatResponse).toHaveBeenCalledWith('Input moderation failed')
        expect(streamResponse).toHaveBeenCalledWith({}, 'chat-a', 'Input moderation failed')
        expect(getCredentialData).not.toHaveBeenCalled()
        expect(OpenAI).not.toHaveBeenCalled()
        const emitted = JSON.stringify((runtimeOptions.logger.error as jest.Mock).mock.calls)
        expect(emitted).toBe('[["OpenAI Assistant input moderation failed"]]')
        expect(emitted).not.toContain('raw-moderation-provider-sentinel')
        expect(emitted).not.toContain('sk-sensitive')
    })

    it('rejects an unbound custom tool choice before credential or Provider access', async () => {
        const row = assistant('local-assistant')
        const { appDataSource } = dataSource({ 'local-assistant': row })
        const node = new OpenAIAssistantNode()

        await expect(node.run(nodeData('local-assistant', [], 'unbound_tool'), 'hello', options(appDataSource))).rejects.toThrow(
            'tool request rejected'
        )
        expect(getCredentialData).not.toHaveBeenCalled()
        expect(OpenAI).not.toHaveBeenCalled()
    })

    it('uses per-run tools for concurrent flows and never updates the shared Provider assistant', async () => {
        const rows = { a: assistant('a'), b: assistant('b') }
        const { appDataSource } = dataSource(rows)
        const node = new OpenAIAssistantNode()
        const toolA = { name: 'flow_a', description: 'A', schema: {}, call: jest.fn() }
        const toolB = { name: 'flow_b', description: 'B', schema: {}, call: jest.fn() }

        await Promise.all([
            node.run(nodeData('a', [toolA]), 'hello a', options(appDataSource, { chatId: 'chat-a' })),
            node.run(nodeData('b', [toolB]), 'hello b', options(appDataSource, { chatId: 'chat-b' }))
        ])

        expect(mockOpenAIClient.beta.assistants.update).not.toHaveBeenCalled()
        const runParams = mockOpenAIClient.beta.threads.runs.create.mock.calls.map((call: any[]) => call[1])
        expect(runParams).toHaveLength(2)
        expect(runParams[0].tools).toEqual(
            expect.arrayContaining([
                { type: 'file_search' },
                expect.objectContaining({ function: expect.objectContaining({ name: 'flow_a' }) })
            ])
        )
        expect(runParams[0].tools).not.toEqual(
            expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: 'flow_b' }) })])
        )
        expect(runParams[1].tools).toEqual(
            expect.arrayContaining([
                { type: 'file_search' },
                expect.objectContaining({ function: expect.objectContaining({ name: 'flow_b' }) })
            ])
        )
    })

    it('redacts a raw Provider failure from the client and analytics boundary', async () => {
        const row = assistant('local-assistant')
        const { appDataSource } = dataSource({ 'local-assistant': row })
        mockOpenAIClient.beta.assistants.retrieve.mockRejectedValueOnce(
            new Error('raw-provider-sentinel sk-sensitive-sentinel thread-secret tool-args-secret')
        )
        const node = new OpenAIAssistantNode()
        const runtimeOptions = options(appDataSource)

        await expect(node.run(nodeData(), 'hello', runtimeOptions)).rejects.toThrow('OpenAI Assistant execution failed')
        const analyticsPayload = JSON.stringify([
            mockAnalytics.onChainError.mock.calls,
            mockAnalytics.onLLMError.mock.calls,
            mockAnalytics.onToolError.mock.calls,
            (runtimeOptions.logger.error as jest.Mock).mock.calls,
            (runtimeOptions.logger.warn as jest.Mock).mock.calls
        ])
        expect(analyticsPayload).not.toContain('raw-provider-sentinel')
        expect(analyticsPayload).not.toContain('sk-sensitive-sentinel')
        expect(analyticsPayload).not.toContain('thread-secret')
        expect(analyticsPayload).not.toContain('tool-args-secret')
    })

    it('aborts and cancels a hanging streaming run at the shared deadline', async () => {
        jest.useFakeTimers()
        const row = assistant('local-assistant')
        const { appDataSource } = dataSource({ 'local-assistant': row })
        let requestSignal: AbortSignal | undefined
        mockOpenAIClient.beta.threads.runs.create.mockImplementationOnce((_threadId: string, _params: any, request: any) => {
            requestSignal = request.signal
            return (async function* () {
                yield { event: 'thread.run.created', data: { id: 'run_stream' } }
                await new Promise<never>(() => undefined)
            })()
        })
        const node = new OpenAIAssistantNode()
        const result = node.run(nodeData(), 'hello', options(appDataSource, { shouldStreamResponse: true }))
        const rejection = expect(result).rejects.toThrow('OpenAI Assistant execution failed')

        await jest.advanceTimersByTimeAsync(0)
        await jest.advanceTimersByTimeAsync(30_000)
        await rejection
        expect(requestSignal?.aborted).toBe(true)
        expect(mockOpenAIClient.beta.threads.runs.cancel).toHaveBeenCalledWith(
            'run_stream',
            { thread_id: 'thread_new' },
            expect.objectContaining({ signal: expect.anything() })
        )
        expect(jest.getTimerCount()).toBe(0)
    })

    it('propagates the streaming deadline through metadata and body reads with zero late storage write', async () => {
        jest.useFakeTimers()
        const row = assistant('local-assistant')
        const { appDataSource } = dataSource({ 'local-assistant': row })
        const updateStorageUsage = jest.fn()
        let metadataSignal: AbortSignal | undefined
        let bodySignal: AbortSignal | undefined
        mockOpenAIClient.beta.threads.runs.create.mockImplementationOnce(() =>
            (async function* () {
                yield { event: 'thread.run.created', data: { id: 'run_stream' } }
                yield {
                    event: 'thread.message.delta',
                    data: { delta: { content: [{ type: 'image_file', image_file: { file_id: 'file-safe' } }] } }
                }
            })()
        )
        mockOpenAIClient.files.retrieve.mockImplementationOnce(async (_id: string, request: any) => {
            metadataSignal = request.signal
            return { id: 'file-safe', filename: 'image', bytes: 2 }
        })
        mockOpenAIClient.files.content.mockImplementationOnce(async (_id: string, request: any) => {
            bodySignal = request.signal
            return {
                ok: true,
                headers: { get: (name: string) => (name === 'content-type' ? 'image/png' : null) },
                body: {
                    async *[Symbol.asyncIterator]() {
                        yield Buffer.from('a')
                        await new Promise<void>((resolve) => bodySignal?.addEventListener('abort', () => resolve(), { once: true }))
                        yield Buffer.from('b')
                    }
                }
            }
        })
        const result = new OpenAIAssistantNode().run(
            nodeData(),
            'hello',
            options(appDataSource, { shouldStreamResponse: true, updateStorageUsage })
        )
        const rejection = expect(result).rejects.toThrow('OpenAI Assistant execution failed')

        await jest.advanceTimersByTimeAsync(0)
        await jest.advanceTimersByTimeAsync(30_000)
        await rejection
        expect(metadataSignal).toBeDefined()
        expect(bodySignal?.aborted).toBe(true)
        expect(addSingleFileToStorage).not.toHaveBeenCalled()
        expect(updateStorageUsage).not.toHaveBeenCalled()
        expect(mockOpenAIClient.beta.threads.runs.cancel).toHaveBeenCalled()
        expect(jest.getTimerCount()).toBe(0)
    })

    it('drains one storage commit without processing buffered events after a streaming deadline', async () => {
        jest.useFakeTimers()
        const row = assistant('local-assistant')
        const { appDataSource } = dataSource({ 'local-assistant': row })
        const lifecycle: string[] = []
        let resolveStore!: (value: { path: string; totalSize: number }) => void
        ;(addSingleFileToStorage as jest.Mock).mockImplementationOnce(
            () =>
                new Promise<{ path: string; totalSize: number }>((resolve) => {
                    lifecycle.push('store-started')
                    resolveStore = (value) => {
                        lifecycle.push('store-resolved')
                        resolve(value)
                    }
                })
        )
        const updateStorageUsage = jest.fn(async () => {
            lifecycle.push('usage-updated')
        })
        const sseStreamer = {
            streamStartEvent: jest.fn(),
            streamTokenEvent: jest.fn(),
            streamArtifactsEvent: jest.fn(),
            streamFileAnnotationsEvent: jest.fn()
        }
        mockOpenAIClient.beta.threads.runs.create.mockImplementationOnce(() =>
            (async function* () {
                yield { event: 'thread.run.created', data: { id: 'run_stream' } }
                yield {
                    event: 'thread.message.delta',
                    data: { delta: { content: [{ type: 'image_file', image_file: { file_id: 'file-safe' } }] } }
                }
                yield {
                    event: 'thread.message.delta',
                    data: { delta: { content: [{ type: 'image_file', image_file: { file_id: 'file-must-not-run' } }] } }
                }
            })()
        )
        mockOpenAIClient.files.retrieve.mockResolvedValueOnce({ id: 'file-safe', filename: 'image', bytes: 3 })
        mockOpenAIClient.files.content.mockResolvedValueOnce({
            ok: true,
            headers: { get: (name: string) => (name === 'content-type' ? 'image/png' : null) },
            body: {
                async *[Symbol.asyncIterator]() {
                    yield Buffer.from('img')
                }
            }
        })

        const result = new OpenAIAssistantNode().run(
            nodeData(),
            'hello',
            options(appDataSource, { shouldStreamResponse: true, updateStorageUsage, sseStreamer })
        )
        let settled = false
        void result.then(
            () => {
                settled = true
            },
            () => {
                settled = true
            }
        )

        for (let attempt = 0; attempt < 20 && !(addSingleFileToStorage as jest.Mock).mock.calls.length; attempt += 1) {
            await jest.advanceTimersByTimeAsync(0)
        }
        expect(lifecycle).toEqual(['store-started'])

        await jest.advanceTimersByTimeAsync(30_000)
        expect(settled).toBe(false)
        expect(updateStorageUsage).not.toHaveBeenCalled()

        resolveStore({ path: 'stored/image.png', totalSize: 3 })
        const rejection = expect(result).rejects.toThrow('OpenAI Assistant execution failed')
        await jest.advanceTimersByTimeAsync(0)
        await rejection

        expect(lifecycle).toEqual(['store-started', 'store-resolved', 'usage-updated'])
        expect(updateStorageUsage).toHaveBeenCalledTimes(1)
        expect(updateStorageUsage).toHaveBeenCalledWith('org-a', 'workspace-a', 3, undefined)
        expect(mockOpenAIClient.files.retrieve).toHaveBeenCalledTimes(1)
        expect(mockOpenAIClient.files.content).toHaveBeenCalledTimes(1)
        expect(addSingleFileToStorage).toHaveBeenCalledTimes(1)
        expect(sseStreamer.streamStartEvent).not.toHaveBeenCalled()
        expect(sseStreamer.streamTokenEvent).not.toHaveBeenCalled()
        expect(sseStreamer.streamArtifactsEvent).not.toHaveBeenCalled()
        expect(sseStreamer.streamFileAnnotationsEvent).not.toHaveBeenCalled()
        expect(mockOpenAIClient.beta.threads.runs.cancel).toHaveBeenCalled()
        expect(jest.getTimerCount()).toBe(0)

        await jest.advanceTimersByTimeAsync(60_000)
        expect(mockOpenAIClient.files.retrieve).toHaveBeenCalledTimes(1)
        expect(addSingleFileToStorage).toHaveBeenCalledTimes(1)
        expect(updateStorageUsage).toHaveBeenCalledTimes(1)
        expect(sseStreamer.streamArtifactsEvent).not.toHaveBeenCalled()
    })

    it.each([
        ['malformed arguments', { id: 'call-sensitive', function: { name: 'safe_tool', arguments: '{bad' } }],
        ['unknown tool', { id: 'call-sensitive', function: { name: 'unknown_tool', arguments: '{}' } }]
    ])('cancels %s without calling any tool', async (_name, toolCall) => {
        const row = assistant('local-assistant')
        const { appDataSource } = dataSource({ 'local-assistant': row })
        const call = jest.fn()
        const tool = { name: 'safe_tool', description: 'safe', schema: {}, call }
        mockOpenAIClient.beta.threads.runs.retrieve.mockResolvedValueOnce({
            id: 'run-new',
            status: 'requires_action',
            required_action: { submit_tool_outputs: { tool_calls: [toolCall] } }
        })
        const node = new OpenAIAssistantNode()

        await expect(node.run(nodeData('local-assistant', [tool]), 'hello', options(appDataSource))).rejects.toThrow(
            'OpenAI Assistant execution failed'
        )
        expect(call).not.toHaveBeenCalled()
        expect(mockOpenAIClient.beta.threads.runs.cancel).toHaveBeenCalled()
        expect(mockOpenAIClient.beta.threads.runs.create).toHaveBeenCalledTimes(1)
        expect(mockOpenAIClient.beta.threads.runs.submitToolOutputs).not.toHaveBeenCalled()
        const emitted = JSON.stringify([
            mockAnalytics.onChainError.mock.calls,
            mockAnalytics.onLLMError.mock.calls,
            mockAnalytics.onToolError.mock.calls
        ])
        expect(emitted).not.toContain('call-sensitive')
        expect(emitted).not.toContain('unknown_tool')
    })

    it('cancels after an oversized tool output without rerunning the side effect', async () => {
        const row = assistant('local-assistant')
        const { appDataSource } = dataSource({ 'local-assistant': row })
        const call = jest.fn().mockResolvedValue('x'.repeat(1024 * 1024 + 1))
        const tool = { name: 'safe_tool', description: 'safe', schema: {}, call }
        mockOpenAIClient.beta.threads.runs.retrieve.mockResolvedValueOnce({
            id: 'run-new',
            status: 'requires_action',
            required_action: {
                submit_tool_outputs: {
                    tool_calls: [{ id: 'call-output', function: { name: 'safe_tool', arguments: '{}' } }]
                }
            }
        })
        const node = new OpenAIAssistantNode()

        await expect(node.run(nodeData('local-assistant', [tool]), 'hello', options(appDataSource))).rejects.toThrow(
            'OpenAI Assistant execution failed'
        )
        expect(call).toHaveBeenCalledTimes(1)
        expect(mockOpenAIClient.beta.threads.runs.create).toHaveBeenCalledTimes(1)
        expect(mockOpenAIClient.beta.threads.runs.submitToolOutputs).not.toHaveBeenCalled()
        expect(mockOpenAIClient.beta.threads.runs.cancel).toHaveBeenCalled()
    })

    it.each([
        ['streaming', true],
        ['non-streaming', false]
    ])('honors disabled file downloads for %s image output with zero external read or write', async (_name, streaming) => {
        const row = assistant('local-assistant')
        const { appDataSource } = dataSource({ 'local-assistant': row })
        const updateStorageUsage = jest.fn()
        const checkStorage = jest.fn()
        const data = nodeData() as any
        data.inputs.disableFileDownload = true

        if (streaming) {
            mockOpenAIClient.beta.threads.runs.create.mockImplementationOnce(() =>
                (async function* () {
                    yield { event: 'thread.run.created', data: { id: 'run_stream' } }
                    yield {
                        event: 'thread.message.delta',
                        data: { delta: { content: [{ type: 'image_file', image_file: { file_id: 'file-sensitive' } }] } }
                    }
                })()
            )
        } else {
            mockOpenAIClient.beta.threads.messages.list.mockResolvedValueOnce({
                data: [{ role: 'assistant', content: [{ type: 'image_file', image_file: { file_id: 'file-sensitive' } }] }]
            })
        }

        const result = (await new OpenAIAssistantNode().run(
            data,
            'hello',
            options(appDataSource, { shouldStreamResponse: streaming, updateStorageUsage, checkStorage })
        )) as any

        expect(result.artifacts).toEqual([])
        expect(mockOpenAIClient.files.retrieve).not.toHaveBeenCalled()
        expect(mockOpenAIClient.files.content).not.toHaveBeenCalled()
        expect(addSingleFileToStorage).not.toHaveBeenCalled()
        expect(checkStorage).not.toHaveBeenCalled()
        expect(updateStorageUsage).not.toHaveBeenCalled()
    })

    it.each([
        ['streaming', true],
        ['non-streaming', false]
    ])('does not retrieve annotation metadata when %s file downloads are disabled', async (_name, streaming) => {
        const row = assistant('local-assistant')
        const { appDataSource } = dataSource({ 'local-assistant': row })
        const updateStorageUsage = jest.fn()
        const checkStorage = jest.fn()
        const data = nodeData() as any
        data.inputs.disableFileDownload = true
        const content = {
            type: 'text',
            text: {
                value: 'citation',
                annotations: [{ text: 'citation', file_citation: { file_id: 'file-sensitive' } }]
            }
        }

        if (streaming) {
            mockOpenAIClient.beta.threads.runs.create.mockImplementationOnce(() =>
                (async function* () {
                    yield { event: 'thread.run.created', data: { id: 'run_stream' } }
                    yield { event: 'thread.message.delta', data: { delta: { content: [content] } } }
                })()
            )
        } else {
            mockOpenAIClient.beta.threads.messages.list.mockResolvedValueOnce({ data: [{ role: 'assistant', content: [content] }] })
        }

        const result = (await new OpenAIAssistantNode().run(
            data,
            'hello',
            options(appDataSource, { shouldStreamResponse: streaming, updateStorageUsage, checkStorage })
        )) as any

        expect(result.fileAnnotations).toEqual([])
        expect(mockOpenAIClient.files.retrieve).not.toHaveBeenCalled()
        expect(mockOpenAIClient.files.content).not.toHaveBeenCalled()
        expect(addSingleFileToStorage).not.toHaveBeenCalled()
        expect(checkStorage).not.toHaveBeenCalled()
        expect(updateStorageUsage).not.toHaveBeenCalled()
    })

    it('downloads a non-streaming image only when file downloads are enabled', async () => {
        const row = assistant('local-assistant')
        const { appDataSource } = dataSource({ 'local-assistant': row })
        const updateStorageUsage = jest.fn().mockResolvedValue(undefined)
        const checkStorage = jest.fn().mockResolvedValue(undefined)
        mockOpenAIClient.beta.threads.messages.list.mockResolvedValueOnce({
            data: [{ role: 'assistant', content: [{ type: 'image_file', image_file: { file_id: 'file-safe' } }] }]
        })
        mockOpenAIClient.files.retrieve.mockResolvedValueOnce({ id: 'file-safe', filename: 'image', bytes: 3 })
        mockOpenAIClient.files.content.mockResolvedValueOnce(
            new Response(Buffer.from('png'), { status: 200, headers: { 'content-type': 'image/png', 'content-length': '3' } })
        )
        ;(addSingleFileToStorage as jest.Mock).mockResolvedValueOnce({ path: '/safe/image.png', totalSize: 3 })

        const result = (await new OpenAIAssistantNode().run(
            nodeData(),
            'hello',
            options(appDataSource, { updateStorageUsage, checkStorage })
        )) as any

        expect(result.artifacts).toEqual([{ type: 'png', data: '/safe/image.png' }])
        expect(mockOpenAIClient.files.retrieve).toHaveBeenCalledWith('file-safe', expect.objectContaining({ signal: expect.anything() }))
        expect(mockOpenAIClient.files.content).toHaveBeenCalled()
        expect(addSingleFileToStorage).toHaveBeenCalledTimes(1)
        expect(checkStorage).toHaveBeenCalledTimes(1)
        expect(updateStorageUsage).toHaveBeenCalledWith('org-a', 'workspace-a', 3, undefined)
    })

    it('binds thread cleanup to assistant workspace/type and local chatflow/chat ownership', async () => {
        const row = assistant('local-assistant')
        const chatMessage = { chatId: 'chat-a', chatflowid: 'flow-a', sessionId: 'thread_owned' }
        const { appDataSource, assistantRepository, chatMessageRepository } = dataSource({ 'local-assistant': row }, chatMessage)
        const node = new OpenAIAssistantNode()

        await node.clearChatMessages(nodeData(), options(appDataSource), { type: 'threadId', id: 'thread_owned' })

        expect(assistantRepository.findOneBy).toHaveBeenCalledWith({
            id: 'local-assistant',
            workspaceId: 'workspace-a',
            type: 'OPENAI'
        })
        expect(chatMessageRepository.findOneBy).toHaveBeenCalledWith({
            sessionId: 'thread_owned',
            chatflowid: 'flow-a',
            chatId: 'chat-a'
        })
        expect(mockOpenAIClient.beta.threads.delete).toHaveBeenCalledWith('thread_owned')
    })

    it.each([
        ['unknown session type', { type: 'unknown', id: 'thread-sensitive' }, {}],
        ['missing chatflow', { type: 'threadId', id: 'thread-sensitive' }, { chatflowid: undefined }],
        ['missing chat id', { type: 'threadId', id: 'thread-sensitive' }, { chatId: undefined }]
    ])('rejects cleanup for %s before database, credential or Provider access', async (_name, session, override) => {
        const { appDataSource } = dataSource({})
        const node = new OpenAIAssistantNode()

        await expect(node.clearChatMessages(nodeData(), options(appDataSource, override), session)).rejects.toThrow()
        expect(appDataSource.getRepository).not.toHaveBeenCalled()
        expect(getCredentialData).not.toHaveBeenCalled()
        expect(OpenAI).not.toHaveBeenCalled()
    })

    it.each([
        ['Provider rejection', () => Promise.reject(new Error('raw-provider-sentinel sk-secret thread-secret'))],
        ['mismatched delete receipt', () => Promise.resolve({ id: 'thread_other', deleted: true })],
        ['negative delete receipt', () => Promise.resolve({ id: 'thread_owned', deleted: false })]
    ])('fails cleanup on %s with a fixed redacted error and log', async (_name, deleteResult) => {
        const row = assistant('local-assistant')
        const chatMessage = { chatId: 'chat-a', chatflowid: 'flow-a', sessionId: 'thread_owned' }
        const { appDataSource } = dataSource({ 'local-assistant': row }, chatMessage)
        const runtimeOptions = options(appDataSource)
        mockOpenAIClient.beta.threads.delete.mockImplementationOnce(deleteResult)
        const node = new OpenAIAssistantNode()

        await expect(node.clearChatMessages(nodeData(), runtimeOptions, { type: 'threadId', id: 'thread_owned' })).rejects.toThrow(
            'OpenAI Assistant thread cleanup failed'
        )
        const emitted = JSON.stringify((runtimeOptions.logger.error as jest.Mock).mock.calls)
        expect(emitted).toBe('[["OpenAI Assistant thread cleanup failed"]]')
        expect(emitted).not.toContain('raw-provider-sentinel')
        expect(emitted).not.toContain('thread_owned')
        expect(emitted).not.toContain('sk-secret')
    })
})
