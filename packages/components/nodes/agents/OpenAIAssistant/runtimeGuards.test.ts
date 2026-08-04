import {
    OPENAI_ASSISTANT_DOWNLOAD_ERROR,
    OPENAI_ASSISTANT_POLL_TIMEOUT_ERROR,
    OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR,
    assertSafeDownloadResponse,
    buildPerRunTools,
    createDownloadBudget,
    createToolExecutionBudget,
    downloadAndStoreBounded,
    prepareToolActions,
    readBoundedResponseBody,
    requireChatflowId,
    requireWorkspaceId,
    serialPoll,
    toAssistantOption
} from './runtimeGuards'

function headers(values: Record<string, string>) {
    return { get: (name: string) => values[name.toLowerCase()] ?? null }
}

describe('OpenAI Assistant runtime guards', () => {
    afterEach(() => {
        jest.useRealTimers()
    })

    it('requires non-empty workspace and chatflow scope', () => {
        expect(() => requireWorkspaceId({})).toThrow('workspace context is required')
        expect(() => requireWorkspaceId({ workspaceId: '   ' })).toThrow('workspace context is required')
        expect(() => requireChatflowId({})).toThrow('chatflow context is required')
        expect(requireWorkspaceId({ workspaceId: ' workspace-a ' })).toBe('workspace-a')
        expect(requireChatflowId({ chatflowid: ' flow-a ' })).toBe('flow-a')
    })

    it('maps only local id and safe label while isolating malformed rows', () => {
        expect(
            toAssistantOption({
                id: 'assistant-local-1',
                details: JSON.stringify({ name: 'Support', instructions: 'TOP SECRET INSTRUCTIONS' })
            })
        ).toEqual({ name: 'assistant-local-1', label: 'Support' })
        expect(toAssistantOption({ id: 'assistant-local-2', details: JSON.stringify({ instructions: 'secret' }) })).toEqual({
            name: 'assistant-local-2',
            label: '未命名助手（assistan）'
        })
        expect(toAssistantOption({ id: 'assistant-local-3', details: '{broken' })).toBeUndefined()
    })

    it('builds flow-local run tools without mutating provider tools', async () => {
        const providerTools = [{ type: 'file_search' }, { type: 'function', function: { name: 'stale' } }]
        const flowA = [{ type: 'function', function: { name: 'flow_a' } }]
        const flowB = [{ type: 'function', function: { name: 'flow_b' } }]

        const [toolsA, toolsB] = await Promise.all([
            Promise.resolve(buildPerRunTools(providerTools, flowA)),
            Promise.resolve(buildPerRunTools(providerTools, flowB))
        ])

        expect(toolsA).toEqual([{ type: 'file_search' }, flowA[0]])
        expect(toolsB).toEqual([{ type: 'file_search' }, flowB[0]])
        expect(toolsA).not.toContain(flowB[0])
        expect(toolsB).not.toContain(flowA[0])
        expect(providerTools).toHaveLength(2)
    })

    it.each([
        ['malformed arguments', [{ id: 'call-1', function: { name: 'safe', arguments: '{bad' } }]],
        ['unknown tool', [{ id: 'call-1', function: { name: 'unknown', arguments: '{}' } }]],
        [
            'duplicate tool call id',
            [
                { id: 'call-1', function: { name: 'safe', arguments: '{}' } },
                { id: 'call-1', function: { name: 'safe', arguments: '{}' } }
            ]
        ]
    ])('rejects %s before invoking any tool', (_name, toolCalls) => {
        const call = jest.fn()
        const tools = [{ name: 'safe', call }]

        expect(() => prepareToolActions(toolCalls, tools, createToolExecutionBudget())).toThrow(OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR)
        expect(call).not.toHaveBeenCalled()
    })

    it('shares round, call, duplicate-id and wall-clock budgets', () => {
        const call = jest.fn()
        const tools = [{ name: 'safe', call }]
        const budget = createToolExecutionBudget(1, 1, Date.now() + 10_000)
        const request = [{ id: 'call-1', function: { name: 'safe', arguments: '{"ok":true}' } }]

        expect(prepareToolActions(request, tools, budget)).toHaveLength(1)
        expect(() => prepareToolActions(request, tools, budget)).toThrow(OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR)
        expect(() => prepareToolActions(request, tools, createToolExecutionBudget(1, 1, Date.now() - 1))).toThrow(
            OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR
        )
        expect(call).not.toHaveBeenCalled()
    })

    it('backs off boundedly on 429 without overlapping operations', async () => {
        let now = 0
        let calls = 0
        let inFlight = 0
        let maxInFlight = 0
        const sleeps: number[] = []
        const result = await serialPoll({
            operation: async () => {
                inFlight += 1
                maxInFlight = Math.max(maxInFlight, inFlight)
                await Promise.resolve()
                inFlight -= 1
                calls += 1
                if (calls <= 2) throw { response: { status: 429 } }
                return 'done'
            },
            evaluate: (value) => ({ done: true, value }),
            initialDelayMs: 100,
            maxDelayMs: 400,
            maxWaitMs: 5_000,
            now: () => now,
            sleep: async (delayMs) => {
                sleeps.push(delayMs)
                now += delayMs
            }
        })

        expect(result).toBe('done')
        expect(sleeps).toEqual([200, 400])
        expect(maxInFlight).toBe(1)
    })

    it('aborts a hanging poll at the total deadline and leaves no timer', async () => {
        jest.useFakeTimers()
        let signal: AbortSignal | undefined
        const result = serialPoll({
            operation: (operationSignal) => {
                signal = operationSignal
                return new Promise<never>(() => undefined)
            },
            evaluate: () => ({ done: false }),
            maxWaitMs: 1_000
        })
        const rejection = expect(result).rejects.toThrow(OPENAI_ASSISTANT_POLL_TIMEOUT_ERROR)

        await jest.advanceTimersByTimeAsync(1_000)
        await rejection
        expect(signal?.aborted).toBe(true)
        expect(jest.getTimerCount()).toBe(0)
    })

    it('rejects declared and streamed download overflows and unsafe MIME types', async () => {
        expect(() =>
            assertSafeDownloadResponse(
                { ok: true, headers: headers({ 'content-length': '11', 'content-type': 'application/pdf' }) },
                'file',
                10
            )
        ).toThrow(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
        expect(() => assertSafeDownloadResponse({ ok: true, headers: headers({ 'content-type': 'text/html' }) }, 'file', 10)).toThrow(
            OPENAI_ASSISTANT_DOWNLOAD_ERROR
        )

        const response = {
            body: {
                async *[Symbol.asyncIterator]() {
                    yield Buffer.alloc(6)
                    yield Buffer.alloc(5)
                }
            }
        }
        await expect(readBoundedResponseBody(response, 10)).rejects.toThrow(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
    })

    it.each([
        ['declared overflow', { ok: true, headers: headers({ 'content-length': '11', 'content-type': 'application/pdf' }), body: {} }],
        [
            'deceptive low length with chunk overflow',
            {
                ok: true,
                headers: headers({ 'content-length': '1', 'content-type': 'application/pdf' }),
                body: {
                    async *[Symbol.asyncIterator]() {
                        yield Buffer.alloc(6)
                        yield Buffer.alloc(5)
                    }
                }
            }
        ],
        [
            'headerless chunk overflow',
            {
                ok: true,
                headers: headers({ 'content-type': 'application/pdf' }),
                body: {
                    async *[Symbol.asyncIterator]() {
                        yield Buffer.alloc(11)
                    }
                }
            }
        ],
        [
            'unsafe MIME',
            {
                ok: true,
                headers: headers({ 'content-type': 'text/html' }),
                body: {
                    async *[Symbol.asyncIterator]() {
                        yield Buffer.from('sentinel')
                    }
                }
            }
        ]
    ])('performs zero storage writes on %s', async (_name, response) => {
        const store = jest.fn()

        await expect(downloadAndStoreBounded({ getResponse: async () => response, kind: 'file', store, maxBytes: 10 })).rejects.toThrow(
            OPENAI_ASSISTANT_DOWNLOAD_ERROR
        )
        expect(store).not.toHaveBeenCalled()
    })

    it('aborts a hanging download at its deadline and clears the timer', async () => {
        jest.useFakeTimers()
        let signal: AbortSignal | undefined
        const store = jest.fn()
        const result = downloadAndStoreBounded({
            getResponse: (operationSignal) => {
                signal = operationSignal
                return new Promise<never>(() => undefined)
            },
            kind: 'file',
            store,
            timeoutMs: 500
        })
        const rejection = expect(result).rejects.toThrow(OPENAI_ASSISTANT_DOWNLOAD_ERROR)

        await jest.advanceTimersByTimeAsync(500)
        await rejection
        expect(signal?.aborted).toBe(true)
        expect(store).not.toHaveBeenCalled()
        expect(jest.getTimerCount()).toBe(0)
    })

    it('inherits a parent abort during body streaming and performs zero storage writes', async () => {
        const parent = new AbortController()
        const store = jest.fn()
        let bodyStarted!: () => void
        const started = new Promise<void>((resolve) => {
            bodyStarted = resolve
        })
        const result = downloadAndStoreBounded({
            getResponse: async (signal) => ({
                ok: true,
                headers: headers({ 'content-type': 'application/pdf' }),
                body: {
                    async *[Symbol.asyncIterator]() {
                        bodyStarted()
                        yield Buffer.from('first')
                        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
                        yield Buffer.from('second')
                    }
                }
            }),
            kind: 'file',
            store,
            parentSignal: parent.signal,
            deadlineAt: Date.now() + 10_000
        })
        const rejection = expect(result).rejects.toThrow(OPENAI_ASSISTANT_DOWNLOAD_ERROR)

        await started
        parent.abort()
        await rejection
        await Promise.resolve()
        expect(store).not.toHaveBeenCalled()
    })

    it('enforces a shared cumulative download budget before the next storage write', async () => {
        const budget = createDownloadBudget(Date.now() + 10_000, 2, 10)
        const store = jest.fn(async () => 'stored')
        const getResponse = async () => ({
            ok: true,
            headers: headers({ 'content-type': 'application/pdf' }),
            body: {
                async *[Symbol.asyncIterator]() {
                    yield Buffer.alloc(6)
                }
            }
        })

        await expect(downloadAndStoreBounded({ getResponse, kind: 'file', store, budget })).resolves.toBe('stored')
        await expect(downloadAndStoreBounded({ getResponse, kind: 'file', store, budget })).rejects.toThrow(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
        expect(store).toHaveBeenCalledTimes(1)
        expect(budget).toMatchObject({ files: 1, bytes: 6 })
    })

    it.each([
        ['missing content length', {}],
        ['misleading content length', { 'content-length': '1' }]
    ])('bounds a %s body by the remaining shared byte budget', async (_name, lengthHeader) => {
        const budget = Object.assign(createDownloadBudget(Date.now() + 10_000, 2, 10), { bytes: 6 })
        const store = jest.fn()
        const response = {
            ok: true,
            headers: headers({ 'content-type': 'application/pdf', ...lengthHeader }),
            body: {
                async *[Symbol.asyncIterator]() {
                    yield Buffer.alloc(3)
                    yield Buffer.alloc(2)
                }
            }
        }

        await expect(downloadAndStoreBounded({ getResponse: async () => response, kind: 'file', store, budget })).rejects.toThrow(
            OPENAI_ASSISTANT_DOWNLOAD_ERROR
        )
        expect(store).not.toHaveBeenCalled()
        expect(budget).toMatchObject({ files: 0, bytes: 6 })
    })

    it('does not race an irreversible storage commit against the network deadline', async () => {
        jest.useFakeTimers()
        const budget = createDownloadBudget(Date.now() + 100, 2, 10)
        let resolveStore!: (value: string) => void
        const store = jest.fn(
            () =>
                new Promise<string>((resolve) => {
                    resolveStore = resolve
                })
        )
        const result = downloadAndStoreBounded({
            getResponse: async () => ({
                ok: true,
                headers: headers({ 'content-type': 'application/pdf' }),
                body: {
                    async *[Symbol.asyncIterator]() {
                        yield Buffer.alloc(6)
                    }
                }
            }),
            kind: 'file',
            store,
            budget,
            timeoutMs: 100
        })

        for (let attempt = 0; attempt < 10 && store.mock.calls.length === 0; attempt += 1) await Promise.resolve()
        expect(store).toHaveBeenCalledTimes(1)
        expect(budget).toMatchObject({ files: 0, bytes: 0 })
        expect(jest.getTimerCount()).toBe(0)

        let settled = false
        void result.finally(() => {
            settled = true
        })
        await jest.advanceTimersByTimeAsync(1_000)
        expect(settled).toBe(false)
        expect(budget).toMatchObject({ files: 0, bytes: 0 })

        resolveStore('stored-after-deadline')
        await expect(result).resolves.toBe('stored-after-deadline')
        expect(budget).toMatchObject({ files: 1, bytes: 6 })
    })

    it('uses a fixed error and leaves the budget untouched when storage commit fails', async () => {
        const budget = createDownloadBudget(Date.now() + 10_000, 2, 10)
        const store = jest.fn(async () => {
            throw new Error('SENTINEL_STORAGE_SECRET')
        })
        const response = {
            ok: true,
            headers: headers({ 'content-type': 'application/pdf' }),
            body: {
                async *[Symbol.asyncIterator]() {
                    yield Buffer.alloc(6)
                }
            }
        }

        const failure = await downloadAndStoreBounded({ getResponse: async () => response, kind: 'file', store, budget }).catch(
            (error) => error
        )

        expect(failure).toBeInstanceOf(Error)
        expect(failure.message).toBe(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
        expect(failure.message).not.toContain('SENTINEL_STORAGE_SECRET')
        expect(budget).toMatchObject({ files: 0, bytes: 0 })
    })

    it('records a committed storage side effect when usage accounting fails', async () => {
        const budget = createDownloadBudget(Date.now() + 10_000, 2, 10)
        const store = jest.fn(async () => 'stored')
        const onStored = jest.fn(async () => {
            throw new Error('SENTINEL_ACCOUNTING_SECRET')
        })
        const response = {
            ok: true,
            headers: headers({ 'content-type': 'application/pdf' }),
            body: {
                async *[Symbol.asyncIterator]() {
                    yield Buffer.alloc(6)
                }
            }
        }

        const failure = await downloadAndStoreBounded({ getResponse: async () => response, kind: 'file', store, budget, onStored }).catch(
            (error) => error
        )

        expect(failure).toBeInstanceOf(Error)
        expect(failure.message).toBe(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
        expect(failure.message).not.toContain('SENTINEL_ACCOUNTING_SECRET')
        expect(store).toHaveBeenCalledTimes(1)
        expect(onStored).toHaveBeenCalledTimes(1)
        expect(budget).toMatchObject({ files: 1, bytes: 6 })
    })

    it.each([
        ['21st file-count limit', Object.assign(createDownloadBudget(Date.now() + 10_000, 20, 100), { files: 20 }), 1],
        ['declared cumulative bytes', Object.assign(createDownloadBudget(Date.now() + 10_000, 20, 10), { bytes: 6 }), 5]
    ])('fails before the Provider body request when the shared %s is exhausted', async (_name, budget, declaredBytes) => {
        const getResponse = jest.fn()
        const store = jest.fn()

        await expect(downloadAndStoreBounded({ getResponse, kind: 'file', store, budget, declaredBytes })).rejects.toThrow(
            OPENAI_ASSISTANT_DOWNLOAD_ERROR
        )
        expect(getResponse).not.toHaveBeenCalled()
        expect(store).not.toHaveBeenCalled()
    })
})
