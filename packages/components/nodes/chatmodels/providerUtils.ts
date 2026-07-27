import type { ClientOptions } from 'openai'
import { Readable } from 'node:stream'
import type { Response as NodeFetchResponse } from 'node-fetch'
import { validateCustomHeaders } from '../../src/headerValidation'
import { secureFetch } from '../../src/httpSecurity'

export interface ProviderEndpointPolicy {
    providerLabel: string
    defaultBaseUrl: string
    officialOrigins: string[]
    allowlistEnvVar?: string
}

export interface ProviderNumberOptions {
    integer?: boolean
    min?: number
    max?: number
}

function invalidBasePath(providerLabel: string, reason: string): Error {
    return new Error(`${providerLabel} Base Path ${reason}`)
}

function parseAllowlistOrigin(value: string, envName: string): string {
    try {
        const url = new URL(value)
        if (
            url.protocol !== 'https:' ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            (url.pathname !== '' && url.pathname !== '/')
        ) {
            throw new Error('invalid origin')
        }
        return url.origin
    } catch {
        throw new Error(`${envName} contains an invalid HTTPS origin`)
    }
}

export function resolveProviderBaseUrl(input: unknown, policy: ProviderEndpointPolicy): string {
    const configured = typeof input === 'string' && input.trim() ? input.trim() : policy.defaultBaseUrl
    let url: URL

    try {
        url = new URL(configured)
    } catch {
        throw invalidBasePath(policy.providerLabel, 'must be a valid HTTPS URL')
    }

    if (url.protocol !== 'https:') {
        throw invalidBasePath(policy.providerLabel, 'must use HTTPS')
    }
    if (url.username || url.password) {
        throw invalidBasePath(policy.providerLabel, 'must not contain credentials')
    }
    if (url.search || url.hash) {
        throw invalidBasePath(policy.providerLabel, 'must not contain a query or fragment')
    }

    const allowedOrigins = new Set(policy.officialOrigins.map((origin) => parseAllowlistOrigin(origin, 'official provider policy')))
    const additionalOrigins = policy.allowlistEnvVar ? process.env[policy.allowlistEnvVar] : undefined
    if (additionalOrigins && policy.allowlistEnvVar) {
        for (const entry of additionalOrigins
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean)) {
            allowedOrigins.add(parseAllowlistOrigin(entry, policy.allowlistEnvVar))
        }
    }

    if (!allowedOrigins.has(url.origin)) {
        const allowlistHint = policy.allowlistEnvVar ? `; configure ${policy.allowlistEnvVar} explicitly` : ''
        throw invalidBasePath(policy.providerLabel, `origin is not allowed${allowlistHint}`)
    }

    return url.toString().replace(/\/+$/, '')
}

export function parseProviderHeaders(input: unknown, providerLabel: string): Record<string, string> | undefined {
    if (input === undefined || input === null || input === '') return undefined

    let parsed: unknown
    try {
        parsed = typeof input === 'string' ? JSON.parse(input) : input
    } catch {
        throw new Error(`${providerLabel} Base Options must be valid JSON`)
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${providerLabel} Base Options must be a JSON object`)
    }

    const credentialHeaders = new Set([
        'authorization',
        'proxy-authorization',
        'x-api-key',
        'api-key',
        'apikey',
        'x-auth-token',
        'x-access-token',
        'x-amz-security-token',
        'x-goog-api-key',
        'cookie',
        'set-cookie'
    ])
    for (const name of Object.keys(parsed)) {
        if (credentialHeaders.has(name.toLowerCase())) {
            throw new Error(`${providerLabel} Base Options must not include a credential header`)
        }
    }

    try {
        validateCustomHeaders(parsed as Record<string, string>)
    } catch (error) {
        throw new Error(`${providerLabel} Base Options: ${error instanceof Error ? error.message : 'invalid headers'}`)
    }

    return parsed as Record<string, string>
}

export function parseOptionalProviderNumber(input: unknown, label: string, options: ProviderNumberOptions = {}): number | undefined {
    if (input === undefined || input === null || (typeof input === 'string' && input.trim() === '')) return undefined
    if (typeof input !== 'string' && typeof input !== 'number') throw new Error(`${label} must be a finite number`)

    const value = Number(input)
    if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
    if (options.integer && !Number.isInteger(value)) throw new Error(`${label} must be an integer`)
    if (options.min !== undefined && value < options.min) throw new Error(`${label} must be at least ${options.min}`)
    if (options.max !== undefined && value > options.max) throw new Error(`${label} must be at most ${options.max}`)
    return value
}

export function requireProviderApiKey(input: unknown, providerLabel: string): string {
    if (typeof input !== 'string' || !input.trim()) throw new Error(`${providerLabel} API key is required`)
    return input.trim()
}

type ProviderFetch = NonNullable<ClientOptions['fetch']>

function getRequestUrl(input: Parameters<ProviderFetch>[0]): string {
    if (typeof input === 'string' || input instanceof URL) return String(input)
    if (input && typeof input === 'object' && 'url' in input) return String(input.url)
    return String(input)
}

async function getRequestInit(input: Parameters<ProviderFetch>[0], init: Parameters<ProviderFetch>[1]): Promise<any> {
    if (!(input instanceof globalThis.Request)) return init

    const request = init ? new globalThis.Request(input, init as RequestInit) : input
    const requestInit: RequestInit = {
        ...(init ?? {}),
        method: request.method,
        headers: Array.from(request.headers.entries()),
        signal: request.signal
    }

    if (request.body) requestInit.body = Buffer.from(await request.arrayBuffer())
    else delete requestInit.body
    return requestInit
}

/** Convert node-fetch's Node Readable response into the WHATWG response expected by provider SDKs. */
export function toWebResponse(response: NodeFetchResponse): globalThis.Response {
    const statusForbidsBody = [101, 204, 205, 304].includes(response.status)
    let body: BodyInit | null = statusForbidsBody ? null : (response.body as unknown as BodyInit | null)

    if (body && typeof (body as unknown as { pipe?: unknown }).pipe === 'function') {
        body = Readable.toWeb(body as unknown as Readable) as unknown as BodyInit
    }

    const webResponse = new globalThis.Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: Array.from(response.headers.entries())
    })

    if (response.url) Object.defineProperty(webResponse, 'url', { configurable: true, value: response.url })
    return webResponse
}

/**
 * Build a provider fetch that pins DNS through secureFetch and refuses every
 * redirect or request that leaves the configured origin. Plain HTTP is only
 * available through the operator's explicit HTTP_SECURITY_CHECK=false opt-out.
 */
export function buildOriginBoundSecureFetch(baseURL: string, validateTarget?: (target: URL) => void): ProviderFetch {
    const endpoint = new URL(baseURL)
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('Provider Base Path must use HTTP or HTTPS')
    if (endpoint.username || endpoint.password) throw new Error('Provider Base Path must not contain credentials')
    if (endpoint.search || endpoint.hash) throw new Error('Provider Base Path must not contain a query or fragment')
    if (endpoint.protocol === 'http:' && process.env.HTTP_SECURITY_CHECK !== 'false') {
        throw new Error('Provider Base Path must use HTTPS unless HTTP_SECURITY_CHECK=false')
    }

    const providerOrigin = endpoint.origin
    const validateUrl = (target: URL): void => {
        if (!['http:', 'https:'].includes(target.protocol)) throw new Error('Provider requests must use HTTP or HTTPS')
        if (target.username || target.password) throw new Error('Provider requests must not contain URL credentials')
        if (target.protocol === 'http:' && process.env.HTTP_SECURITY_CHECK !== 'false') {
            throw new Error('Provider requests must use HTTPS unless HTTP_SECURITY_CHECK=false')
        }
        if (target.origin !== providerOrigin) throw new Error('Provider redirect origin is not allowed')
        validateTarget?.(target)
    }

    return async (url, init) => {
        const requestUrl = getRequestUrl(url)
        validateUrl(new URL(requestUrl))
        const requestInit = await getRequestInit(url, init)
        const response = await secureFetch(requestUrl, requestInit, 5, undefined, {
            // false preserves the environment-controlled local endpoint opt-out;
            // secureFetch still enables the default deny list unless that opt-out is explicit.
            enforceDefaultDenyList: false,
            validateUrl
        })
        return toWebResponse(response)
    }
}

export function buildSecureProviderConfiguration(baseURL: string, headers?: Record<string, string>): ClientOptions {
    const providerFetch = buildOriginBoundSecureFetch(baseURL)

    return {
        baseURL,
        ...(headers ? { defaultHeaders: headers } : {}),
        fetch: providerFetch
    }
}
