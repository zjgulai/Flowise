import { INodeOptionsValue } from '../../../src/Interface'

export const OPENAI_ASSISTANT_SCOPE_ERROR = 'OpenAI Assistant workspace context is required'
export const OPENAI_ASSISTANT_CHATFLOW_ERROR = 'OpenAI Assistant chatflow context is required'
export const OPENAI_ASSISTANT_SESSION_ERROR = 'OpenAI Assistant session context is invalid'
export const OPENAI_ASSISTANT_SELECTION_ERROR = 'OpenAI Assistant selection is required'
export const OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR = 'OpenAI Assistant tool request rejected'
export const OPENAI_ASSISTANT_POLL_TIMEOUT_ERROR = 'OpenAI Assistant polling timed out'
export const OPENAI_ASSISTANT_POLL_FAILED_ERROR = 'OpenAI Assistant polling failed'
export const OPENAI_ASSISTANT_DOWNLOAD_ERROR = 'OpenAI Assistant file download failed'

const DEFAULT_MAX_WAIT_MS = 30_000
const DEFAULT_INITIAL_DELAY_MS = 500
const DEFAULT_MAX_DELAY_MS = 4_000
const DEFAULT_MAX_RETRIES = 10
export const OPENAI_ASSISTANT_MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024
export const OPENAI_ASSISTANT_DOWNLOAD_TIMEOUT_MS = 30_000
export const OPENAI_ASSISTANT_MAX_DOWNLOAD_FILES = 20
export const OPENAI_ASSISTANT_MAX_TOTAL_DOWNLOAD_BYTES = 100 * 1024 * 1024

export function requireWorkspaceId(options: Record<string, any>): string {
    const workspaceId = typeof options?.workspaceId === 'string' ? options.workspaceId.trim() : ''
    if (!workspaceId) throw new Error(OPENAI_ASSISTANT_SCOPE_ERROR)
    return workspaceId
}

export function requireChatflowId(options: Record<string, any>): string {
    const chatflowId = typeof options?.chatflowid === 'string' ? options.chatflowid.trim() : ''
    if (!chatflowId) throw new Error(OPENAI_ASSISTANT_CHATFLOW_ERROR)
    return chatflowId
}

export function requireSelectedAssistantId(value: unknown): string {
    const assistantId = typeof value === 'string' ? value.trim() : ''
    if (!assistantId) throw new Error(OPENAI_ASSISTANT_SELECTION_ERROR)
    return assistantId
}

export function toAssistantOption(assistant: { id?: unknown; details?: unknown }): INodeOptionsValue | undefined {
    if (typeof assistant?.id !== 'string' || !assistant.id.trim() || typeof assistant.details !== 'string') return undefined

    try {
        const details = JSON.parse(assistant.details)
        if (!details || typeof details !== 'object' || Array.isArray(details)) return undefined

        const name = typeof details.name === 'string' ? details.name.trim() : ''
        const safeIdExcerpt = assistant.id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'unknown'
        return {
            name: assistant.id,
            label: name || `未命名助手（${safeIdExcerpt}）`
        }
    } catch {
        return undefined
    }
}

export function buildPerRunTools(providerTools: any[] = [], flowTools: any[] = []): any[] {
    const candidates = [
        ...providerTools.filter((tool) => tool && tool.type !== 'function'),
        ...flowTools.filter((tool) => tool?.type === 'function' && tool.function)
    ]

    return candidates.filter((candidate, index) => {
        const serialized = JSON.stringify(candidate)
        return candidates.findIndex((tool) => JSON.stringify(tool) === serialized) === index
    })
}

export interface ToolExecutionBudget {
    rounds: number
    calls: number
    readonly maxRounds: number
    readonly maxCalls: number
    readonly seenToolCallIds: Set<string>
    readonly deadlineAt: number
    outputBytes: number
    readonly maxOutputBytes: number
    readonly maxSingleOutputBytes: number
}

export interface DownloadBudget {
    files: number
    bytes: number
    readonly maxFiles: number
    readonly maxBytes: number
    readonly deadlineAt: number
}

export interface IrreversibleCommitTracker {
    run<TResult>(operation: () => Promise<TResult>): Promise<TResult>
    waitForIdle(): Promise<void>
}

export function createIrreversibleCommitTracker(): IrreversibleCommitTracker {
    const active = new Set<Promise<unknown>>()

    return {
        run<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
            let operationPromise: Promise<TResult>
            try {
                // Start the irreversible operation synchronously with registration.
                // This prevents a deadline callback from observing an empty tracker
                // after the write has already started.
                operationPromise = operation()
            } catch (error) {
                return Promise.reject(error)
            }

            const trackedPromise = operationPromise.finally(() => {
                active.delete(trackedPromise)
            })
            active.add(trackedPromise)
            return trackedPromise
        },
        async waitForIdle(): Promise<void> {
            while (active.size > 0) {
                await Promise.allSettled([...active])
            }
        }
    }
}

export interface PreparedToolAction {
    tool: any
    toolInput: Record<string, unknown>
    toolCallId: string
}

export function createToolExecutionBudget(
    maxRounds = 20,
    maxCalls = 64,
    deadlineAt = Date.now() + DEFAULT_MAX_WAIT_MS,
    maxOutputBytes = 4 * 1024 * 1024,
    maxSingleOutputBytes = 1024 * 1024
): ToolExecutionBudget {
    return {
        rounds: 0,
        calls: 0,
        maxRounds,
        maxCalls,
        seenToolCallIds: new Set<string>(),
        deadlineAt,
        outputBytes: 0,
        maxOutputBytes,
        maxSingleOutputBytes
    }
}

export function createDownloadBudget(
    deadlineAt = Date.now() + OPENAI_ASSISTANT_DOWNLOAD_TIMEOUT_MS,
    maxFiles = OPENAI_ASSISTANT_MAX_DOWNLOAD_FILES,
    maxBytes = OPENAI_ASSISTANT_MAX_TOTAL_DOWNLOAD_BYTES
): DownloadBudget {
    return { files: 0, bytes: 0, maxFiles, maxBytes, deadlineAt }
}

export function prepareToolActions(toolCalls: any[], tools: any[], budget: ToolExecutionBudget): PreparedToolAction[] {
    if (Date.now() >= budget.deadlineAt) throw new Error(OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR)
    if (!Array.isArray(toolCalls) || !toolCalls.length) throw new Error(OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR)

    const prepared = toolCalls.map((toolCall) => {
        const toolCallId = typeof toolCall?.id === 'string' ? toolCall.id : ''
        const functionName = typeof toolCall?.function?.name === 'string' ? toolCall.function.name : ''
        const rawArguments = toolCall?.function?.arguments
        if (!toolCallId || !functionName || typeof rawArguments !== 'string') {
            throw new Error(OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR)
        }

        let toolInput: unknown
        try {
            toolInput = JSON.parse(rawArguments)
        } catch {
            throw new Error(OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR)
        }
        if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
            throw new Error(OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR)
        }

        const tool = tools.find((candidate) => candidate?.name === functionName)
        if (!tool || typeof tool.call !== 'function') throw new Error(OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR)

        return { tool, toolInput: toolInput as Record<string, unknown>, toolCallId }
    })

    if (budget.rounds + 1 > budget.maxRounds || budget.calls + prepared.length > budget.maxCalls) {
        throw new Error(OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR)
    }
    if (new Set(prepared.map((action) => action.toolCallId)).size !== prepared.length) {
        throw new Error(OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR)
    }
    if (prepared.some((action) => budget.seenToolCallIds.has(action.toolCallId))) {
        throw new Error(OPENAI_ASSISTANT_TOOL_PROTOCOL_ERROR)
    }

    budget.rounds += 1
    budget.calls += prepared.length
    prepared.forEach((action) => budget.seenToolCallIds.add(action.toolCallId))
    return prepared
}

export interface SerialPollOptions<T, TResult> {
    operation: (signal: AbortSignal) => Promise<T>
    evaluate: (value: T) => { done: true; value: TResult } | { done: false }
    maxWaitMs?: number
    initialDelayMs?: number
    maxDelayMs?: number
    maxRetries?: number
    now?: () => number
    sleep?: (delayMs: number) => Promise<void>
    onRetry?: () => void
}

function getErrorStatus(error: any): number | undefined {
    const status = error?.status ?? error?.response?.status
    return typeof status === 'number' ? status : undefined
}

export function isRetryablePollingError(error: any): boolean {
    const status = getErrorStatus(error)
    if (status === 408 || status === 409 || status === 425 || status === 429 || (status !== undefined && status >= 500)) return true
    return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error?.code)
}

export async function serialPoll<T, TResult>(options: SerialPollOptions<T, TResult>): Promise<TResult> {
    const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
    const initialDelayMs = options.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS
    const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES
    const now = options.now ?? Date.now
    const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)))
    const startedAt = now()
    let delayMs = initialDelayMs
    let retries = 0
    const controller = new AbortController()

    const wait = async (requestedDelayMs: number) => {
        const remainingMs = maxWaitMs - (now() - startedAt)
        if (remainingMs <= 0) throw new Error(OPENAI_ASSISTANT_POLL_TIMEOUT_ERROR)
        await sleep(Math.min(requestedDelayMs, remainingMs))
    }

    const runOperation = async () => {
        const remainingMs = maxWaitMs - (now() - startedAt)
        if (remainingMs <= 0) throw new Error(OPENAI_ASSISTANT_POLL_TIMEOUT_ERROR)
        let timeout: ReturnType<typeof setTimeout> | undefined
        const timeoutPromise = new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
                controller.abort()
                reject(new Error(OPENAI_ASSISTANT_POLL_TIMEOUT_ERROR))
            }, remainingMs)
        })
        try {
            return await Promise.race([options.operation(controller.signal), timeoutPromise])
        } finally {
            if (timeout) clearTimeout(timeout)
        }
    }

    try {
        while (now() - startedAt < maxWaitMs) {
            try {
                const value = await runOperation()
                if (now() - startedAt >= maxWaitMs) throw new Error(OPENAI_ASSISTANT_POLL_TIMEOUT_ERROR)
                const decision = options.evaluate(value)
                if (decision.done) return decision.value
                delayMs = initialDelayMs
                await wait(delayMs)
            } catch (error) {
                if (error instanceof Error && error.message === OPENAI_ASSISTANT_POLL_TIMEOUT_ERROR) throw error
                if (!isRetryablePollingError(error) || retries >= maxRetries) throw new Error(OPENAI_ASSISTANT_POLL_FAILED_ERROR)
                retries += 1
                options.onRetry?.()
                delayMs = Math.min(delayMs * 2, maxDelayMs)
                await wait(delayMs)
            }
        }

        throw new Error(OPENAI_ASSISTANT_POLL_TIMEOUT_ERROR)
    } finally {
        controller.abort()
    }
}

function getHeader(response: any, name: string): string {
    const value = response?.headers?.get?.(name)
    return typeof value === 'string' ? value.trim() : ''
}

export function assertSafeDownloadResponse(response: any, kind: 'file' | 'image', maxBytes = OPENAI_ASSISTANT_MAX_DOWNLOAD_BYTES): void {
    if (!response?.ok) throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)

    const contentLength = getHeader(response, 'content-length')
    if (contentLength) {
        const declaredBytes = Number(contentLength)
        if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0 || declaredBytes > maxBytes) {
            throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
        }
    }

    const mime = getHeader(response, 'content-type').split(';', 1)[0].toLowerCase()
    if (!mime) throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
    if (kind === 'image' && !(mime.startsWith('image/') || mime === 'application/octet-stream')) {
        throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
    }
    if (['text/html', 'application/xhtml+xml', 'image/svg+xml'].includes(mime)) {
        throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
    }
}

export async function readBoundedResponseBody(response: any, maxBytes = OPENAI_ASSISTANT_MAX_DOWNLOAD_BYTES): Promise<Buffer> {
    const body = response?.body
    if (!body) throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)

    const chunks: Buffer[] = []
    let totalBytes = 0
    const append = (chunk: unknown) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike)
        totalBytes += buffer.length
        if (totalBytes > maxBytes) throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
        chunks.push(buffer)
    }

    if (typeof body.getReader === 'function') {
        const reader = body.getReader()
        try {
            let reading = true
            while (reading) {
                const { done, value } = await reader.read()
                if (done) reading = false
                else append(value)
            }
        } finally {
            reader.releaseLock?.()
        }
    } else if (typeof body[Symbol.asyncIterator] === 'function') {
        for await (const chunk of body) append(chunk)
    } else {
        throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
    }

    return Buffer.concat(chunks, totalBytes)
}

export async function withAbortTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    timeoutMs = OPENAI_ASSISTANT_DOWNLOAD_TIMEOUT_MS,
    parentSignal?: AbortSignal,
    drainAfterAbort?: () => Promise<void>
): Promise<T> {
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    let onParentAbort: (() => void) | undefined
    let resolveAbort!: () => void
    const abortPromise = new Promise<void>((resolve) => {
        resolveAbort = resolve
    })
    timeout = setTimeout(() => {
        controller.abort()
        resolveAbort()
    }, timeoutMs)
    if (parentSignal) {
        onParentAbort = () => {
            controller.abort()
            resolveAbort()
        }
        if (parentSignal.aborted) onParentAbort()
        else parentSignal.addEventListener('abort', onParentAbort, { once: true })
    }

    let operationPromise: Promise<T>
    try {
        operationPromise = operation(controller.signal)
    } catch (error) {
        operationPromise = Promise.reject(error)
    }
    const winner = await Promise.race([
        operationPromise.then(
            (value) => ({ type: 'value' as const, value }),
            (error) => ({ type: 'error' as const, error })
        ),
        abortPromise.then(() => ({ type: 'abort' as const }))
    ])

    try {
        if (winner.type === 'abort') {
            // Network and Provider work is abortable. An already-started storage
            // commit is not: wait for it (and its accounting callback) to reach a
            // definitive result before reporting the deadline to the caller.
            operationPromise.catch(() => undefined)
            await drainAfterAbort?.()
            throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
        }
        if (winner.type === 'error') throw winner.error
        return winner.value
    } finally {
        if (timeout) clearTimeout(timeout)
        if (parentSignal && onParentAbort) parentSignal.removeEventListener('abort', onParentAbort)
        controller.abort()
    }
}

export interface BoundedDownloadOptions<TResult> {
    getResponse: (signal: AbortSignal) => Promise<any>
    kind: 'file' | 'image'
    store: (data: Buffer) => Promise<TResult>
    maxBytes?: number
    timeoutMs?: number
    parentSignal?: AbortSignal
    deadlineAt?: number
    budget?: DownloadBudget
    declaredBytes?: number
    commitTracker?: IrreversibleCommitTracker
    onStored?: (result: TResult) => Promise<void>
}

export async function downloadAndStoreBounded<TResult>(options: BoundedDownloadOptions<TResult>): Promise<TResult> {
    const deadlineAt = options.deadlineAt ?? options.budget?.deadlineAt ?? Date.now() + OPENAI_ASSISTANT_DOWNLOAD_TIMEOUT_MS
    const timeoutMs = Math.min(options.timeoutMs ?? OPENAI_ASSISTANT_DOWNLOAD_TIMEOUT_MS, deadlineAt - Date.now())
    if (timeoutMs <= 0 || options.parentSignal?.aborted) throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
    const perFileMaxBytes = options.maxBytes ?? OPENAI_ASSISTANT_MAX_DOWNLOAD_BYTES
    const remainingBudgetBytes = options.budget ? options.budget.maxBytes - options.budget.bytes : perFileMaxBytes
    const effectiveMaxBytes = Math.min(perFileMaxBytes, remainingBudgetBytes)
    if (!Number.isSafeInteger(effectiveMaxBytes) || effectiveMaxBytes <= 0) throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
    if (options.budget) {
        if (options.budget.files + 1 > options.budget.maxFiles) throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
        if (options.budget.bytes >= options.budget.maxBytes) throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
        if (options.declaredBytes !== undefined) {
            if (!Number.isSafeInteger(options.declaredBytes) || options.declaredBytes < 0) {
                throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
            }
            if (options.declaredBytes > effectiveMaxBytes) {
                throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
            }
        }
    }

    let data: Buffer
    try {
        data = await withAbortTimeout(
            async (signal) => {
                const response = await options.getResponse(signal)
                assertSafeDownloadResponse(response, options.kind, effectiveMaxBytes)
                const downloaded = await readBoundedResponseBody(response, effectiveMaxBytes)
                if (signal.aborted || Date.now() >= deadlineAt) throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
                return downloaded
            },
            timeoutMs,
            options.parentSignal
        )
    } catch {
        throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
    }

    // The deadline and abort signal protect only the cancellable network phase.
    // Once the storage commit starts, await its definitive result instead of
    // returning a timeout while the write continues in the background.
    if (options.parentSignal?.aborted || Date.now() >= deadlineAt) throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
    if (options.budget) {
        if (options.budget.files + 1 > options.budget.maxFiles || options.budget.bytes + data.length > options.budget.maxBytes) {
            throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
        }
    }

    const commit = async () => {
        const result = await options.store(data)
        if (options.budget) {
            // The storage write has committed even if the subsequent accounting
            // callback fails. Record that side effect before awaiting accounting
            // so callers cannot mistake a committed object for a zero-write run.
            options.budget.files += 1
            options.budget.bytes += data.length
        }
        await options.onStored?.(result)
        return result
    }

    try {
        return options.commitTracker ? await options.commitTracker.run(commit) : await commit()
    } catch {
        throw new Error(OPENAI_ASSISTANT_DOWNLOAD_ERROR)
    }
}
