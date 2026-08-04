import dns from 'dns/promises'
import fs from 'fs'
import fetch, { Response as NodeFetchResponse } from 'node-fetch'
import path from 'path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Readable } from 'stream'

const mockClientConnect = jest.fn()
const mockClientRequest = jest.fn()
const mockClientClose = jest.fn()
let connectedClients: unknown[] = []

jest.mock('node-fetch', () => {
    const actual = jest.requireActual('node-fetch')
    return { ...actual, __esModule: true, default: jest.fn() }
})

import { MCPToolkit } from './core'

const mockedFetch = fetch as unknown as jest.Mock
const sdkStubPrototype = (Client as unknown as { prototype: Record<string, unknown> }).prototype

type TransportFetch = (url: string | URL, init?: RequestInit) => Promise<Response>

const createConnectedToolkit = async (url = 'https://8.8.8.8/mcp', headers: Record<string, string> = {}) => {
    mockClientConnect.mockResolvedValue(undefined)
    const toolkit = new MCPToolkit({ url, headers }, 'sse')
    await toolkit.createClient()
    const transport = mockClientConnect.mock.calls.at(-1)?.[0] as { __args: unknown[] }
    const options = transport.__args[1] as Record<string, any>
    return { toolkit, options, transportFetch: options.fetch as TransportFetch }
}

describe('MCP fixed-origin HTTP transport', () => {
    const originalSecurityCheck = process.env.HTTP_SECURITY_CHECK
    const originalDenyList = process.env.HTTP_DENY_LIST

    beforeEach(() => {
        jest.clearAllMocks()
        connectedClients = []
        sdkStubPrototype.connect = function (this: unknown, ...args: unknown[]) {
            connectedClients.push(this)
            return mockClientConnect(...args)
        }
        sdkStubPrototype.request = (...args: unknown[]) => mockClientRequest(...args)
        sdkStubPrototype.close = (...args: unknown[]) => mockClientClose(...args)
        process.env.HTTP_SECURITY_CHECK = 'false'
        process.env.HTTP_DENY_LIST = ''
    })

    afterEach(() => {
        jest.restoreAllMocks()
        if (originalSecurityCheck === undefined) delete process.env.HTTP_SECURITY_CHECK
        else process.env.HTTP_SECURITY_CHECK = originalSecurityCheck
        if (originalDenyList === undefined) delete process.env.HTTP_DENY_LIST
        else process.env.HTTP_DENY_LIST = originalDenyList
    })

    it.each([
        ['GET', undefined],
        ['POST', '{"jsonrpc":"2.0"}'],
        ['DELETE', undefined]
    ])('routes Streamable HTTP %s through the pinned secure fetch', async (method, body) => {
        mockedFetch.mockResolvedValueOnce(new NodeFetchResponse('ok', { status: 200 }))
        const { options, transportFetch } = await createConnectedToolkit('https://8.8.8.8/mcp', {
            Authorization: 'Bearer configured-token'
        })

        const response = await transportFetch('https://8.8.8.8/mcp', {
            method,
            ...(body === undefined ? {} : { body })
        })

        expect(response).toBeInstanceOf(globalThis.Response)
        await expect(response.text()).resolves.toBe('ok')
        expect(options).toEqual(
            expect.objectContaining({
                requestInit: { headers: { Authorization: 'Bearer configured-token' } },
                fetch: expect.any(Function)
            })
        )
        expect(mockedFetch).toHaveBeenCalledTimes(1)
        expect(mockedFetch.mock.calls[0][0]).toBe('https://8.8.8.8/mcp')
        expect(mockedFetch.mock.calls[0][1]).toEqual(
            expect.objectContaining({ method, ...(body === undefined ? {} : { body }), redirect: 'manual', agent: expect.any(Function) })
        )
    })

    it('keeps SDK attempts to disable HTTP resource limits within the shared defaults', async () => {
        mockedFetch.mockResolvedValueOnce(new NodeFetchResponse('ok', { status: 200 }))
        const { transportFetch } = await createConnectedToolkit()

        const response = await transportFetch('https://8.8.8.8/mcp', {
            method: 'POST',
            body: '{}',
            timeout: 0,
            size: 0,
            maxBodyLength: -1
        } as never)
        await expect(response.text()).resolves.toBe('ok')

        expect(mockedFetch.mock.calls[0][1]).toEqual(
            expect.objectContaining({
                timeout: 10 * 60 * 1000,
                size: 32 * 1024 * 1024,
                signal: expect.any(Object)
            })
        )
    })

    it('rejects an oversized declared MCP response before exposing it to the SDK bridge', async () => {
        mockedFetch.mockResolvedValueOnce(
            new NodeFetchResponse('', { status: 200, headers: { 'content-length': String(32 * 1024 * 1024 + 1) } })
        )
        const { transportFetch } = await createConnectedToolkit()

        await expect(transportFetch('https://8.8.8.8/mcp')).rejects.toThrow('MCP transport request failed.')
    })

    it.each([204, 205, 304])('destroys the hidden raw body before bridging empty HTTP %s to the SDK', async (status) => {
        const source = new Readable({
            read() {
                // An empty-status response body must never be exposed or retained.
            }
        })
        mockedFetch.mockResolvedValueOnce({
            status,
            statusText: '',
            headers: new (jest.requireActual('node-fetch').Headers)(),
            body: source,
            url: 'https://8.8.8.8/mcp'
        })
        const { transportFetch } = await createConnectedToolkit()

        const response = await transportFetch('https://8.8.8.8/mcp')

        expect(response.status).toBe(status)
        expect(response.body).toBeNull()
        expect(source.destroyed).toBe(true)
    })

    it('cancels a hidden web-style raw body before bridging an empty response to the SDK', async () => {
        const cancel = jest.fn().mockResolvedValue(undefined)
        mockedFetch.mockResolvedValueOnce({
            status: 204,
            statusText: '',
            headers: new (jest.requireActual('node-fetch').Headers)(),
            body: { cancel },
            url: 'https://8.8.8.8/mcp'
        })
        const { transportFetch } = await createConnectedToolkit()

        const response = await transportFetch('https://8.8.8.8/mcp')

        expect(response.status).toBe(204)
        expect(response.body).toBeNull()
        expect(cancel).toHaveBeenCalledTimes(1)
    })

    it('falls back to cancellation when hidden-body destruction throws', async () => {
        const sentinel = 'SENTINEL_EMPTY_BODY_CLEANUP'
        const cancel = jest.fn().mockResolvedValue(undefined)
        mockedFetch.mockResolvedValueOnce({
            status: 204,
            statusText: '',
            headers: new (jest.requireActual('node-fetch').Headers)(),
            body: {
                destroy: () => {
                    throw new Error(sentinel)
                },
                cancel
            },
            url: 'https://8.8.8.8/mcp'
        })
        const { transportFetch } = await createConnectedToolkit()

        const response = await transportFetch('https://8.8.8.8/mcp')

        expect(response.status).toBe(204)
        expect(cancel).toHaveBeenCalledTimes(1)
        expect(JSON.stringify(response.headers)).not.toContain(sentinel)
    })

    it('keeps the MCP web Response bridge behind the raw-stream byte counter', async () => {
        const chunk = Buffer.alloc(1024 * 1024)
        let emitted = 0
        const source = new Readable({
            read() {
                if (emitted >= 33) this.push(null)
                else {
                    emitted += 1
                    this.push(chunk)
                }
            }
        })
        mockedFetch.mockResolvedValueOnce(new NodeFetchResponse(source, { status: 200 }))
        const { transportFetch } = await createConnectedToolkit()
        const response = await transportFetch('https://8.8.8.8/mcp')

        const errorText = await response.arrayBuffer().then(
            () => '',
            (error) => String(error)
        )

        expect(errorText).toContain('HTTP request exceeded a configured resource limit.')
        expect(errorText).not.toContain('8.8.8.8')
    })

    it('uses the same secure fetch for the SSE fallback without logging the raw Streamable error', async () => {
        const sentinel = 'SENTINEL_URL_HEADER_TOKEN'
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
        mockClientConnect.mockRejectedValueOnce(new Error(sentinel)).mockResolvedValueOnce(undefined)
        mockedFetch.mockResolvedValueOnce(new NodeFetchResponse('ok', { status: 200 }))

        const toolkit = new MCPToolkit({ url: 'https://8.8.8.8/mcp', headers: { Authorization: `Bearer ${sentinel}` } }, 'sse')
        await expect(toolkit.createClient()).resolves.toBeDefined()

        const streamableTransport = mockClientConnect.mock.calls[0][0] as { __args: unknown[] }
        const sseTransport = mockClientConnect.mock.calls[1][0] as { __args: unknown[] }
        const streamableFetch = (streamableTransport.__args[1] as Record<string, any>).fetch as TransportFetch
        const sseOptions = sseTransport.__args[1] as Record<string, any>
        expect(sseOptions).toEqual(
            expect.objectContaining({
                requestInit: { headers: { Authorization: `Bearer ${sentinel}` } },
                fetch: streamableFetch
            })
        )

        await expect(sseOptions.fetch('https://8.8.8.8/mcp', { method: 'POST', body: '{}' })).resolves.toBeInstanceOf(globalThis.Response)
        expect(mockedFetch).toHaveBeenCalledTimes(1)
        expect(JSON.stringify(consoleError.mock.calls)).not.toContain(sentinel)
        expect(mockClientClose).toHaveBeenCalledTimes(1)
        expect(connectedClients).toHaveLength(2)
        expect(connectedClients[1]).not.toBe(connectedClients[0])
    })

    it('normalizes injected header overrides case-insensitively without duplicating business headers', async () => {
        mockClientConnect.mockResolvedValue(undefined)
        const toolkit = new MCPToolkit(
            {
                url: 'https://8.8.8.8/mcp',
                headers: { Authorization: 'Bearer static-token', 'X-Tenant': 'static-tenant' }
            },
            'sse'
        )

        await toolkit.createClient({ authorization: 'Bearer dynamic-token', 'x-tenant': 'dynamic-tenant' })

        const transport = mockClientConnect.mock.calls[0][0] as { __args: unknown[] }
        const options = transport.__args[1] as Record<string, any>
        expect(options.requestInit.headers).toEqual({
            Authorization: 'Bearer dynamic-token',
            'X-Tenant': 'dynamic-tenant'
        })
        expect(Object.keys(options.requestInit.headers)).toHaveLength(2)
    })

    it.each([
        ['mixed-case Host', { hOsT: 'attacker.example' }],
        ['mixed-case Connection', { CoNnEcTiOn: 'keep-alive' }],
        ['forwarded routing', { 'X-FoRwArDeD-HoSt': 'attacker.example' }]
    ])('rejects a forbidden static %s header before SDK connect', async (_label, headers) => {
        const toolkit = new MCPToolkit({ url: 'https://8.8.8.8/mcp', headers }, 'sse')

        await expect(toolkit.createClient()).rejects.toThrow('MCP transport connection failed.')
        expect(mockClientConnect).not.toHaveBeenCalled()
        expect(mockedFetch).not.toHaveBeenCalled()
    })

    it('rejects a forbidden injected header before it can override the static header set', async () => {
        const sentinel = 'SENTINEL_PROXY_AUTH_TOKEN'
        const toolkit = new MCPToolkit({ url: 'https://8.8.8.8/mcp', headers: { Authorization: 'Bearer safe-token' } }, 'sse')

        const errorText = await toolkit.createClient({ 'pRoXy-AuThOrIzAtIoN': `Bearer ${sentinel}` }).then(
            () => '',
            (error) => String(error)
        )

        expect(errorText).toBe('Error: MCP transport connection failed.')
        expect(errorText).not.toContain(sentinel)
        expect(mockClientConnect).not.toHaveBeenCalled()
        expect(mockedFetch).not.toHaveBeenCalled()
    })

    it.each([
        ['count', Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`X-Header-${index}`, 'value']))],
        ['single value bytes', { 'X-Oversized': 'x'.repeat(8 * 1024 + 1) }],
        ['total bytes', Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`X-Total-${index}`, 'x'.repeat(1024)]))]
    ])('rejects MCP headers that exceed the %s limit before SDK connect', async (_label, headers) => {
        const toolkit = new MCPToolkit({ url: 'https://8.8.8.8/mcp', headers }, 'sse')

        await expect(toolkit.createClient()).rejects.toThrow('MCP transport connection failed.')
        expect(mockClientConnect).not.toHaveBeenCalled()
        expect(mockedFetch).not.toHaveBeenCalled()
    })

    it('rejects a cross-origin redirect before a second request and does not forward sensitive headers', async () => {
        const sentinel = 'SENTINEL_AUTHORIZATION_VALUE'
        mockedFetch.mockResolvedValueOnce(
            new NodeFetchResponse('', { status: 307, headers: { location: 'https://1.1.1.1/private-target' } })
        )
        const { transportFetch } = await createConnectedToolkit()

        const errorText = await transportFetch('https://8.8.8.8/mcp', {
            method: 'POST',
            headers: { Authorization: `Bearer ${sentinel}` },
            body: '{}'
        }).then(
            () => '',
            (error) => String(error)
        )

        expect(errorText).toBe('Error: MCP transport request failed.')
        expect(errorText).not.toContain(sentinel)
        expect(errorText).not.toContain('1.1.1.1')
        expect(mockedFetch).toHaveBeenCalledTimes(1)
    })

    it('blocks DNS rebinding on a same-origin redirect before a second request', async () => {
        const lookup = jest
            .spyOn(dns, 'lookup')
            .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }] as never)
            .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }] as never)
        mockedFetch.mockResolvedValueOnce(new NodeFetchResponse('', { status: 307, headers: { location: '/next' } }))
        const { transportFetch } = await createConnectedToolkit('https://mcp.fixture.invalid/start')

        await expect(transportFetch('https://mcp.fixture.invalid/start', { method: 'GET' })).rejects.toThrow(
            'MCP transport request failed.'
        )

        expect(lookup).toHaveBeenCalledTimes(2)
        expect(mockedFetch).toHaveBeenCalledTimes(1)
    })

    it('rejects plaintext MCP endpoints before SDK connect even when the global security switch is disabled', async () => {
        const sentinel = 'SENTINEL_PLAINTEXT_AUTH_TOKEN'
        const toolkit = new MCPToolkit({ url: 'http://8.8.8.8/mcp', headers: { Authorization: `Bearer ${sentinel}` } }, 'sse')

        const errorText = await toolkit.createClient().then(
            () => '',
            (error) => String(error)
        )

        expect(errorText).toBe('Error: MCP transport connection failed.')
        expect(errorText).not.toContain(sentinel)
        expect(mockClientConnect).not.toHaveBeenCalled()
        expect(mockedFetch).not.toHaveBeenCalled()
    })

    it('turns an informational HTTP response into a fixed transport failure', async () => {
        mockedFetch.mockResolvedValueOnce({
            status: 101,
            headers: new globalThis.Headers(),
            body: null
        })
        const { transportFetch } = await createConnectedToolkit()

        await expect(transportFetch('https://8.8.8.8/mcp')).rejects.toThrow('MCP transport request failed.')
    })

    it('returns and logs only fixed messages when both HTTP transports reject secret-bearing errors', async () => {
        const sentinel = 'SENTINEL_ENDPOINT_HEADER_TOKEN'
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
        mockClientConnect.mockRejectedValue(new Error(`https://secret.invalid ${sentinel}`))
        const toolkit = new MCPToolkit({ url: 'https://8.8.8.8/mcp', headers: { Authorization: `Bearer ${sentinel}` } }, 'sse')

        const errorText = await toolkit.createClient().then(
            () => '',
            (error) => String(error)
        )

        expect(errorText).toBe('Error: MCP transport connection failed.')
        expect(errorText).not.toContain(sentinel)
        expect(errorText).not.toContain('secret.invalid')
        expect(JSON.stringify(consoleError.mock.calls)).not.toContain(sentinel)
        expect(JSON.stringify(consoleError.mock.calls)).not.toContain('secret.invalid')
        expect(connectedClients).toHaveLength(2)
        expect(mockClientClose).toHaveBeenCalledTimes(2)
    })

    it('redacts a secret-bearing tools/list failure and still closes the client', async () => {
        const sentinel = 'SENTINEL_REMOTE_TOOLS_ERROR'
        mockClientConnect.mockResolvedValue(undefined)
        mockClientRequest.mockRejectedValueOnce(new Error(sentinel))
        mockClientClose.mockResolvedValue(undefined)
        const toolkit = new MCPToolkit({ url: 'https://8.8.8.8/mcp' }, 'sse')

        const errorText = await toolkit.initialize().then(
            () => '',
            (error) => String(error)
        )

        expect(errorText).toBe('Error: MCP initialization failed.')
        expect(errorText).not.toContain(sentinel)
        expect(mockClientClose).toHaveBeenCalledTimes(1)
    })

    it('keeps Custom MCP action-selection parse failures out of raw console output', () => {
        const source = fs.readFileSync(path.join(__dirname, 'CustomMcpServerTool', 'CustomMcpServerTool.ts'), 'utf8')

        expect(source).not.toContain("console.error('Error parsing mcp actions:', error)")
        expect(source).toMatch(/catch\s*\{[\s\S]*?mcpActions\s*=\s*\[\]/)
    })
})
