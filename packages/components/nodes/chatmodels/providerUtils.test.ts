import { Response } from 'node-fetch'
import { secureFetch } from '../../src/httpSecurity'
import {
    buildSecureProviderConfiguration,
    parseOptionalProviderNumber,
    parseProviderHeaders,
    requireProviderApiKey,
    resolveProviderBaseUrl
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
            expect.objectContaining({ enforceDefaultDenyList: true, validateUrl: expect.any(Function) })
        )

        const policy = (secureFetch as jest.Mock).mock.calls[0][4]
        expect(() => policy.validateUrl(new URL('https://api.deepseek.com/redirect'))).not.toThrow()
        expect(() => policy.validateUrl(new URL('https://other.example.com/redirect'))).toThrow(/origin/i)
        expect(() => policy.validateUrl(new URL('http://api.deepseek.com/redirect'))).toThrow(/HTTPS/i)
    })
})
