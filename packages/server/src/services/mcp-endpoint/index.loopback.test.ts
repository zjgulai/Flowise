import express from 'express'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const mockGetChatflowByIdAndVerifyToken = jest.fn()
const mockParseMcpConfig = jest.fn()
const mockUtilBuildChatflow = jest.fn()

jest.mock('../mcp-server/index', () => ({
    __esModule: true,
    default: {
        getChatflowByIdAndVerifyToken: (...args: any[]) => mockGetChatflowByIdAndVerifyToken(...args),
        parseMcpConfig: (...args: any[]) => mockParseMcpConfig(...args)
    }
}))

jest.mock('../../utils/buildChatflow', () => ({
    utilBuildChatflow: (...args: any[]) => mockUtilBuildChatflow(...args)
}))

jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}))

import mcpEndpointService from '.'

type Deferred<T> = {
    promise: Promise<T>
    resolve: (value: T) => void
    reject: (reason?: unknown) => void
}

const deferred = <T>(): Deferred<T> => {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

const withTimeout = async <T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs)
            })
        ])
    } finally {
        if (timer) clearTimeout(timer)
    }
}

const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
        name: 'test_tool',
        arguments: {
            question: 'hello'
        }
    }
})

describe('MCP endpoint real SDK/Express loopback', () => {
    let server: http.Server
    let port: number
    let requestCount: number
    let releasePendingBuild: Deferred<string> | undefined
    let requestHandled: Deferred<void>
    let clientDisconnected: Deferred<void>

    beforeEach(async () => {
        jest.clearAllMocks()
        requestCount = 0
        releasePendingBuild = undefined
        requestHandled = deferred<void>()
        clientDisconnected = deferred<void>()

        mockGetChatflowByIdAndVerifyToken.mockResolvedValue({
            id: 'flow-123',
            name: 'Test Chatflow',
            type: 'CHATFLOW',
            workspaceId: 'ws-1'
        })
        mockParseMcpConfig.mockReturnValue({
            enabled: true,
            token: 'a'.repeat(32),
            description: 'Test description',
            toolName: 'test_tool'
        })
        mockUtilBuildChatflow.mockResolvedValue('loopback answer')

        const app = express()
        app.use(express.json())
        app.post('/mcp', (req, res) => {
            requestCount += 1
            res.once('close', () => clientDisconnected.resolve())
            void mcpEndpointService
                .handleMcpRequest('flow-123', 'token', req, res)
                .catch((error) => {
                    if (!res.headersSent && !res.destroyed) {
                        res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
                    }
                })
                .finally(() => requestHandled.resolve())
        })

        server = http.createServer(app)
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(0, '127.0.0.1', () => {
                server.removeListener('error', reject)
                resolve()
            })
        })
        port = (server.address() as AddressInfo).port
    })

    afterEach(async () => {
        releasePendingBuild?.resolve('late result')
        server.closeAllConnections?.()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })

    const startRequest = () => {
        const responseReady = deferred<http.IncomingMessage>()
        const request = http.request(
            {
                hostname: '127.0.0.1',
                port,
                path: '/mcp',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Accept: 'application/json, text/event-stream',
                    'MCP-Protocol-Version': '2025-03-26',
                    'Content-Length': Buffer.byteLength(payload)
                }
            },
            (response) => responseReady.resolve(response)
        )
        request.on('error', () => {
            // ECONNRESET is expected in the deliberate disconnect test.
        })
        request.end(payload)
        return { request, responseReady }
    }

    it('writes a real MCP SSE tool response through Express', async () => {
        const { responseReady } = startRequest()
        const response = await withTimeout(responseReady.promise)
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        await withTimeout(new Promise<void>((resolve, reject) => response.once('end', resolve).once('error', reject)))

        const body = Buffer.concat(chunks).toString('utf8')
        expect(response.statusCode).toBe(200)
        expect(response.headers['content-type']).toContain('text/event-stream')
        expect(body).toContain('loopback answer')
        expect(requestCount).toBe(1)
        expect(mockUtilBuildChatflow).toHaveBeenCalledTimes(1)
    })

    it('aborts the Flow signal when the TCP/SSE client disconnects early', async () => {
        const toolStarted = deferred<AbortSignal>()
        const executionAborted = deferred<void>()
        releasePendingBuild = deferred<string>()

        mockUtilBuildChatflow.mockImplementation((_req, _isInternal, _chatType, options: { signal: AbortSignal }) => {
            const signal = options.signal
            toolStarted.resolve(signal)
            return new Promise<string>((resolve, reject) => {
                const onAbort = () => {
                    executionAborted.resolve()
                    reject(new Error('request aborted'))
                }
                if (signal.aborted) {
                    onAbort()
                    return
                }
                signal.addEventListener('abort', onAbort, { once: true })
                releasePendingBuild?.promise.then((value) => {
                    signal.removeEventListener('abort', onAbort)
                    resolve(value)
                })
            })
        })

        const { responseReady } = startRequest()
        const [response, signal] = await withTimeout(Promise.all([responseReady.promise, toolStarted.promise]))

        expect(response.statusCode).toBe(200)
        expect(response.headers['content-type']).toContain('text/event-stream')
        expect(signal.aborted).toBe(false)

        response.destroy(new Error('intentional client disconnect'))

        await withTimeout(executionAborted.promise)
        expect(signal.aborted).toBe(true)
        expect(mockUtilBuildChatflow).toHaveBeenCalledTimes(1)
        expect(requestCount).toBe(1)
    })

    it('does not start a tool when the client disconnects during token verification', async () => {
        const authStarted = deferred<void>()
        const releaseAuth = deferred<Record<string, unknown>>()
        mockGetChatflowByIdAndVerifyToken.mockImplementation(() => {
            authStarted.resolve()
            return releaseAuth.promise
        })

        const { request } = startRequest()
        await withTimeout(authStarted.promise)
        request.destroy()
        await withTimeout(clientDisconnected.promise)
        releaseAuth.resolve({
            id: 'flow-123',
            name: 'Test Chatflow',
            type: 'CHATFLOW',
            workspaceId: 'ws-1'
        })
        await withTimeout(requestHandled.promise)

        expect(mockUtilBuildChatflow).not.toHaveBeenCalled()
        expect(requestCount).toBe(1)
    })
})
