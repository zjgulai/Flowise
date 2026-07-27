import dns from 'dns/promises'
import http from 'http'
import net from 'net'
import * as ipaddr from 'ipaddr.js'
import { checkDenyList, isDeniedIP, type SecureFetchPolicy } from '../../src/httpSecurity'

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])
const DEFAULT_WEB_SCRAPER_DENY_LIST = [
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
const GLOBALLY_REACHABLE_IPV4_EXCEPTIONS = new Set(['192.0.0.9', '192.0.0.10'])
const GLOBALLY_REACHABLE_IPV6_EXCEPTIONS = new Set(['2001:1::1', '2001:1::2', '2001:1::3'])
const DEFAULT_OPERATION_DRAIN_TIMEOUT_MS = 30_000
const HOP_BY_HOP_HEADERS = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
])

export const WEB_SCRAPER_POLICY_ERROR_CODE = 'WEB_SCRAPER_POLICY_DENIED'

/**
 * A deliberately URL-free error used to distinguish an explicit network-policy
 * rejection from the loaders' historical best-effort transport failures.
 */
export class WebScraperPolicyError extends Error {
    readonly code = WEB_SCRAPER_POLICY_ERROR_CODE

    constructor() {
        super('Web scraper request was denied by network policy.')
        this.name = 'WebScraperPolicyError'
    }
}

export const WEB_SCRAPER_SECURE_FETCH_POLICY: Readonly<SecureFetchPolicy> = Object.freeze({
    enforceDefaultDenyList: true,
    validateUrl: (url: URL) => {
        if (!ALLOWED_PROTOCOLS.has(url.protocol)) throw new WebScraperPolicyError()
    }
})

export function toWebScraperPolicyError(error?: unknown): WebScraperPolicyError {
    return isWebScraperPolicyError(error) ? (error as WebScraperPolicyError) : new WebScraperPolicyError()
}

export function isWebScraperPolicyError(error: unknown): boolean {
    return (
        error instanceof WebScraperPolicyError ||
        (typeof error === 'object' && error !== null && 'code' in error && error.code === WEB_SCRAPER_POLICY_ERROR_CODE)
    )
}

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

    const embeddedIPv4 = getWellKnownNat64EmbeddedIPv4(ipv6)
    if (embeddedIPv4) return isGloballyReachableIP(embeddedIPv4.toString())

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

function validateDefaultWebScraperIP(ip: string): void {
    if (!isGloballyReachableIP(ip)) throw new WebScraperPolicyError()
    isDeniedIP(ip, DEFAULT_WEB_SCRAPER_DENY_LIST)

    const embeddedIPv4 = getWellKnownNat64EmbeddedIPv4(ipaddr.parse(ip))
    if (embeddedIPv4) isDeniedIP(embeddedIPv4.toString(), DEFAULT_WEB_SCRAPER_DENY_LIST)
}

async function assertDefaultWebScraperDenyList(url: URL): Promise<void> {
    const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname
    const canonicalHostname = hostname.trim().toLowerCase().replace(/\.+$/, '')
    if (DEFAULT_WEB_SCRAPER_DENY_LIST.includes(canonicalHostname)) throw new WebScraperPolicyError()

    const literalFamily = net.isIP(hostname)
    if (literalFamily) {
        validateDefaultWebScraperIP(hostname)
        return
    }

    const records = await dns.lookup(hostname, { all: true, verbatim: true })
    if (records.length === 0) throw new WebScraperPolicyError()
    for (const record of records) {
        if (!net.isIP(record.address)) throw new WebScraperPolicyError()
        validateDefaultWebScraperIP(record.address)
    }
}

/**
 * Applies both the compatibility-aware shared HTTP policy and the scraper's
 * mandatory public-network policy. HTTP_SECURITY_CHECK=false may be needed by
 * explicitly configured private integrations, but it must never expose the
 * public web-scraper nodes to private, local, or special-purpose addresses.
 */
export async function assertWebScraperUrlAllowed(url: string): Promise<void> {
    try {
        const parsed = new URL(url)
        if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) throw new Error('Unsupported web scraper protocol')
        await checkDenyList(parsed.toString())
        await assertDefaultWebScraperDenyList(parsed)
    } catch (error) {
        throw toWebScraperPolicyError(error)
    }
}

export class WebScraperPolicyGuard {
    private violation?: WebScraperPolicyError

    record(error: unknown): WebScraperPolicyError {
        const violation = toWebScraperPolicyError(error)
        this.violation ??= violation
        return violation
    }

    async allows(url: string): Promise<boolean> {
        try {
            await assertWebScraperUrlAllowed(url)
            return true
        } catch (error) {
            this.record(error)
            return false
        }
    }

    throwIfDenied(): void {
        if (this.violation) throw this.violation
    }
}

/**
 * Tracks asynchronous policy work from event callbacks. Closing is a
 * one-way transition: work accepted before it is drained, while callbacks
 * arriving during teardown are rejected before they can start upstream I/O.
 */
export class WebScraperOperationTracker {
    private readonly pending = new Set<Promise<void>>()
    private closing = false
    private generation = 0

    constructor(private readonly drainTimeoutMs: number = DEFAULT_OPERATION_DRAIN_TIMEOUT_MS) {
        if (!Number.isInteger(drainTimeoutMs) || drainTimeoutMs < 1) throw new Error('Web scraper operation drain timeout must be positive')
    }

    get isClosing(): boolean {
        return this.closing
    }

    start(operation: () => Promise<void>, onError: (error: unknown) => void): Promise<void> | undefined {
        if (this.closing) return undefined

        const tracked = Promise.resolve()
            .then(operation)
            .catch((error) => {
                onError(error)
            })
        this.pending.add(tracked)
        this.generation += 1
        void tracked.then(() => {
            this.pending.delete(tracked)
            this.generation += 1
        })
        return tracked
    }

    beginClosing(): void {
        this.closing = true
    }

    async drain(): Promise<void> {
        const deadline = Date.now() + this.drainTimeoutMs
        let stable = false
        while (!stable) {
            const generation = this.generation
            const snapshot = [...this.pending]
            if (snapshot.length > 0) {
                const remaining = deadline - Date.now()
                if (remaining <= 0) throw new WebScraperPolicyError()

                let timeout: NodeJS.Timeout | undefined
                try {
                    await Promise.race([
                        Promise.all(snapshot),
                        new Promise<never>((_resolve, reject) => {
                            timeout = setTimeout(() => reject(new WebScraperPolicyError()), remaining)
                        })
                    ])
                } finally {
                    if (timeout) clearTimeout(timeout)
                }
            }

            // Give finally/then callbacks and synchronously queued event work a
            // chance to update the set before declaring it stable.
            await Promise.resolve()
            stable = this.pending.size === 0 && this.generation === generation
            if (!stable && Date.now() >= deadline) throw new WebScraperPolicyError()
        }
    }
}

export type PinnedBrowserTarget = {
    address: string
    family: 4 | 6
    hostname: string
    port: number
}

function formatLiteralUrl(protocol: 'http:' | 'https:', address: string, port: number): string {
    const hostname = net.isIPv6(address) ? `[${address}]` : address
    return `${protocol}//${hostname}:${port}/`
}

/**
 * Resolves twice by design. The shared policy performs the hostname/custom-list
 * check and validates its DNS set; the second set is validated as literals and
 * is the exact set from which the proxy pins its TCP connection. A DNS change
 * between the two resolutions therefore cannot swap in an unchecked address.
 */
export async function resolvePinnedBrowserTarget(target: URL): Promise<PinnedBrowserTarget> {
    await assertWebScraperUrlAllowed(target.toString())

    const hostname = target.hostname.startsWith('[') && target.hostname.endsWith(']') ? target.hostname.slice(1, -1) : target.hostname
    const port = target.port ? Number(target.port) : target.protocol === 'https:' ? 443 : 80

    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new WebScraperPolicyError()

    const literalFamily = net.isIP(hostname)
    if (literalFamily) {
        return { address: hostname, family: literalFamily as 4 | 6, hostname, port }
    }

    let records: Array<{ address: string; family: number }>
    try {
        records = await dns.lookup(hostname, { all: true, verbatim: true })
    } catch (error) {
        throw toWebScraperPolicyError(error)
    }
    if (records.length === 0) throw new WebScraperPolicyError()

    for (const record of records) {
        const family = net.isIP(record.address)
        if (!family) throw new WebScraperPolicyError()
        await assertWebScraperUrlAllowed(formatLiteralUrl(target.protocol as 'http:' | 'https:', record.address, port))
    }

    const selected = records.find((record) => net.isIPv4(record.address)) ?? records[0]
    return {
        address: selected.address,
        family: net.isIP(selected.address) as 4 | 6,
        hostname,
        port
    }
}

export type PinnedBrowserProxy = {
    server: string
    close: () => Promise<void>
}

type DestroyableTransport = {
    destroy: () => unknown
}

function requestHeaders(headers: http.IncomingHttpHeaders, host: string): http.OutgoingHttpHeaders {
    const forwarded: http.OutgoingHttpHeaders = { host }
    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase()) || name.toLowerCase() === 'host') continue
        forwarded[name] = value
    }
    return forwarded
}

function responseHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
    const forwarded: http.OutgoingHttpHeaders = {}
    for (const [name, value] of Object.entries(headers)) {
        if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue
        forwarded[name] = value
    }
    return forwarded
}

/**
 * Starts a loopback-only forward proxy for one browser scrape. HTTPS remains
 * end-to-end encrypted: CONNECT is tunneled to the exact validated IP while the
 * browser still verifies TLS against the original hostname. Plain HTTP is
 * forwarded with a direct, non-pooled connection to the same pinned target.
 */
export async function startPinnedBrowserProxy(guard: WebScraperPolicyGuard): Promise<PinnedBrowserProxy> {
    const sockets = new Set<DestroyableTransport>()
    const upstreamSockets = new Set<DestroyableTransport>()
    const upstreamRequests = new Set<http.ClientRequest>()
    const upstreamResponses = new Set<http.IncomingMessage>()
    const operations = new WebScraperOperationTracker()

    const server = http.createServer((request, response) => {
        const operation = operations.start(
            async () => {
                let target: URL
                try {
                    target = new URL(request.url ?? '')
                    if (target.protocol !== 'http:') throw new Error('Forward proxy only accepts absolute HTTP requests')
                } catch (error) {
                    guard.record(error)
                    response.destroy()
                    return
                }

                let pinned: PinnedBrowserTarget
                try {
                    pinned = await resolvePinnedBrowserTarget(target)
                } catch (error) {
                    guard.record(error)
                    response.destroy()
                    return
                }
                if (operations.isClosing) {
                    response.destroy()
                    return
                }

                let settleTransport!: () => void
                const transportClosed = new Promise<void>((resolve) => {
                    let settled = false
                    settleTransport = () => {
                        if (settled) return
                        settled = true
                        resolve()
                    }
                })

                const upstream = http.request(
                    {
                        agent: false,
                        family: pinned.family,
                        headers: requestHeaders(request.headers, target.host),
                        host: pinned.address,
                        method: request.method,
                        path: `${target.pathname}${target.search}`,
                        port: pinned.port,
                        protocol: 'http:'
                    },
                    (upstreamResponse) => {
                        try {
                            upstreamResponses.add(upstreamResponse)
                            upstreamResponse.once('close', () => {
                                upstreamResponses.delete(upstreamResponse)
                                settleTransport()
                            })
                            upstreamResponse.once('end', settleTransport)
                            upstreamResponse.once('aborted', () => {
                                response.destroy()
                                settleTransport()
                            })
                            upstreamResponse.once('error', () => {
                                response.destroy()
                                settleTransport()
                            })
                            if (operations.isClosing) {
                                upstreamResponse.destroy()
                                response.destroy()
                                settleTransport()
                                return
                            }
                            response.writeHead(
                                upstreamResponse.statusCode ?? 502,
                                upstreamResponse.statusMessage,
                                responseHeaders(upstreamResponse.headers)
                            )
                            upstreamResponse.pipe(response)
                        } catch {
                            upstreamResponse.destroy()
                            response.destroy()
                            settleTransport()
                        }
                    }
                )

                upstreamRequests.add(upstream)
                upstream.once('close', () => upstreamRequests.delete(upstream))
                upstream.once('close', settleTransport)
                upstream.on('socket', (socket) => {
                    upstreamSockets.add(socket)
                    socket.once('close', () => upstreamSockets.delete(socket))
                })
                upstream.once('error', () => {
                    response.destroy()
                    settleTransport()
                })
                request.once('aborted', () => {
                    upstream.destroy()
                    settleTransport()
                })
                request.once('error', () => {
                    upstream.destroy()
                    settleTransport()
                })
                response.once('close', () => {
                    upstream.destroy()
                    settleTransport()
                })
                response.once('error', () => {
                    upstream.destroy()
                    settleTransport()
                })
                try {
                    request.pipe(upstream)
                } catch (error) {
                    upstream.destroy()
                    throw error
                }
                await transportClosed
            },
            (error) => {
                guard.record(error)
                response.destroy()
            }
        )
        if (!operation) {
            guard.record(new Error('Pinned browser proxy received an HTTP request while closing'))
            response.destroy()
        }
    })

    server.on('connect', (request, clientSocket, head) => {
        // Node removes its internal socket error listener before emitting
        // CONNECT. Install a synchronous replacement before policy work is
        // deferred into the operation tracker.
        clientSocket.once('error', () => clientSocket.destroy())
        const operation = operations.start(
            async () => {
                let target: URL
                try {
                    target = new URL(`https://${request.url ?? ''}`)
                } catch (error) {
                    guard.record(error)
                    clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
                    return
                }

                let pinned: PinnedBrowserTarget
                try {
                    pinned = await resolvePinnedBrowserTarget(target)
                } catch (error) {
                    guard.record(error)
                    clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
                    return
                }
                if (operations.isClosing || clientSocket.destroyed) {
                    clientSocket.destroy()
                    return
                }

                let settleTransport!: () => void
                const transportClosed = new Promise<void>((resolve) => {
                    let settled = false
                    settleTransport = () => {
                        if (settled) return
                        settled = true
                        resolve()
                    }
                })

                const upstream = net.connect({ family: pinned.family, host: pinned.address, port: pinned.port })
                upstreamSockets.add(upstream)
                upstream.once('close', () => {
                    upstreamSockets.delete(upstream)
                    settleTransport()
                })
                upstream.once('error', () => {
                    clientSocket.destroy()
                    settleTransport()
                })
                clientSocket.once('close', () => {
                    upstream.destroy()
                    settleTransport()
                })
                clientSocket.once('error', () => {
                    upstream.destroy()
                    settleTransport()
                })
                upstream.once('connect', () => {
                    try {
                        if (operations.isClosing) {
                            upstream.destroy()
                            clientSocket.destroy()
                            settleTransport()
                            return
                        }
                        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
                        if (head.length > 0) upstream.write(head)
                        upstream.pipe(clientSocket)
                        clientSocket.pipe(upstream)
                    } catch {
                        upstream.destroy()
                        clientSocket.destroy()
                        settleTransport()
                    }
                })
                await transportClosed
            },
            (error) => {
                guard.record(error)
                clientSocket.destroy()
            }
        )
        if (!operation) {
            guard.record(new Error('Pinned browser proxy received a CONNECT request while closing'))
            clientSocket.destroy()
        }
    })

    server.on('upgrade', (_request, socket) => {
        // Plaintext WebSockets would otherwise require a second unpinned
        // forwarding implementation. Secure WebSockets use CONNECT above.
        guard.record(new Error('Plaintext WebSocket forwarding is denied'))
        socket.once('error', () => socket.destroy())
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    })
    server.on('clientError', (_error, socket) => socket.destroy())
    server.on('connection', (socket) => {
        sockets.add(socket)
        socket.once('close', () => sockets.delete(socket))
    })

    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error)
        server.once('error', onError)
        server.listen(0, '127.0.0.1', () => {
            ;(server as unknown as { removeListener: (event: string, listener: (error: Error) => void) => unknown }).removeListener(
                'error',
                onError
            )
            resolve()
        })
    })

    const address = server.address()
    if (!address || typeof address === 'string') {
        server.close()
        throw new Error('Pinned browser proxy failed to bind a TCP port')
    }

    let closePromise: Promise<void> | undefined
    const destroyTrackedTransports = () => {
        for (const request of upstreamRequests) request.destroy()
        for (const response of upstreamResponses) response.destroy()
        for (const socket of sockets) socket.destroy()
        for (const socket of upstreamSockets) socket.destroy()
    }

    return {
        server: `http://127.0.0.1:${address.port}`,
        close: () => {
            closePromise ??= (async () => {
                operations.beginClosing()
                destroyTrackedTransports()

                let closeError: unknown
                try {
                    if (server.listening) {
                        await new Promise<void>((resolve, reject) => {
                            server.close((error) => (error ? reject(error) : resolve()))
                        })
                    }
                } catch (error) {
                    closeError = error
                }

                try {
                    await operations.drain()
                } catch (error) {
                    guard.record(error)
                    closeError ??= error
                }
                // An accepted operation may have acquired a request/socket just
                // before closing began. Reap once more after the stable drain.
                destroyTrackedTransports()
                if (closeError) throw closeError
            })()
            return closePromise
        }
    }
}
