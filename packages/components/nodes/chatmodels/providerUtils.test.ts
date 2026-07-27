import { Headers, Response } from 'node-fetch'
import { secureFetch } from '../../src/httpSecurity'
import {
    buildOriginBoundSecureFetch,
    buildSecureProviderConfiguration,
    parseOptionalProviderNumber,
    parseProviderHeaders,
    requireProviderApiKey,
    resolveProviderBaseUrl,
    toWebResponse
} from './providerUtils'

jest.mock('../../src/httpSecurity', () => ({
    secureFetch: jest.fn()
}))

const deepseekPolicy = {
    providerLabel: 'Deepseek',
    defaultBaseUrl: 'https://api.deepseek.com',
    officialOrigins: ['https://api.deepseek.com'],
    allowlistEnvVar: 'DEEPSEEK_BASE_URL_ALLOWLIST'
}

describe('provider endpoint and input helpers', () => {
    afterEach(() => {
        delete process.env.DEEPSEEK_BASE_URL_ALLOWLIST
        delete process.env.HTTP_SECURITY_CHECK
        jest.clearAllMocks()
    })

    it('uses the official default and normalizes a trailing slash', () => {
        expect(resolveProviderBaseUrl(undefined, deepseekPolicy)).toBe('https://api.deepseek.com')
        expect(resolveProviderBaseUrl('https://api.deepseek.com/', deepseekPolicy)).toBe('https://api.deepseek.com')
        expect(resolveProviderBaseUrl('https://api.deepseek.com/beta/', deepseekPolicy)).toBe('https://api.deepseek.com/beta')
    })

    it.each([
        'http://api.deepseek.com',
        'https://user:password@api.deepseek.com',
        'https://api.deepseek.com?token=value',
        'https://api.deepseek.com/#fragment',
        'https://127.0.0.1/v1',
        'https://example.com/v1',
        'not-a-url'
    ])('rejects unsafe or unlisted endpoint without echoing it: %s', (input) => {
        let message = ''
        try {
            resolveProviderBaseUrl(input, deepseekPolicy)
        } catch (error) {
            message = String(error)
        }

        expect(message).toContain('Deepseek Base Path')
        expect(message).not.toContain(input)
    })

    it('accepts an exact operator-approved HTTPS origin', () => {
        process.env.DEEPSEEK_BASE_URL_ALLOWLIST = 'https://proxy.example.com'

        expect(resolveProviderBaseUrl('https://proxy.example.com/deepseek/v1/', deepseekPolicy)).toBe(
            'https://proxy.example.com/deepseek/v1'
        )
        expect(() => resolveProviderBaseUrl('https://other.example.com/v1', deepseekPolicy)).toThrow(/not allowed/)
    })

    it.each(['http://proxy.example.com', 'https://proxy.example.com/path', 'not-an-origin'])(
        'fails fast on invalid allowlist entry: %s',
        (entry) => {
            process.env.DEEPSEEK_BASE_URL_ALLOWLIST = entry
            expect(() => resolveProviderBaseUrl(undefined, deepseekPolicy)).toThrow(/DEEPSEEK_BASE_URL_ALLOWLIST/)
        }
    )

    it('parses and validates provider headers', () => {
        expect(parseProviderHeaders(undefined, 'Deepseek')).toBeUndefined()
        expect(parseProviderHeaders('{"X-Trace-Mode":"test"}', 'Deepseek')).toEqual({ 'X-Trace-Mode': 'test' })
        expect(parseProviderHeaders({ 'X-Trace-Mode': 'test' }, 'Deepseek')).toEqual({ 'X-Trace-Mode': 'test' })
    })

    it.each(['Authorization', 'authorization', 'X-Api-Key', 'x-API-key', 'X-Auth-Token', 'x-amz-security-token'])(
        'rejects provider credential header %s case-insensitively',
        (name) => {
            expect(() => parseProviderHeaders({ [name]: 'fixture-secret' }, 'Deepseek')).toThrow(/Base Options.*credential header/i)
        }
    )

    it.each([
        ['Host', 'models.example.com', /not allowed/i],
        ['Authorization', 'Bearer fixture-secret', /credential header/i],
        ['Connection', 'keep-alive', /not allowed/i],
        ['X-Trace-Mode', 'fixture\r\nHost: internal.example', /control characters/i]
    ])('rejects unsafe provider header %s', (name, value, expectedError) => {
        expect(() => parseProviderHeaders({ [name]: value }, 'Deepseek')).toThrow(expectedError as RegExp)
    })

    it.each(['["not-an-object"]', '{bad json', { 'X-Bad': 'line\r\nInjected: yes' }, { 'X-Bad': 42 }])(
        'rejects malformed provider headers %#',
        (headers) => {
            expect(() => parseProviderHeaders(headers, 'Deepseek')).toThrow(/Deepseek Base Options/)
        }
    )

    it('parses finite optional numbers and positive integers', () => {
        expect(parseOptionalProviderNumber(undefined, 'Timeout')).toBeUndefined()
        expect(parseOptionalProviderNumber('', 'Timeout')).toBeUndefined()
        expect(parseOptionalProviderNumber('0.8', 'Top Probability')).toBe(0.8)
        expect(parseOptionalProviderNumber('2048', 'Max Tokens', { integer: true, min: 1 })).toBe(2048)
    })

    it.each([
        ['20seconds', 'Timeout', undefined],
        ['NaN', 'Temperature', undefined],
        ['2.5', 'Max Tokens', { integer: true }],
        ['0', 'Max Tokens', { integer: true, min: 1 }]
    ])('rejects invalid numeric value %#', (value, label, options) => {
        expect(() => parseOptionalProviderNumber(value, label as string, options as any)).toThrow(label as string)
    })

    it('requires a non-empty provider API key without exposing values', () => {
        expect(requireProviderApiKey('  fixture-key  ', 'Deepseek')).toBe('fixture-key')
        expect(() => requireProviderApiKey(undefined, 'Deepseek')).toThrow('Deepseek API key is required')
        expect(() => requireProviderApiKey('   ', 'Deepseek')).toThrow('Deepseek API key is required')
    })

    it('builds an origin-bound client configuration that delegates to secureFetch', async () => {
        ;(secureFetch as jest.Mock).mockResolvedValue(new Response('{}', { status: 200 }))
        const configuration = buildSecureProviderConfiguration('https://api.deepseek.com', { 'X-Trace-Mode': 'test' })

        expect(configuration.baseURL).toBe('https://api.deepseek.com')
        expect(configuration.defaultHeaders).toEqual({ 'X-Trace-Mode': 'test' })
        expect(configuration.fetch).toEqual(expect.any(Function))

        await configuration.fetch?.('https://api.deepseek.com/models', { method: 'GET' })

        expect(secureFetch).toHaveBeenCalledWith(
            'https://api.deepseek.com/models',
            expect.objectContaining({ method: 'GET' }),
            5,
            undefined,
            expect.objectContaining({ enforceDefaultDenyList: false, validateUrl: expect.any(Function) })
        )

        const policy = (secureFetch as jest.Mock).mock.calls[0][4]
        expect(() => policy.validateUrl(new URL('https://api.deepseek.com/redirect'))).not.toThrow()
        expect(() => policy.validateUrl(new URL('https://other.example.com/redirect'))).toThrow(/origin/i)
        expect(() => policy.validateUrl(new URL('http://api.deepseek.com/redirect'))).toThrow(/HTTPS/i)
    })

    it('returns a WHATWG streaming response while keeping requests on the configured origin', async () => {
        ;(secureFetch as jest.Mock).mockResolvedValue(
            new Response(Buffer.from('stream-fixture'), {
                status: 200,
                headers: { 'content-type': 'text/plain' }
            })
        )
        const providerFetch = buildOriginBoundSecureFetch('https://api.deepseek.com/v1')

        const response = await providerFetch('https://api.deepseek.com/v1/chat/completions', { method: 'POST', body: '{}' })

        expect(response).toBeInstanceOf(globalThis.Response)
        expect(response.body?.getReader).toEqual(expect.any(Function))
        const reader = response.body!.getReader()
        const chunks: Uint8Array[] = []
        let result: ReadableStreamReadResult<Uint8Array>
        do {
            result = await reader.read()
            if (!result.done) chunks.push(result.value)
        } while (!result.done)
        expect(Buffer.concat(chunks).toString()).toBe('stream-fixture')

        const policy = (secureFetch as jest.Mock).mock.calls[0][4]
        expect(() => policy.validateUrl(new URL('https://api.deepseek.com/v1/next'))).not.toThrow()
        expect(() => policy.validateUrl(new URL('https://redirect.example/v1/next'))).toThrow(/origin/i)
    })

    it('preserves Request method, headers, body, and signal when delegating to secureFetch', async () => {
        ;(secureFetch as jest.Mock).mockResolvedValue(new Response('{}', { status: 200 }))
        const controller = new AbortController()
        const request = new globalThis.Request('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'X-Request-Fixture': 'preserved' },
            body: 'request-body',
            signal: controller.signal
        })
        const providerFetch = buildOriginBoundSecureFetch('https://api.deepseek.com/v1')

        await providerFetch(request)

        const forwardedInit = (secureFetch as jest.Mock).mock.calls[0][1]
        expect(forwardedInit.method).toBe('POST')
        expect(new Headers(forwardedInit.headers).get('x-request-fixture')).toBe('preserved')
        expect(Buffer.from(forwardedInit.body).toString()).toBe('request-body')
        expect(forwardedInit.signal.aborted).toBe(false)
        controller.abort()
        expect(forwardedInit.signal.aborted).toBe(true)
    })

    it('supports a Buffer fixture body when bridging to a WHATWG response', async () => {
        const response = toWebResponse({
            body: Buffer.from('buffer-fixture'),
            headers: new Headers({ 'content-type': 'text/plain' }),
            status: 200,
            statusText: 'OK',
            url: 'https://api.deepseek.com/v1/models'
        } as unknown as Response)

        expect(response.body?.getReader).toEqual(expect.any(Function))
        expect(await response.text()).toBe('buffer-fixture')
        expect(response.url).toBe('https://api.deepseek.com/v1/models')
    })

    it('requires the explicit security opt-out for plain HTTP local providers', async () => {
        expect(() => buildOriginBoundSecureFetch('http://127.0.0.1:11434')).toThrow(/HTTP_SECURITY_CHECK=false/)

        process.env.HTTP_SECURITY_CHECK = 'false'
        ;(secureFetch as jest.Mock).mockResolvedValue(new Response('{}', { status: 200 }))
        const localFetch = buildOriginBoundSecureFetch('http://127.0.0.1:11434')
        await expect(localFetch('http://127.0.0.1:11434/api/chat')).resolves.toBeInstanceOf(globalThis.Response)

        const policy = (secureFetch as jest.Mock).mock.calls[0][4]
        expect(() => policy.validateUrl(new URL('http://127.0.0.1:11434/api/generate'))).not.toThrow()
        expect(() => policy.validateUrl(new URL('http://127.0.0.1:11435/api/generate'))).toThrow(/origin/i)
    })

    it.each([
        'https://user:password@api.deepseek.com/v1',
        'https://api.deepseek.com/v1?token=fixture',
        'https://api.deepseek.com/v1#fragment'
    ])('rejects an unsafe origin-bound base URL: %s', (baseURL) => {
        expect(() => buildOriginBoundSecureFetch(baseURL)).toThrow(/must not contain/)
    })

    it('supports an official-only provider policy with no environment allowlist', () => {
        const googlePolicy = {
            providerLabel: 'Google Gemini',
            defaultBaseUrl: 'https://generativelanguage.googleapis.com',
            officialOrigins: ['https://generativelanguage.googleapis.com']
        }

        expect(resolveProviderBaseUrl(undefined, googlePolicy)).toBe('https://generativelanguage.googleapis.com')
        expect(() => resolveProviderBaseUrl('https://proxy.example.com', googlePolicy)).toThrow(/origin is not allowed/)
    })
})
