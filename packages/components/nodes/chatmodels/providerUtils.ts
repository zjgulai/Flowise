import type { ClientOptions } from 'openai'
import { validateCustomHeaders } from '../../src/headerValidation'
import { secureFetch } from '../../src/httpSecurity'

export interface ProviderEndpointPolicy {
    providerLabel: string
    defaultBaseUrl: string
    officialOrigins: string[]
    allowlistEnvVar: string
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
    const additionalOrigins = process.env[policy.allowlistEnvVar]
    if (additionalOrigins) {
        for (const entry of additionalOrigins
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean)) {
            allowedOrigins.add(parseAllowlistOrigin(entry, policy.allowlistEnvVar))
        }
    }

    if (!allowedOrigins.has(url.origin)) {
        throw invalidBasePath(policy.providerLabel, `origin is not allowed; configure ${policy.allowlistEnvVar} explicitly`)
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

export function buildSecureProviderConfiguration(baseURL: string, headers?: Record<string, string>): ClientOptions {
    const providerOrigin = new URL(baseURL).origin
    const providerFetch: NonNullable<ClientOptions['fetch']> = async (url, init) => {
        return (await secureFetch(String(url), init as any, 5, undefined, {
            enforceDefaultDenyList: true,
            validateUrl(target) {
                if (target.protocol !== 'https:') throw new Error('Provider requests must use HTTPS')
                if (target.origin !== providerOrigin) throw new Error('Provider redirect origin is not allowed')
            }
        })) as any
    }

    return {
        baseURL,
        ...(headers ? { defaultHeaders: headers } : {}),
        fetch: providerFetch
    }
}
