import axios, { AxiosRequestConfig, AxiosResponse } from 'axios'
import dns from 'dns/promises'
import http from 'http'
import https from 'https'
import * as ipaddr from 'ipaddr.js'
import fetch, { Headers, RequestInit, Response } from 'node-fetch'

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

    const urlObj = new URL(url)
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

export interface SecureFetchPolicy {
    enforceDefaultDenyList?: boolean
    validateUrl?: (url: URL) => void
}

const SENSITIVE_REDIRECT_HEADERS = [
    'authorization',
    'proxy-authorization',
    'cookie',
    'cookie2',
    'x-api-key',
    'api-key',
    'apikey',
    'x-auth-token',
    'x-access-token',
    'x-amz-security-token',
    'x-goog-api-key',
    'set-cookie'
]

const ENTITY_REDIRECT_HEADERS = [
    'content-encoding',
    'content-language',
    'content-length',
    'content-location',
    'content-type',
    'digest',
    'transfer-encoding'
]

function removeRequestHeaders(init: RequestInit, names: string[]): RequestInit {
    if (!init.headers) return init

    const headers = new Headers(init.headers)
    for (const name of names) headers.delete(name)
    return { ...init, headers }
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
    agentOptions?: SecureRequestAgentOptions
): Promise<AxiosResponse> {
    let currentUrl = config.url
    if (!currentUrl) {
        throw new Error('secureAxiosRequest: url is required')
    }

    let redirects = 0
    let currentConfig: AxiosRequestConfig = {
        ...config,
        maxRedirects: 0,
        validateStatus: () => true,
        httpsAgent: undefined,
        httpAgent: undefined
    } // Disable automatic redirects; agents set per-request below

    while (redirects <= maxRedirects) {
        const target = await resolveAndValidate(currentUrl)
        const agent = createPinnedAgent(target, agentOptions)

        currentConfig = {
            ...currentConfig,
            url: currentUrl,
            ...(target.protocol === 'http' ? { httpAgent: agent } : { httpsAgent: agent }),
            headers: {
                ...currentConfig.headers,
                Host: target.hostname
            }
        }

        const response = await axios(currentConfig)

        // If it's a successful response (not a redirect), return it
        if (response.status < 300 || response.status >= 400) {
            return response
        }

        // Handle redirect
        const location = response.headers.location
        if (!location) {
            // No location header, but it's a redirect status - return the response
            return response
        }

        redirects++
        if (redirects > maxRedirects) {
            throw new Error('Too many redirects')
        }

        currentUrl = new URL(location, currentUrl).toString()

        // For redirects, we only need to preserve certain headers and change method if needed
        if (response.status === 301 || response.status === 302 || response.status === 303) {
            // For 303, or when redirecting POST requests, change to GET
            if (
                response.status === 303 ||
                (currentConfig.method && ['POST', 'PUT', 'PATCH'].includes(currentConfig.method.toUpperCase()))
            ) {
                currentConfig.method = 'GET'
                delete currentConfig.data
            }
        }
    }

    throw new Error('Too many redirects')
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
    init?: RequestInit,
    maxRedirects: number = 5,
    agentOptions?: SecureRequestAgentOptions,
    policy?: SecureFetchPolicy
): Promise<Response> {
    let currentUrl = url
    let redirectCount = 0
    let currentInit: RequestInit = { ...init, redirect: 'manual' } // Disable automatic redirects

    while (redirectCount <= maxRedirects) {
        policy?.validateUrl?.(new URL(currentUrl))
        const resolved = await resolveAndValidate(currentUrl, policy?.enforceDefaultDenyList === true)
        const agent = createPinnedAgent(resolved, agentOptions)

        const response = await fetch(currentUrl, { ...currentInit, agent: () => agent })

        // If it's a successful response (not a redirect), return it
        if (response.status < 300 || response.status >= 400) {
            return response
        }

        // Handle redirect
        const location = response.headers.get('location')
        if (!location) {
            // No location header, but it's a redirect status - return the response
            return response
        }

        redirectCount++

        if (redirectCount > maxRedirects) {
            throw new Error('Too many redirects')
        }

        // Resolve and classify the redirect before preparing another request.
        const redirectUrl = new URL(location, currentUrl)
        policy?.validateUrl?.(redirectUrl)
        const isCrossOrigin = redirectUrl.origin !== new URL(currentUrl).origin
        const currentMethod = currentInit.method?.toUpperCase() ?? 'GET'
        const hasBody = currentInit.body !== undefined && currentInit.body !== null

        if (isCrossOrigin) {
            if (!['GET', 'HEAD'].includes(currentMethod) || hasBody) {
                throw new Error('Cross-origin redirect with request credentials or body is denied by policy.')
            }
            currentInit = removeRequestHeaders(currentInit, SENSITIVE_REDIRECT_HEADERS)
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

    const u = new URL(url)
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

    const records = await dns.lookup(hostname, { all: true })
    if (records.length === 0) {
        throw new Error(`DNS resolution failed for ${hostname}`)
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
        },
        ...options
    })
}
