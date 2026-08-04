import axios, { AxiosHeaders, AxiosRequestConfig, AxiosResponse } from 'axios'
import dns from 'dns/promises'
import http from 'http'
import https from 'https'
import * as ipaddr from 'ipaddr.js'
import fetch, { Headers, RequestInit, Response } from 'node-fetch'
import { Readable, Transform, TransformCallback } from 'stream'

const DEFAULT_DENY_LIST = [
    '0.0.0.0',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '169.254.169.253',
    '169.254.169.254',
    '172.16.0.0/12',
    '192.168.0.0/16',
    '224.0.0.0/4',
    '240.0.0.0/4',
    '255.255.255.255/32',
    '::',
    '::1',
    'fc00::/7',
    'fd00:ec2::254',
    'fe80::/10',
    'ff00::/8',
    'localhost',
    'ip6-localhost'
]

/**
 * Gets the HTTP deny list.
 * When HTTP_SECURITY_CHECK=false, the default deny list is omitted and only
 * HTTP_DENY_LIST entries are used. Defaults to true (secure).
 * @returns Array of denied IP addresses, hostnames, or CIDR ranges
 */
function shouldEnforceDefaultDenyList(enforceDefaultDenyList: boolean = false): boolean {
    return enforceDefaultDenyList || process.env.HTTP_SECURITY_CHECK !== 'false'
}

function getHttpDenyList(enforceDefaultDenyList: boolean = false): string[] {
    const httpDenyListString = process.env.HTTP_DENY_LIST
    const customList = httpDenyListString
        ? httpDenyListString
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean)
        : []

    if (shouldEnforceDefaultDenyList(enforceDefaultDenyList)) {
        return [...new Set([...DEFAULT_DENY_LIST, ...customList])]
    }
    return customList
}

const GLOBALLY_REACHABLE_IPV4_EXCEPTIONS = new Set(['192.0.0.9', '192.0.0.10'])
const GLOBALLY_REACHABLE_IPV6_EXCEPTIONS = new Set(['2001:1::1', '2001:1::2', '2001:1::3'])

function isInCidr(address: ipaddr.IPv4 | ipaddr.IPv6, cidr: string): boolean {
    const [range, prefix] = ipaddr.parseCIDR(cidr)
    return address.kind() === range.kind() && address.match(range, prefix)
}

function getWellKnownNat64EmbeddedIPv4(address: ipaddr.IPv4 | ipaddr.IPv6): ipaddr.IPv4 | undefined {
    if (address.kind() !== 'ipv6' || !isInCidr(address, '64:ff9b::/96')) return undefined

    const embedded = ipaddr.fromByteArray((address as ipaddr.IPv6).toByteArray().slice(12))
    return embedded.kind() === 'ipv4' ? (embedded as ipaddr.IPv4) : undefined
}

function isGloballyReachableIP(ip: string): boolean {
    let address = ipaddr.parse(ip)

    if (address.kind() === 'ipv6' && (address as ipaddr.IPv6).isIPv4MappedAddress()) {
        address = (address as ipaddr.IPv6).toIPv4Address()
    }

    if (address.kind() === 'ipv4') {
        const canonical = address.toString()
        if (GLOBALLY_REACHABLE_IPV4_EXCEPTIONS.has(canonical)) return true
        return ['unicast', 'as112', 'amt'].includes(address.range())
    }

    const ipv6 = address as ipaddr.IPv6
    const canonical = ipv6.toString()
    if (GLOBALLY_REACHABLE_IPV6_EXCEPTIONS.has(canonical)) return true

    // 64:ff9b::/96 is globally reachable only when its embedded IPv4 address is.
    const embeddedIPv4 = getWellKnownNat64EmbeddedIPv4(ipv6)
    if (embeddedIPv4) return isGloballyReachableIP(embeddedIPv4.toString())

    // IANA special-purpose ranges that ipaddr.js currently classifies as generic unicast.
    if (
        isInCidr(ipv6, '64:ff9b:1::/48') ||
        isInCidr(ipv6, '100:0:0:1::/64') ||
        isInCidr(ipv6, '3ffe::/16') ||
        isInCidr(ipv6, '3fff::/20') ||
        isInCidr(ipv6, '5f00::/16')
    )
        return false

    const range = ipv6.range()
    if (range === 'unicast') return isInCidr(ipv6, '2000::/3')
    return ['amt', 'as112v6', 'orchid2', 'droneRemoteIdProtocolEntityTags'].includes(range)
}

function normalizeHostname(hostname: string): string {
    return hostname.trim().toLowerCase().replace(/\.+$/, '')
}

function validateHostname(hostname: string, denyList: string[]): void {
    const canonicalHostname = normalizeHostname(hostname)
    for (const entry of denyList) {
        if (entry.includes('/') || ipaddr.isValid(entry)) continue
        if (normalizeHostname(entry) === canonicalHostname) throw new Error('Access to this host is denied by policy.')
    }
}

function validateResolvedIP(ip: string, denyList: string[], enforceDefaultDenyList: boolean): void {
    if (enforceDefaultDenyList && !isGloballyReachableIP(ip)) {
        throw new Error('Access to this host is denied by policy.')
    }
    isDeniedIP(ip, denyList)

    const embeddedIPv4 = getWellKnownNat64EmbeddedIPv4(ipaddr.parse(ip))
    if (embeddedIPv4) isDeniedIP(embeddedIPv4.toString(), denyList)
}

/**
 * Checks if an IP address is in the deny list
 * @param ip - IP address to check
 * @param denyList - Array of denied IP addresses/CIDR ranges
 * @throws Error if IP is in deny list
 */
export function isDeniedIP(ip: string, denyList: string[]): void {
    let parsedIp = ipaddr.parse(ip)

    // Normalize IPv4-mapped IPv6 addresses to IPv4 before checking
    // This prevents bypass of IPv4 deny list rules via ::ffff:x.x.x.x addresses
    if (parsedIp.kind() === 'ipv6') {
        const ipv6Addr = parsedIp as ipaddr.IPv6
        if (ipv6Addr.isIPv4MappedAddress()) {
            parsedIp = ipv6Addr.toIPv4Address()
        }
    }

    for (const entry of denyList) {
        if (entry.includes('/')) {
            try {
                const [rangeAddr, mask] = ipaddr.parseCIDR(entry)
                let parsedRange = rangeAddr
                let adjustedMask = mask

                // Also normalize deny list entries
                if (parsedRange.kind() === 'ipv6' && (parsedRange as ipaddr.IPv6).isIPv4MappedAddress()) {
                    if (mask < 96) continue // malformed IPv4-mapped CIDR — skip
                    parsedRange = (parsedRange as ipaddr.IPv6).toIPv4Address()
                    adjustedMask -= 96
                }

                if (parsedIp.kind() === parsedRange.kind()) {
                    if (parsedIp.match(parsedRange, adjustedMask)) {
                        throw new Error('Access to this host is denied by policy.')
                    }
                }
            } catch (error) {
                throw new Error(`isDeniedIP: ${error}`)
            }
        } else {
            // Try to parse and normalize the deny list entry for consistent comparison
            // This handles non-canonical IPv6 addresses (e.g., FE80::1, 2001:0DB8::1)
            if (ipaddr.isValid(entry)) {
                let parsedEntry = ipaddr.parse(entry)

                // Normalize IPv4-mapped IPv6 entries
                if (parsedEntry.kind() === 'ipv6' && (parsedEntry as ipaddr.IPv6).isIPv4MappedAddress()) {
                    parsedEntry = (parsedEntry as ipaddr.IPv6).toIPv4Address()
                }

                // Compare normalized forms
                if (parsedIp.toString() === parsedEntry.toString()) {
                    throw new Error('Access to this host is denied by policy.')
                }
            } else {
                // Not a valid IP - compare as-is (e.g., hostname like "localhost")
                if (parsedIp.toString() === entry) {
                    throw new Error('Access to this host is denied by policy.')
                }
            }
        }
    }
}

/**
 * Checks if a URL is allowed based on HTTP_DENY_LIST environment variable.
 * @param url - URL to check
 * @throws Error if URL hostname resolves to a denied IP
 */
export async function checkDenyList(url: string): Promise<void> {
    const enforceDefaultDenyList = shouldEnforceDefaultDenyList()
    const httpDenyList = getHttpDenyList()

    const urlObj = parseHttpRequestUrl(url)
    let hostname = urlObj.hostname
    // Strip IPv6 brackets if present
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
        hostname = hostname.slice(1, -1)
    }
    validateHostname(hostname, httpDenyList)

    if (ipaddr.isValid(hostname)) {
        validateResolvedIP(hostname, httpDenyList, enforceDefaultDenyList)
    } else {
        const addresses = await dns.lookup(hostname, { all: true })
        for (const address of addresses) {
            validateResolvedIP(address.address, httpDenyList, enforceDefaultDenyList)
        }
    }
}

/**
 * Optional TLS options for secureAxiosRequest (e.g. custom CA for mutual TLS or private CAs).
 */
export interface SecureRequestAgentOptions {
    ca?: string | string[] | Buffer
}

export interface SecureRequestResourceLimits {
    timeoutMs: number
    maxRequestBytes: number
    maxResponseBytes: number
}

const TRUSTED_RESOURCE_LIMITS_BRAND = Symbol('flowise.trustedHttpResourceLimits')

/**
 * An explicit capability for trusted in-process callers that need limits above
 * the defaults. Runtime branding prevents user-controlled Axios/fetch config
 * (including NodeVM input) from forging a relaxation.
 */
export interface TrustedSecureRequestResourceLimits extends SecureRequestResourceLimits {
    readonly [TRUSTED_RESOURCE_LIMITS_BRAND]: true
}

export interface SecureRequestPolicy {
    enforceDefaultDenyList?: boolean
    validateUrl?: (url: URL) => void
    trustedResourceLimits?: TrustedSecureRequestResourceLimits
}

export type SecureFetchPolicy = SecureRequestPolicy

export interface SecureFetchRequestInit extends RequestInit {
    /** Optional request-body cap. It can only tighten the enforced policy cap. */
    maxBodyLength?: number
}

export interface FlowiseRequestTarget {
    baseUrl: string
    canonicalOrigin: string
    isCanonicalOrigin: boolean
}

const REQUEST_TARGET_DENIED_ERROR = 'Request target is denied by policy.'
const FLOWISE_BASE_URL_ERROR = 'Flowise base URL is not configured securely.'
const HTTP_REQUEST_FAILED_ERROR = 'Secure HTTP request failed.'
const HTTP_RESOURCE_LIMIT_ERROR = 'HTTP request exceeded a configured resource limit.'
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

const DEFAULT_SECURE_REQUEST_LIMITS: SecureRequestResourceLimits = Object.freeze({
    timeoutMs: 10 * 60 * 1000,
    maxRequestBytes: 32 * 1024 * 1024,
    maxResponseBytes: 32 * 1024 * 1024
})
const MAX_TRUSTED_SECURE_REQUEST_LIMITS: SecureRequestResourceLimits = Object.freeze({
    timeoutMs: 30 * 60 * 1000,
    maxRequestBytes: 128 * 1024 * 1024,
    maxResponseBytes: 128 * 1024 * 1024
})

const SAFE_CROSS_ORIGIN_REDIRECT_HEADERS = ['accept', 'accept-language', 'user-agent', 'range']

const ENTITY_REDIRECT_HEADERS = [
    'content-encoding',
    'content-language',
    'content-length',
    'content-location',
    'content-type',
    'digest',
    'transfer-encoding'
]

const AXIOS_CONTEXT_HEADER_KEYS = new Set(['common', 'delete', 'get', 'head', 'post', 'put', 'patch', 'options', 'purge', 'link', 'unlink'])

type CompatibleAbortSignal = {
    aborted: boolean
    addEventListener: (type: 'abort', listener: () => void, options?: { once?: boolean } | boolean) => void
    removeEventListener: (type: 'abort', listener: () => void) => void
}

function validateTrustedResourceLimit(value: unknown, maximum: number): number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
        throw new Error(HTTP_RESOURCE_LIMIT_ERROR)
    }
    return value as number
}

/**
 * Creates a hard-capped relaxation capability for trusted, in-process code.
 * Ordinary request configuration can only tighten limits; NodeVM wrappers do
 * not expose this factory or the policy argument.
 */
export function createTrustedSecureRequestResourceLimits(limits: SecureRequestResourceLimits): TrustedSecureRequestResourceLimits {
    return Object.freeze({
        timeoutMs: validateTrustedResourceLimit(limits.timeoutMs, MAX_TRUSTED_SECURE_REQUEST_LIMITS.timeoutMs),
        maxRequestBytes: validateTrustedResourceLimit(limits.maxRequestBytes, MAX_TRUSTED_SECURE_REQUEST_LIMITS.maxRequestBytes),
        maxResponseBytes: validateTrustedResourceLimit(limits.maxResponseBytes, MAX_TRUSTED_SECURE_REQUEST_LIMITS.maxResponseBytes),
        [TRUSTED_RESOURCE_LIMITS_BRAND]: true as const
    })
}

function getSecureRequestResourceLimits(policy?: SecureRequestPolicy): SecureRequestResourceLimits {
    const trustedLimits = policy?.trustedResourceLimits
    if (!trustedLimits) return DEFAULT_SECURE_REQUEST_LIMITS
    if (trustedLimits[TRUSTED_RESOURCE_LIMITS_BRAND] !== true) throw new Error(HTTP_RESOURCE_LIMIT_ERROR)
    return trustedLimits
}

function clampDisableableLimit(value: unknown, enforcedLimit: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.min(value, enforcedLimit) : enforcedLimit
}

function clampAxiosByteLimit(value: unknown, enforcedLimit: number): number {
    if (value === 0) return 0
    return clampDisableableLimit(value, enforcedLimit)
}

class SecureRequestLifecycle {
    private readonly controller = new AbortController()
    private readonly timer: NodeJS.Timeout
    private readonly callerSignal?: CompatibleAbortSignal
    private readonly onCallerAbort = () => this.abort(new Error(HTTP_REQUEST_FAILED_ERROR))
    private terminalError?: Error
    private cleaned = false

    constructor(timeoutMs: number, callerSignal?: CompatibleAbortSignal | null) {
        this.callerSignal = callerSignal ?? undefined
        try {
            if (this.callerSignal?.aborted) this.abort(new Error(HTTP_REQUEST_FAILED_ERROR))
            else this.callerSignal?.addEventListener('abort', this.onCallerAbort, { once: true })
        } catch {
            this.abort(new Error(HTTP_REQUEST_FAILED_ERROR))
        }

        this.timer = setTimeout(() => this.abort(new Error(HTTP_RESOURCE_LIMIT_ERROR)), timeoutMs)
        this.timer.unref?.()
    }

    get signal(): AbortSignal {
        return this.controller.signal
    }

    get error(): Error {
        return this.terminalError ?? new Error(HTTP_REQUEST_FAILED_ERROR)
    }

    abort(error: Error): void {
        if (!this.terminalError) this.terminalError = error
        if (!this.controller.signal.aborted) this.controller.abort()
    }

    async waitFor<T>(operation: Promise<T>, sanitizeFailure: boolean = false): Promise<T> {
        if (this.controller.signal.aborted) {
            // The operation may already be a synchronously rejected Promise
            // (for example, an Axios transform that tripped a byte budget).
            // Attach a sink before returning the fixed terminal error.
            operation.catch(() => undefined)
            throw this.error
        }

        return await new Promise<T>((resolve, reject) => {
            const onAbort = () => reject(this.error)
            this.controller.signal.addEventListener('abort', onAbort, { once: true })
            operation.then(
                (value) => {
                    this.controller.signal.removeEventListener('abort', onAbort)
                    resolve(value)
                },
                (error) => {
                    this.controller.signal.removeEventListener('abort', onAbort)
                    reject(sanitizeFailure ? this.error : error)
                }
            )
        })
    }

    cleanup(): void {
        if (this.cleaned) return
        this.cleaned = true
        clearTimeout(this.timer)
        try {
            this.callerSignal?.removeEventListener('abort', this.onCallerAbort)
        } catch {
            // Cleanup must never expose caller-controlled AbortSignal errors.
        }
    }
}

class ByteBudget {
    private used = 0

    constructor(private readonly maximum: number) {}

    get limit(): number {
        return this.maximum
    }

    get remaining(): number {
        return this.maximum - this.used
    }

    ensure(bytes: number): void {
        if (!Number.isSafeInteger(bytes) || bytes < 0 || this.used + bytes > this.maximum) {
            throw new Error(HTTP_RESOURCE_LIMIT_ERROR)
        }
    }

    consume(bytes: number): void {
        this.ensure(bytes)
        this.used += bytes
    }
}

/**
 * Counts bytes for every raw/stream consumer. Piping starts lazily so a caller
 * that never consumes a response cannot buffer data before the total deadline
 * destroys the upstream socket.
 */
class BoundedByteStream extends Transform {
    private started = false
    private detached = false
    private pendingError?: Error
    private readonly onSourceError = () => this.fail(this.lifecycle.error)
    private readonly onAbort = () => this.fail(this.lifecycle.error)

    constructor(
        private readonly source: Readable,
        private readonly budget: ByteBudget,
        private readonly lifecycle: SecureRequestLifecycle,
        private readonly onComplete: () => void = () => undefined
    ) {
        super()
        source.once('error', this.onSourceError)
        lifecycle.signal.addEventListener('abort', this.onAbort, { once: true })
        // Raw consumers are still expected to handle stream errors. This guard
        // prevents a delayed timeout on an otherwise-unconsumed response from
        // becoming an uncaught process-level error.
        this.on('error', () => undefined)
        this.once('end', () => this.detach())
        this.once('close', () => this.detach())
    }

    override _read(size: number): void {
        if (this.pendingError) {
            const error = this.pendingError
            this.pendingError = undefined
            queueMicrotask(() => this.destroy(error))
            return
        }
        if (!this.started) {
            this.started = true
            this.source.pipe(this)
        }
        super._read(size)
    }

    override _transform(chunk: unknown, encoding: BufferEncoding, callback: TransformCallback): void {
        try {
            const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk), encoding)
            this.budget.consume(bytes)
            callback(null, chunk)
        } catch {
            this.lifecycle.signal.removeEventListener('abort', this.onAbort)
            this.lifecycle.abort(new Error(HTTP_RESOURCE_LIMIT_ERROR))
            this.source.destroy()
            callback(new Error(HTTP_RESOURCE_LIMIT_ERROR))
        }
    }

    override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
        this.detach()
        if (!this.source.destroyed) this.source.destroy()
        callback(error)
    }

    private fail(error: Error): void {
        if (this.detached) return
        if (!this.started) {
            this.pendingError = error
            if (!this.source.destroyed) this.source.destroy()
            this.detach()
            return
        }
        this.destroy(error)
    }

    private detach(): void {
        if (this.detached) return
        this.detached = true
        this.source.unpipe(this)
        this.source.removeListener('error', this.onSourceError)
        this.lifecycle.signal.removeEventListener('abort', this.onAbort)
        this.onComplete()
    }
}

function isReadableStream(value: unknown): value is Readable {
    return (
        value instanceof Readable ||
        (!!value &&
            typeof (value as { pipe?: unknown }).pipe === 'function' &&
            typeof (value as { on?: unknown }).on === 'function' &&
            typeof (value as { destroy?: unknown }).destroy === 'function')
    )
}

function getKnownBodyByteLength(value: unknown): number | undefined {
    if (value === undefined || value === null) return 0
    if (typeof value === 'string') return Buffer.byteLength(value)
    if (Buffer.isBuffer(value)) return value.length
    if (value instanceof URLSearchParams) return Buffer.byteLength(value.toString())
    if (value instanceof ArrayBuffer) return value.byteLength
    if (ArrayBuffer.isView(value)) return value.byteLength
    if (typeof value === 'object' && typeof (value as { size?: unknown }).size === 'number') {
        const size = (value as { size: number }).size
        return Number.isSafeInteger(size) && size >= 0 ? size : undefined
    }
    return undefined
}

function getAxiosBodyByteLength(value: unknown): number | undefined {
    const knownLength = getKnownBodyByteLength(value)
    if (knownLength !== undefined) return knownLength
    if (!value || isReadableStream(value)) return undefined
    try {
        return Buffer.byteLength(JSON.stringify(value))
    } catch {
        return undefined
    }
}

type AxiosHopBodyState = {
    observed: boolean
    hasBody: boolean
    replaySafe: boolean
}

type AxiosHopResponseState = {
    accounted: boolean
    streamBounded: boolean
}

type AxiosTransformer = (this: AxiosRequestConfig, data: unknown, headers?: unknown, status?: number) => unknown

function getAxiosTransforms(value: unknown, defaults: unknown): AxiosTransformer[] {
    const selected = value === undefined ? defaults : value
    if (selected === undefined || selected === null) return []
    const transforms = Array.isArray(selected) ? selected : [selected]
    if (!transforms.every((transform) => typeof transform === 'function')) throw new Error(HTTP_REQUEST_FAILED_ERROR)
    return transforms as AxiosTransformer[]
}

function isAxiosTransportBodyReplaySafe(value: unknown): boolean {
    return (
        typeof value === 'string' ||
        Buffer.isBuffer(value) ||
        value instanceof URLSearchParams ||
        value instanceof ArrayBuffer ||
        ArrayBuffer.isView(value)
    )
}

function getContentLength(headers: unknown): number | undefined {
    let rawValue: unknown
    if (headers instanceof AxiosHeaders || headers instanceof Headers) rawValue = headers.get('content-length')
    else if (headers && typeof headers === 'object') {
        const entry = Object.entries(headers as Record<string, unknown>).find(([name]) => name.toLowerCase() === 'content-length')
        rawValue = entry?.[1]
    }

    const normalized = Array.isArray(rawValue) ? rawValue[0] : rawValue
    if (typeof normalized !== 'string' && typeof normalized !== 'number') return undefined
    const value = typeof normalized === 'number' ? normalized : Number(normalized.trim())
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function wrapResponseStream(source: Readable, budget: ByteBudget, lifecycle: SecureRequestLifecycle): BoundedByteStream {
    return new BoundedByteStream(source, budget, lifecycle, () => lifecycle.cleanup())
}

function throwResourceLimit(lifecycle: SecureRequestLifecycle): never {
    const error = new Error(HTTP_RESOURCE_LIMIT_ERROR)
    lifecycle.abort(error)
    throw error
}

function throwRequestFailure(lifecycle: SecureRequestLifecycle): never {
    const error = new Error(HTTP_REQUEST_FAILED_ERROR)
    lifecycle.abort(error)
    throw error
}

function consumeBudget(budget: ByteBudget, bytes: number, lifecycle: SecureRequestLifecycle): void {
    try {
        budget.consume(bytes)
    } catch {
        throwResourceLimit(lifecycle)
    }
}

function createBoundedAxiosRequestTransforms(
    configuredTransforms: AxiosRequestConfig['transformRequest'],
    budget: ByteBudget,
    lifecycle: SecureRequestLifecycle,
    usedRequestStreams: WeakSet<object>,
    state: AxiosHopBodyState
): AxiosTransformer[] {
    const defaults = (axios as unknown as { defaults?: { transformRequest?: unknown } }).defaults?.transformRequest
    const transforms = getAxiosTransforms(configuredTransforms, defaults)

    return [
        ...transforms,
        function accountTransportRequestBody(data: unknown, headers?: unknown): unknown {
            state.observed = true
            state.hasBody = data !== undefined && data !== null
            state.replaySafe = !state.hasBody
            if (!state.hasBody) return data

            if (isReadableStream(data)) {
                if (usedRequestStreams.has(data)) throwResourceLimit(lifecycle)
                usedRequestStreams.add(data)
                try {
                    const formHeaders = (data as unknown as { getHeaders?: () => Record<string, string> }).getHeaders?.()
                    if (formHeaders) {
                        if (headers instanceof AxiosHeaders) headers.set(formHeaders)
                        else if (headers && typeof headers === 'object') Object.assign(headers, formHeaders)
                        else throw new Error(HTTP_REQUEST_FAILED_ERROR)
                    }
                } catch {
                    throwRequestFailure(lifecycle)
                }
                return new BoundedByteStream(data, budget, lifecycle)
            }

            const requestBytes = getKnownBodyByteLength(data)
            if (requestBytes === undefined) throwResourceLimit(lifecycle)
            consumeBudget(budget, requestBytes, lifecycle)
            state.replaySafe = isAxiosTransportBodyReplaySafe(data)
            return data
        }
    ]
}

function createBoundedAxiosResponseTransforms(
    configuredTransforms: AxiosRequestConfig['transformResponse'],
    originalResponseType: AxiosRequestConfig['responseType'],
    originalResponseEncoding: AxiosRequestConfig['responseEncoding'],
    budget: ByteBudget,
    lifecycle: SecureRequestLifecycle,
    state: AxiosHopResponseState
): AxiosTransformer[] {
    const defaults = (axios as unknown as { defaults?: { transformResponse?: unknown } }).defaults?.transformResponse
    const transforms = getAxiosTransforms(configuredTransforms, defaults)
    const guardedTransforms = transforms.map(
        (transform): AxiosTransformer =>
            function guardStreamTransform(data: unknown, headers?: unknown, status?: number): unknown {
                const transformed = transform.call(this, data, headers, status)
                if (isReadableStream(data) && transformed !== data) {
                    discardResponseStream(data)
                    throwResourceLimit(lifecycle)
                }
                return transformed
            }
    )

    return [
        function accountTransportResponseBody(data: unknown, headers?: unknown): unknown {
            const declaredLength = getContentLength(headers)
            if (declaredLength !== undefined) {
                try {
                    budget.ensure(declaredLength)
                } catch {
                    discardResponseStream(data)
                    throwResourceLimit(lifecycle)
                }
            }

            state.accounted = true
            this.responseType = originalResponseType
            this.responseEncoding = originalResponseEncoding
            if (isReadableStream(data)) {
                state.streamBounded = true
                // Redirect classification happens after Axios transforms. Keep
                // the lifecycle alive until secureAxiosRequest knows whether
                // this stream is a final response or an intermediate hop.
                return new BoundedByteStream(data, budget, lifecycle)
            }

            const responseBytes = getAxiosBodyByteLength(data)
            if (responseBytes === undefined) throwResourceLimit(lifecycle)
            consumeBudget(budget, responseBytes, lifecycle)
            if (originalResponseType === 'arraybuffer' || !Buffer.isBuffer(data)) return data

            try {
                const encoding = originalResponseEncoding || 'utf8'
                const decoded = data.toString(encoding as BufferEncoding)
                return !originalResponseEncoding || originalResponseEncoding === 'utf8'
                    ? decoded.charCodeAt(0) === 0xfeff
                        ? decoded.slice(1)
                        : decoded
                    : decoded
            } catch {
                throwRequestFailure(lifecycle)
            }
        },
        ...guardedTransforms
    ]
}

function isAxiosResourceLimitFailure(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false
    const candidate = error as { code?: unknown; message?: unknown }
    if (candidate.code === 'ERR_FR_MAX_BODY_LENGTH_EXCEEDED') return true
    if (candidate.code !== 'ERR_BAD_RESPONSE' && candidate.code !== 'ERR_BAD_REQUEST') return false
    return typeof candidate.message === 'string' && /max(?:Content|Body)Length/i.test(candidate.message)
}

function prepareFetchRequestInit(
    init: SecureFetchRequestInit,
    budget: ByteBudget,
    lifecycle: SecureRequestLifecycle,
    usedRequestStreams: WeakSet<object>
): RequestInit {
    const { maxBodyLength: _maxBodyLength, ...requestInit } = init
    const body = requestInit.body
    if (body === undefined || body === null) return requestInit

    if (isReadableStream(body)) {
        if (usedRequestStreams.has(body)) throwResourceLimit(lifecycle)
        usedRequestStreams.add(body)

        let headers = requestInit.headers
        try {
            const formHeaders = (body as unknown as { getHeaders?: () => Record<string, string> }).getHeaders?.()
            if (formHeaders) {
                const normalizedHeaders = new Headers(headers)
                for (const [name, value] of Object.entries(formHeaders)) {
                    if (!normalizedHeaders.has(name)) normalizedHeaders.set(name, value)
                }
                headers = normalizedHeaders
            }
        } catch {
            throwRequestFailure(lifecycle)
        }

        return {
            ...requestInit,
            headers,
            body: new BoundedByteStream(body, budget, lifecycle) as unknown as RequestInit['body']
        }
    }

    const knownLength = getKnownBodyByteLength(body)
    if (knownLength === undefined) throwResourceLimit(lifecycle)
    consumeBudget(budget, knownLength, lifecycle)
    return requestInit
}

const RESPONSE_BODY_METHODS = ['arrayBuffer', 'blob', 'buffer', 'json', 'text', 'textConverted'] as const

function sanitizeResponseBodyErrors(response: Response, lifecycle: SecureRequestLifecycle, allowClone: boolean): Response {
    for (const methodName of RESPONSE_BODY_METHODS) {
        const method = response[methodName]
        if (typeof method !== 'function') continue
        const originalMethod = method.bind(response) as () => Promise<unknown>
        Object.defineProperty(response, methodName, {
            configurable: true,
            value: async () => {
                try {
                    return await originalMethod()
                } catch {
                    throw lifecycle.error
                }
            }
        })
    }

    if (typeof response.clone === 'function') {
        const originalClone = response.clone.bind(response)
        Object.defineProperty(response, 'clone', {
            configurable: true,
            value: () => {
                // node-fetch v2 implements stream cloning with PassThrough tees.
                // Those branches sit after the transport byte counter, can
                // amplify buffering, and do not receive upstream abort errors.
                // Buffered bodies are safe to clone; streaming callers must
                // consume the single bounded branch.
                if (!allowClone) throw new Error(HTTP_RESOURCE_LIMIT_ERROR)
                return sanitizeResponseBodyErrors(originalClone(), lifecycle, true)
            }
        })
    }
    return response
}

function boundFetchResponse(response: Response, currentUrl: string, budget: ByteBudget, lifecycle: SecureRequestLifecycle): Response {
    const declaredLength = getContentLength(response.headers)
    if (declaredLength !== undefined) {
        try {
            budget.ensure(declaredLength)
        } catch {
            discardResponseStream(response.body)
            throwResourceLimit(lifecycle)
        }
    }

    if (!isReadableStream(response.body)) {
        const responseBytes = getAxiosBodyByteLength(response.body)
        if (responseBytes !== undefined) consumeBudget(budget, responseBytes, lifecycle)
        lifecycle.cleanup()
        return sanitizeResponseBodyErrors(response, lifecycle, true)
    }

    const body = wrapResponseStream(response.body, budget, lifecycle)
    return sanitizeResponseBodyErrors(
        new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
            size: budget.limit,
            url: response.url || currentUrl
        }),
        lifecycle,
        false
    )
}

function boundAxiosResponse(
    response: AxiosResponse,
    budget: ByteBudget,
    lifecycle: SecureRequestLifecycle,
    state: AxiosHopResponseState
): AxiosResponse {
    if (!state.accounted) {
        const declaredLength = getContentLength(response.headers)
        if (declaredLength !== undefined) {
            try {
                budget.ensure(declaredLength)
            } catch {
                discardResponseStream(response.data)
                throwResourceLimit(lifecycle)
            }
        }
    }
    if (isReadableStream(response.data)) {
        if (!state.streamBounded) response.data = wrapResponseStream(response.data, budget, lifecycle)
        else {
            if (response.data.destroyed || response.data.readableEnded) lifecycle.cleanup()
            else {
                response.data.once('end', () => lifecycle.cleanup())
                response.data.once('close', () => lifecycle.cleanup())
            }
        }
    } else if (!state.accounted) {
        const responseBytes = getAxiosBodyByteLength(response.data)
        if (responseBytes === undefined) throwResourceLimit(lifecycle)
        consumeBudget(budget, responseBytes, lifecycle)
        lifecycle.cleanup()
    } else lifecycle.cleanup()
    return response
}

async function accountDiscardedAxiosResponse(
    response: AxiosResponse,
    budget: ByteBudget,
    lifecycle: SecureRequestLifecycle,
    state: AxiosHopResponseState
): Promise<void> {
    if (!state.accounted) {
        const declaredLength = getContentLength(response.headers)
        if (declaredLength !== undefined) {
            try {
                budget.ensure(declaredLength)
            } catch {
                discardResponseStream(response.data)
                throwResourceLimit(lifecycle)
            }
        }
    }
    if (isReadableStream(response.data)) {
        try {
            for await (const chunk of response.data) {
                if (!state.streamBounded) {
                    const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk))
                    consumeBudget(budget, bytes, lifecycle)
                }
            }
        } catch {
            discardResponseStream(response.data)
            if (lifecycle.signal.aborted) throw lifecycle.error
            throwRequestFailure(lifecycle)
        }
        discardResponseStream(response.data)
        return
    }
    if (!state.accounted) {
        const responseBytes = getAxiosBodyByteLength(response.data)
        if (responseBytes === undefined) throwResourceLimit(lifecycle)
        consumeBudget(budget, responseBytes, lifecycle)
    }
    discardResponseStream(response.data)
}

function accountDiscardedFetchResponse(response: Response, budget: ByteBudget, lifecycle: SecureRequestLifecycle): void {
    const declaredLength = getContentLength(response.headers)
    if (declaredLength !== undefined) {
        try {
            budget.ensure(declaredLength)
        } catch {
            discardResponseStream(response.body)
            throwResourceLimit(lifecycle)
        }
    }
    if (isReadableStream(response.body)) {
        discardResponseStream(response.body)
        return
    }
    const responseBytes = getAxiosBodyByteLength(response.body)
    if (responseBytes === undefined) throwResourceLimit(lifecycle)
    consumeBudget(budget, responseBytes, lifecycle)
    discardResponseStream(response.body)
}

function discardResponseStream(value: unknown): void {
    if (!value || typeof (value as { destroy?: unknown }).destroy !== 'function') return
    const stream = value as { destroy: () => void }
    try {
        stream.destroy()
    } catch {
        // Redirect cleanup is best effort and must not expose stream errors.
    }
}

function removeRequestHeaders(init: RequestInit, names: string[]): RequestInit {
    if (!init.headers) return init

    const headers = new Headers(init.headers)
    for (const name of names) headers.delete(name)
    return { ...init, headers }
}

function retainRequestHeaders(init: RequestInit, names: string[]): RequestInit {
    if (!init.headers) return init

    const sourceHeaders = new Headers(init.headers)
    const headers = new Headers()
    for (const name of names) {
        const value = sourceHeaders.get(name)
        if (value !== null) headers.set(name, value)
    }
    return { ...init, headers }
}

function normalizeAxiosRequestHeaders(headersValue: AxiosRequestConfig['headers'], method?: string): AxiosHeaders {
    if (!headersValue || headersValue instanceof AxiosHeaders || typeof headersValue === 'string') {
        return AxiosHeaders.from(headersValue as AxiosHeaders | string | undefined)
    }

    const source = headersValue as Record<string, unknown>
    const headers = new AxiosHeaders()
    const mergeHeaders = (value: unknown) => {
        if (!value) return
        headers.set(AxiosHeaders.from(value as AxiosHeaders), true)
    }

    mergeHeaders(source.common)
    mergeHeaders(source[(method ?? 'get').toLowerCase()])

    const directHeaders: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(source)) {
        if (!AXIOS_CONTEXT_HEADER_KEYS.has(name.toLowerCase()) && value !== undefined) directHeaders[name] = value
    }
    mergeHeaders(directHeaders)
    return headers
}

function removeAxiosRequestHeaders(config: AxiosRequestConfig, names: string[]): AxiosRequestConfig {
    const headers = AxiosHeaders.from(config.headers as AxiosHeaders | undefined)
    headers.delete(names)
    return { ...config, headers }
}

function retainAxiosRequestHeaders(config: AxiosRequestConfig, names: string[]): AxiosRequestConfig {
    const sourceHeaders = AxiosHeaders.from(config.headers as AxiosHeaders | undefined)
    const headers = new AxiosHeaders()
    for (const name of names) {
        const value = sourceHeaders.get(name)
        if (value !== undefined) headers.set(name, value)
    }
    return { ...config, headers }
}

function setAxiosHostHeader(config: AxiosRequestConfig, host: string): AxiosRequestConfig {
    const headers = AxiosHeaders.from(config.headers as AxiosHeaders | undefined)
    headers.set('Host', host)
    return { ...config, headers }
}

function parseHttpRequestUrl(value: string, base?: string): URL {
    try {
        const url = base ? new URL(value, base) : new URL(value)
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
            throw new Error(REQUEST_TARGET_DENIED_ERROR)
        }
        return url
    } catch {
        throw new Error(REQUEST_TARGET_DENIED_ERROR)
    }
}

export function normalizeFlowiseBaseUrl(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(FLOWISE_BASE_URL_ERROR)

    try {
        const url = parseHttpRequestUrl(value.trim())
        if ((url.pathname && url.pathname !== '/') || url.search || url.hash) throw new Error(FLOWISE_BASE_URL_ERROR)
        return url.origin
    } catch {
        throw new Error(FLOWISE_BASE_URL_ERROR)
    }
}

/**
 * Resolves a persisted Flowise target without trusting request-derived runtime URLs.
 * APP_URL is always required so credentials can be bound to one canonical origin.
 */
export function resolveFlowiseRequestTarget(configuredBaseUrl?: unknown): FlowiseRequestTarget {
    const canonicalOrigin = normalizeFlowiseBaseUrl(process.env.APP_URL)
    const baseUrl =
        typeof configuredBaseUrl === 'string' && configuredBaseUrl.trim() ? normalizeFlowiseBaseUrl(configuredBaseUrl) : canonicalOrigin

    return {
        baseUrl,
        canonicalOrigin,
        isCanonicalOrigin: baseUrl === canonicalOrigin
    }
}

/**
 * Keeps every request and redirect on one preselected HTTP(S) origin.
 */
export function createFixedOriginPolicy(
    expectedBaseUrl: string,
    trustedResourceLimits?: TrustedSecureRequestResourceLimits
): SecureRequestPolicy {
    const expectedOrigin = normalizeFlowiseBaseUrl(expectedBaseUrl)
    return {
        enforceDefaultDenyList: true,
        ...(trustedResourceLimits ? { trustedResourceLimits } : {}),
        validateUrl(url: URL) {
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== expectedOrigin) {
                throw new Error(REQUEST_TARGET_DENIED_ERROR)
            }
        }
    }
}

/**
 * Makes a secure HTTP request that validates all URLs in redirect chains against the deny list
 * @param config - Axios request configuration (httpsAgent/httpAgent are ignored; use agentOptions for custom CA)
 * @param maxRedirects - Maximum number of redirects to follow (default: 5)
 * @param agentOptions - Optional TLS options (e.g. { ca } for custom CA PEM)
 * @returns Promise<AxiosResponse>
 * @throws Error if any URL in the redirect chain is denied
 */
export async function secureAxiosRequest(
    config: AxiosRequestConfig,
    maxRedirects: number = 5,
    agentOptions?: SecureRequestAgentOptions,
    policy?: SecureRequestPolicy
): Promise<AxiosResponse> {
    let currentUrl: string | undefined
    try {
        currentUrl = config.url
    } catch {
        throw new Error(HTTP_REQUEST_FAILED_ERROR)
    }
    if (!currentUrl) {
        throw new Error('secureAxiosRequest: url is required')
    }

    const policyLimits = getSecureRequestResourceLimits(policy)
    let timeoutMs: number
    let maxRequestBytes: number
    let maxResponseBytes: number
    let callerSignal: CompatibleAbortSignal | undefined
    try {
        timeoutMs = clampDisableableLimit(config.timeout, policyLimits.timeoutMs)
        maxRequestBytes = clampAxiosByteLimit(config.maxBodyLength, policyLimits.maxRequestBytes)
        maxResponseBytes = clampAxiosByteLimit(config.maxContentLength, policyLimits.maxResponseBytes)
        callerSignal = config.signal as CompatibleAbortSignal | undefined
    } catch {
        throw new Error(HTTP_REQUEST_FAILED_ERROR)
    }
    const lifecycle = new SecureRequestLifecycle(timeoutMs, callerSignal)

    try {
        const requestBudget = new ByteBudget(maxRequestBytes)
        const responseBudget = new ByteBudget(maxResponseBytes)
        const usedRequestStreams = new WeakSet<object>()
        let redirects = 0
        let currentConfig: AxiosRequestConfig
        try {
            currentConfig = {
                ...config,
                headers: normalizeAxiosRequestHeaders(config.headers, config.method),
                timeout: timeoutMs,
                maxBodyLength: maxRequestBytes,
                maxContentLength: maxResponseBytes,
                signal: lifecycle.signal,
                maxRedirects: 0,
                validateStatus: () => true,
                proxy: false,
                socketPath: undefined,
                transport: undefined,
                adapter: undefined,
                httpsAgent: undefined,
                httpAgent: undefined
            } // Disable automatic redirects; agents set per-request below
        } catch {
            throwRequestFailure(lifecycle)
        }

        while (redirects <= maxRedirects) {
            const currentUrlObject = parseHttpRequestUrl(currentUrl)
            policy?.validateUrl?.(currentUrlObject)
            const target = await lifecycle.waitFor(resolveAndValidate(currentUrl, policy?.enforceDefaultDenyList === true))
            const agent = createPinnedAgent(target, agentOptions)

            currentConfig = setAxiosHostHeader(
                {
                    ...currentConfig,
                    url: currentUrl,
                    ...(target.protocol === 'http'
                        ? { httpAgent: agent, httpsAgent: undefined }
                        : { httpsAgent: agent, httpAgent: undefined })
                },
                currentUrlObject.host
            )

            const requestState: AxiosHopBodyState = { observed: false, hasBody: false, replaySafe: true }
            const responseState: AxiosHopResponseState = { accounted: false, streamBounded: false }
            const originalResponseType = currentConfig.responseType
            const originalResponseEncoding = currentConfig.responseEncoding
            const preflightRequestBytes =
                currentConfig.transformRequest === undefined && isAxiosTransportBodyReplaySafe(currentConfig.data)
                    ? getKnownBodyByteLength(currentConfig.data)
                    : undefined
            if (preflightRequestBytes !== undefined) {
                try {
                    requestBudget.ensure(preflightRequestBytes)
                } catch {
                    throwResourceLimit(lifecycle)
                }
            }

            const hopConfig: AxiosRequestConfig = {
                ...currentConfig,
                maxBodyLength: requestBudget.remaining,
                maxContentLength: responseBudget.remaining,
                // Axios' Node adapter decodes buffered bodies before running
                // transformResponse. Request an arraybuffer so the budget sees
                // decompressed transport bytes before character decoding.
                responseType: originalResponseType === 'stream' ? 'stream' : 'arraybuffer',
                transformRequest: createBoundedAxiosRequestTransforms(
                    currentConfig.transformRequest,
                    requestBudget,
                    lifecycle,
                    usedRequestStreams,
                    requestState
                ),
                transformResponse: createBoundedAxiosResponseTransforms(
                    currentConfig.transformResponse,
                    originalResponseType,
                    originalResponseEncoding,
                    responseBudget,
                    lifecycle,
                    responseState
                )
            }

            let response: AxiosResponse
            try {
                response = await lifecycle.waitFor(axios(hopConfig))
            } catch (error) {
                if (lifecycle.signal.aborted) throw lifecycle.error
                if (isAxiosResourceLimitFailure(error)) throwResourceLimit(lifecycle)
                throwRequestFailure(lifecycle)
            }

            // Unit-test transports and nonstandard Axios-compatible adapters can
            // bypass transform hooks. Preserve fail-closed accounting for the
            // original transport-ready body without double-counting real Axios.
            if (!requestState.observed) {
                requestState.hasBody = currentConfig.data !== undefined && currentConfig.data !== null
                requestState.replaySafe =
                    !requestState.hasBody ||
                    (currentConfig.transformRequest === undefined && isAxiosTransportBodyReplaySafe(currentConfig.data))
                if (currentConfig.transformRequest !== undefined) throwResourceLimit(lifecycle)
                const fallbackRequestBytes = preflightRequestBytes ?? getAxiosBodyByteLength(currentConfig.data)
                if (fallbackRequestBytes === undefined) throwResourceLimit(lifecycle)
                consumeBudget(requestBudget, fallbackRequestBytes, lifecycle)
            }

            // If it's a successful response (not a redirect), return it.
            if (!REDIRECT_STATUSES.has(response.status)) {
                return boundAxiosResponse(response, responseBudget, lifecycle, responseState)
            }

            // Handle redirect
            const location = response.headers.location
            if (!location) {
                return boundAxiosResponse(response, responseBudget, lifecycle, responseState)
            }

            // The intermediate response is never returned. Release a caller-requested
            // Axios stream before validating or following the next hop.
            await accountDiscardedAxiosResponse(response, responseBudget, lifecycle, responseState)

            redirects++
            if (redirects > maxRedirects) {
                throw new Error('Too many redirects')
            }

            const redirectUrl = parseHttpRequestUrl(location, currentUrl)
            policy?.validateUrl?.(redirectUrl)
            const isCrossOrigin = redirectUrl.origin !== currentUrlObject.origin
            const currentMethod = currentConfig.method?.toUpperCase() ?? 'GET'
            const hasBody = requestState.hasBody

            if (isCrossOrigin) {
                if (!['GET', 'HEAD'].includes(currentMethod) || hasBody) {
                    throw new Error('Cross-origin redirect with request credentials or body is denied by policy.')
                }
                currentConfig = {
                    ...retainAxiosRequestHeaders(currentConfig, SAFE_CROSS_ORIGIN_REDIRECT_HEADERS),
                    auth: undefined,
                    params: undefined,
                    paramsSerializer: undefined,
                    transformRequest: undefined
                }
            }

            currentUrl = redirectUrl.toString()

            // Apply fetch-compatible redirect method semantics.
            const rewritesBodyToGet =
                (response.status === 303 && currentMethod !== 'HEAD') ||
                ((response.status === 301 || response.status === 302) && currentMethod === 'POST')
            if (hasBody && !rewritesBodyToGet && !requestState.replaySafe) throwResourceLimit(lifecycle)

            if (response.status === 301 || response.status === 302 || response.status === 303) {
                const method = currentConfig.method?.toUpperCase()
                if (
                    (response.status === 303 && method !== 'HEAD') ||
                    ((response.status === 301 || response.status === 302) && method === 'POST')
                ) {
                    currentConfig = {
                        ...removeAxiosRequestHeaders(currentConfig, ENTITY_REDIRECT_HEADERS),
                        method: 'GET',
                        data: undefined,
                        // A caller transform may have synthesized the body from
                        // undefined input. Rewriting to GET must remove the whole
                        // entity-producing transform chain on the next hop.
                        transformRequest: undefined
                    }
                }
            }
        }

        throw new Error('Too many redirects')
    } catch (error) {
        lifecycle.cleanup()
        throw error
    }
}

/**
 * Makes a secure fetch request that validates all URLs in redirect chains against the deny list
 * @param url - URL to fetch
 * @param init - Fetch request options
 * @param maxRedirects - Maximum number of redirects to follow (default: 5)
 * @param agentOptions - Optional TLS options (e.g. { ca } for custom CA PEM)
 * @returns Promise<Response>
 * @throws Error if any URL in the redirect chain is denied
 */
export async function secureFetch(
    url: string,
    init?: SecureFetchRequestInit,
    maxRedirects: number = 5,
    agentOptions?: SecureRequestAgentOptions,
    policy?: SecureFetchPolicy
): Promise<Response> {
    const policyLimits = getSecureRequestResourceLimits(policy)
    const timeoutMs = clampDisableableLimit(init?.timeout, policyLimits.timeoutMs)
    const maxRequestBytes = clampAxiosByteLimit(init?.maxBodyLength, policyLimits.maxRequestBytes)
    const maxResponseBytes = clampDisableableLimit(init?.size, policyLimits.maxResponseBytes)
    const lifecycle = new SecureRequestLifecycle(timeoutMs, init?.signal as CompatibleAbortSignal | undefined)
    const requestBudget = new ByteBudget(maxRequestBytes)
    const responseBudget = new ByteBudget(maxResponseBytes)
    const usedRequestStreams = new WeakSet<object>()
    let currentUrl = url
    let redirectCount = 0
    let currentInit: SecureFetchRequestInit = {
        ...init,
        timeout: timeoutMs,
        size: maxResponseBytes,
        signal: lifecycle.signal as unknown as SecureFetchRequestInit['signal'],
        redirect: 'manual'
    } // Disable automatic redirects

    try {
        while (redirectCount <= maxRedirects) {
            const currentUrlObject = parseHttpRequestUrl(currentUrl)
            policy?.validateUrl?.(currentUrlObject)
            const resolved = await lifecycle.waitFor(resolveAndValidate(currentUrl, policy?.enforceDefaultDenyList === true))
            const agent = createPinnedAgent(resolved, agentOptions)
            const agentFactory = (() => agent) as NonNullable<RequestInit['agent']>
            const requestInit = prepareFetchRequestInit(currentInit, requestBudget, lifecycle, usedRequestStreams)

            const response = await lifecycle.waitFor(fetch(currentUrl, { ...requestInit, agent: agentFactory }), true)

            // If it's a successful response (not a redirect), return it.
            if (!REDIRECT_STATUSES.has(response.status)) {
                return boundFetchResponse(response, currentUrl, responseBudget, lifecycle)
            }

            // Handle redirect
            const location = response.headers.get('location')
            if (!location) {
                return boundFetchResponse(response, currentUrl, responseBudget, lifecycle)
            }

            // Manual redirects do not consume streaming intermediate bodies,
            // but already-buffered bodies still count toward the aggregate
            // response budget. Destroy streams before the next hop so a remote
            // peer cannot retain sockets.
            accountDiscardedFetchResponse(response, responseBudget, lifecycle)

            redirectCount++

            if (redirectCount > maxRedirects) {
                throw new Error('Too many redirects')
            }

            // Resolve and classify the redirect before preparing another request.
            const redirectUrl = parseHttpRequestUrl(location, currentUrl)
            policy?.validateUrl?.(redirectUrl)
            const isCrossOrigin = redirectUrl.origin !== currentUrlObject.origin
            const currentMethod = currentInit.method?.toUpperCase() ?? 'GET'
            const hasBody = currentInit.body !== undefined && currentInit.body !== null

            if (isCrossOrigin) {
                if (!['GET', 'HEAD'].includes(currentMethod) || hasBody) {
                    throw new Error('Cross-origin redirect with request credentials or body is denied by policy.')
                }
                currentInit = retainRequestHeaders(currentInit, SAFE_CROSS_ORIGIN_REDIRECT_HEADERS)
            }

            currentUrl = redirectUrl.toString()

            // Handle method changes for redirects according to HTTP specs
            if (response.status === 301 || response.status === 302 || response.status === 303) {
                const method = currentInit.method?.toUpperCase()
                // Fetch semantics: 301/302 rewrite POST; 303 rewrites every method except HEAD.
                if (
                    (response.status === 303 && method !== 'HEAD') ||
                    ((response.status === 301 || response.status === 302) && method === 'POST')
                ) {
                    currentInit = {
                        ...removeRequestHeaders(currentInit, ENTITY_REDIRECT_HEADERS),
                        method: 'GET',
                        body: undefined
                    }
                }
            }
        }

        throw new Error('Too many redirects')
    } catch (error) {
        lifecycle.cleanup()
        throw error
    }
}

type ResolvedTarget = {
    hostname: string
    ip: string
    family: 4 | 6
    protocol: 'http' | 'https'
}

async function resolveAndValidate(url: string, enforceDefaultDenyList: boolean = false): Promise<ResolvedTarget> {
    const enforceGlobalReachability = shouldEnforceDefaultDenyList(enforceDefaultDenyList)
    const denyList = getHttpDenyList(enforceDefaultDenyList)

    const u = parseHttpRequestUrl(url)
    let hostname = u.hostname
    // Strip IPv6 brackets if present
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
        hostname = hostname.slice(1, -1)
    }
    validateHostname(hostname, denyList)
    const protocol: 'http' | 'https' = u.protocol === 'https:' ? 'https' : 'http'

    if (ipaddr.isValid(hostname)) {
        validateResolvedIP(hostname, denyList, enforceGlobalReachability)
        return {
            hostname,
            ip: hostname,
            family: hostname.includes(':') ? 6 : 4,
            protocol
        }
    }

    let records: Array<{ address: string; family: number }>
    try {
        records = await dns.lookup(hostname, { all: true })
    } catch {
        throw new Error(HTTP_REQUEST_FAILED_ERROR)
    }
    if (records.length === 0) {
        throw new Error('DNS resolution failed.')
    }

    for (const r of records) {
        validateResolvedIP(r.address, denyList, enforceGlobalReachability)
    }

    const chosen = records.find((r) => r.family === 4) ?? records[0]

    return {
        hostname,
        ip: chosen.address,
        family: chosen.family as 4 | 6,
        protocol
    }
}

function createPinnedAgent(target: ResolvedTarget, options?: { ca?: string | string[] | Buffer }): http.Agent | https.Agent {
    const Agent = target.protocol === 'https' ? https.Agent : http.Agent

    return new Agent({
        ...(options?.ca === undefined ? {} : { ca: options.ca }),
        lookup: (_host, lookupOptions, callback) => {
            if (typeof lookupOptions === 'object' && lookupOptions.all) {
                const lookupAllCallback = callback as unknown as (
                    error: NodeJS.ErrnoException | null,
                    addresses: Array<{ address: string; family: number }>
                ) => void
                lookupAllCallback(null, [{ address: target.ip, family: target.family }])
                return
            }

            const lookupOneCallback = callback as unknown as (error: NodeJS.ErrnoException | null, address: string, family: number) => void
            lookupOneCallback(null, target.ip, target.family)
        }
    })
}
