import { describe, expect, it } from '@jest/globals'
import axios, { AxiosHeaders } from 'axios'
import dns from 'dns/promises'
import http from 'http'
import fetch, { Headers, Response } from 'node-fetch'
import { PassThrough, Readable } from 'stream'
import {
    checkDenyList,
    createFixedOriginPolicy,
    createTrustedSecureRequestResourceLimits,
    isDeniedIP,
    resolveFlowiseRequestTarget,
    secureAxiosRequest,
    secureFetch
} from './httpSecurity'

jest.mock('axios', () => {
    const actual = jest.requireActual('axios')
    return { ...actual, __esModule: true, default: jest.fn() }
})

jest.mock('node-fetch', () => {
    const actual = jest.requireActual('node-fetch')
    return { ...actual, __esModule: true, default: jest.fn() }
})

// Test deny list covering common SSRF targets
const TEST_DENY_LIST = [
    '0.0.0.0',
    '10.0.0.0/8', // RFC1918 Class A
    '127.0.0.0/8', // Loopback
    '169.254.0.0/16', // Link-local (includes cloud metadata)
    '169.254.169.254', // AWS metadata (specific)
    '172.16.0.0/12', // RFC1918 Class B
    '192.168.0.0/16', // RFC1918 Class C
    '224.0.0.0/4', // Multicast
    '240.0.0.0/4', // Reserved
    '255.255.255.255/32', // Broadcast
    '::1', // IPv6 loopback
    'fc00::/7', // IPv6 ULA
    'fe80::/10', // IPv6 link-local
    'ff00::/8' // IPv6 multicast
]

describe('isDeniedIP - SSRF Protection', () => {
    describe('IPv4 Address Blocking (Normal Cases)', () => {
        it('should block loopback address 127.0.0.1', () => {
            expect(() => isDeniedIP('127.0.0.1', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block AWS metadata endpoint 169.254.169.254', () => {
            expect(() => isDeniedIP('169.254.169.254', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block RFC1918 private address 10.0.0.1', () => {
            expect(() => isDeniedIP('10.0.0.1', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block RFC1918 private address 192.168.1.1', () => {
            expect(() => isDeniedIP('192.168.1.1', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block RFC1918 private address 172.16.0.1', () => {
            expect(() => isDeniedIP('172.16.0.1', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block 0.0.0.0', () => {
            expect(() => isDeniedIP('0.0.0.0', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block multicast address 224.0.0.1', () => {
            expect(() => isDeniedIP('224.0.0.1', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block reserved address 240.0.0.1', () => {
            expect(() => isDeniedIP('240.0.0.1', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block broadcast address 255.255.255.255', () => {
            expect(() => isDeniedIP('255.255.255.255', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should allow public IPv4 address 8.8.8.8', () => {
            expect(() => isDeniedIP('8.8.8.8', TEST_DENY_LIST)).not.toThrow()
        })

        it('should allow public IPv4 address 1.1.1.1', () => {
            expect(() => isDeniedIP('1.1.1.1', TEST_DENY_LIST)).not.toThrow()
        })
    })

    describe('IPv4-Mapped IPv6 Address Blocking (SSRF Bypass Prevention)', () => {
        it('should block IPv4-mapped IPv6 loopback ::ffff:127.0.0.1', () => {
            expect(() => isDeniedIP('::ffff:127.0.0.1', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block IPv4-mapped IPv6 AWS metadata ::ffff:169.254.169.254', () => {
            expect(() => isDeniedIP('::ffff:169.254.169.254', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block IPv4-mapped IPv6 private address ::ffff:10.0.0.1', () => {
            expect(() => isDeniedIP('::ffff:10.0.0.1', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block IPv4-mapped IPv6 private address ::ffff:192.168.1.1', () => {
            expect(() => isDeniedIP('::ffff:192.168.1.1', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block IPv4-mapped IPv6 private address ::ffff:172.16.0.1', () => {
            expect(() => isDeniedIP('::ffff:172.16.0.1', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block IPv4-mapped IPv6 link-local ::ffff:169.254.0.1', () => {
            expect(() => isDeniedIP('::ffff:169.254.0.1', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block IPv4-mapped IPv6 broadcast ::ffff:255.255.255.255', () => {
            expect(() => isDeniedIP('::ffff:255.255.255.255', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block IPv4-mapped IPv6 multicast ::ffff:224.0.0.1', () => {
            expect(() => isDeniedIP('::ffff:224.0.0.1', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should allow IPv4-mapped IPv6 public address ::ffff:8.8.8.8', () => {
            expect(() => isDeniedIP('::ffff:8.8.8.8', TEST_DENY_LIST)).not.toThrow()
        })

        it('should allow IPv4-mapped IPv6 public address ::ffff:1.1.1.1', () => {
            expect(() => isDeniedIP('::ffff:1.1.1.1', TEST_DENY_LIST)).not.toThrow()
        })
    })

    describe('IPv6 Address Blocking', () => {
        it('should block IPv6 loopback ::1', () => {
            expect(() => isDeniedIP('::1', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block IPv6 link-local fe80::1', () => {
            expect(() => isDeniedIP('fe80::1', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block IPv6 ULA fc00::1', () => {
            expect(() => isDeniedIP('fc00::1', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block IPv6 multicast ff02::1', () => {
            expect(() => isDeniedIP('ff02::1', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should allow public IPv6 address 2001:4860:4860::8888', () => {
            expect(() => isDeniedIP('2001:4860:4860::8888', TEST_DENY_LIST)).not.toThrow()
        })
    })

    describe('CIDR Range Matching', () => {
        it('should block IP at start of CIDR range 10.0.0.0', () => {
            expect(() => isDeniedIP('10.0.0.0', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block IP in middle of CIDR range 10.128.0.1', () => {
            expect(() => isDeniedIP('10.128.0.1', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block IP at end of CIDR range 10.255.255.255', () => {
            expect(() => isDeniedIP('10.255.255.255', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block IP in 172.16.0.0/12 range - 172.31.255.255', () => {
            expect(() => isDeniedIP('172.31.255.255', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should allow IP just outside 172.16.0.0/12 range - 172.32.0.1', () => {
            expect(() => isDeniedIP('172.32.0.1', TEST_DENY_LIST)).not.toThrow()
        })

        it('should block IP in 169.254.0.0/16 range - 169.254.100.100', () => {
            expect(() => isDeniedIP('169.254.100.100', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })
    })

    describe('CIDR Range Matching with IPv4-Mapped IPv6', () => {
        it('should block IPv4-mapped IPv6 at start of CIDR range ::ffff:10.0.0.0', () => {
            expect(() => isDeniedIP('::ffff:10.0.0.0', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block IPv4-mapped IPv6 in middle of CIDR range ::ffff:10.128.0.1', () => {
            expect(() => isDeniedIP('::ffff:10.128.0.1', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block IPv4-mapped IPv6 at end of CIDR range ::ffff:10.255.255.255', () => {
            expect(() => isDeniedIP('::ffff:10.255.255.255', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block IPv4-mapped IPv6 in 169.254.0.0/16 range - ::ffff:169.254.100.100', () => {
            expect(() => isDeniedIP('::ffff:169.254.100.100', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should allow IPv4-mapped IPv6 outside deny ranges - ::ffff:172.32.0.1', () => {
            expect(() => isDeniedIP('::ffff:172.32.0.1', TEST_DENY_LIST)).not.toThrow()
        })
    })

    describe('Exact IP Match (Non-CIDR)', () => {
        it('should block exact match 169.254.169.254', () => {
            expect(() => isDeniedIP('169.254.169.254', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block exact match 0.0.0.0', () => {
            expect(() => isDeniedIP('0.0.0.0', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })
    })

    describe('Edge Cases and Security', () => {
        it('should handle empty deny list without errors', () => {
            expect(() => isDeniedIP('127.0.0.1', [])).not.toThrow()
        })

        it('should handle multiple CIDR entries correctly', () => {
            const multiCIDR = ['10.0.0.0/8', '192.168.0.0/16', '172.16.0.0/12']
            expect(() => isDeniedIP('10.5.5.5', multiCIDR)).toThrow('Access to this host is denied by policy.')
            expect(() => isDeniedIP('192.168.5.5', multiCIDR)).toThrow('Access to this host is denied by policy.')
            expect(() => isDeniedIP('172.20.5.5', multiCIDR)).toThrow('Access to this host is denied by policy.')
        })

        it('should block all variations of loopback', () => {
            expect(() => isDeniedIP('127.0.0.1', TEST_DENY_LIST)).toThrow()
            expect(() => isDeniedIP('127.1.1.1', TEST_DENY_LIST)).toThrow()
            expect(() => isDeniedIP('127.255.255.255', TEST_DENY_LIST)).toThrow()
        })

        it('should block all variations of loopback via IPv4-mapped IPv6', () => {
            expect(() => isDeniedIP('::ffff:127.0.0.1', TEST_DENY_LIST)).toThrow()
            expect(() => isDeniedIP('::ffff:127.1.1.1', TEST_DENY_LIST)).toThrow()
            expect(() => isDeniedIP('::ffff:127.255.255.255', TEST_DENY_LIST)).toThrow()
        })
    })

    describe('Cloud Metadata Endpoints (Real-world SSRF Targets)', () => {
        it('should block AWS metadata endpoint 169.254.169.254', () => {
            expect(() => isDeniedIP('169.254.169.254', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block AWS metadata via IPv4-mapped IPv6 ::ffff:169.254.169.254', () => {
            expect(() => isDeniedIP('::ffff:169.254.169.254', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block any IP in 169.254.0.0/16 range (link-local)', () => {
            expect(() => isDeniedIP('169.254.1.1', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
            expect(() => isDeniedIP('169.254.255.255', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should block link-local via IPv4-mapped IPv6', () => {
            expect(() => isDeniedIP('::ffff:169.254.1.1', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
            expect(() => isDeniedIP('::ffff:169.254.255.255', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })
    })

    describe('Regression Tests - CVE-2026-31829 Related', () => {
        it('should not allow bypassing via IPv4-mapped IPv6 to localhost', () => {
            // This would have bypassed the old vulnerable code
            expect(() => isDeniedIP('::ffff:127.0.0.1', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should not allow bypassing via IPv4-mapped IPv6 to private networks', () => {
            // These would have bypassed the old vulnerable code
            expect(() => isDeniedIP('::ffff:10.0.0.1', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
            expect(() => isDeniedIP('::ffff:192.168.0.1', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
            expect(() => isDeniedIP('::ffff:172.16.0.1', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })

        it('should not allow bypassing via IPv4-mapped IPv6 to cloud metadata', () => {
            // Critical SSRF target that would have been bypassed
            expect(() => isDeniedIP('::ffff:169.254.169.254', TEST_DENY_LIST)).toThrow('Access to this host is denied by policy.')
        })
    })

    describe('IPv4-Mapped IPv6 CIDR in Deny List', () => {
        const mappedCIDRDenyList = [
            '::ffff:10.0.0.0/104', // Equivalent to 10.0.0.0/8
            '::ffff:127.0.0.0/104', // Equivalent to 127.0.0.0/8
            '::ffff:192.168.0.0/112' // Equivalent to 192.168.0.0/16
        ]

        it('should block IPv4 address matching IPv4-mapped IPv6 CIDR in deny list', () => {
            expect(() => isDeniedIP('10.5.5.5', mappedCIDRDenyList)).toThrow('Access to this host is denied by policy.')
            expect(() => isDeniedIP('127.0.0.1', mappedCIDRDenyList)).toThrow('Access to this host is denied by policy.')
            expect(() => isDeniedIP('192.168.1.1', mappedCIDRDenyList)).toThrow('Access to this host is denied by policy.')
        })

        it('should block IPv4-mapped IPv6 address matching IPv4-mapped IPv6 CIDR in deny list', () => {
            expect(() => isDeniedIP('::ffff:10.5.5.5', mappedCIDRDenyList)).toThrow('Access to this host is denied by policy.')
            expect(() => isDeniedIP('::ffff:127.0.0.1', mappedCIDRDenyList)).toThrow('Access to this host is denied by policy.')
            expect(() => isDeniedIP('::ffff:192.168.1.1', mappedCIDRDenyList)).toThrow('Access to this host is denied by policy.')
        })

        it('should allow IPv4 address outside IPv4-mapped IPv6 CIDR in deny list', () => {
            expect(() => isDeniedIP('8.8.8.8', mappedCIDRDenyList)).not.toThrow()
            expect(() => isDeniedIP('1.1.1.1', mappedCIDRDenyList)).not.toThrow()
        })

        it('should correctly match CIDR boundaries with IPv4-mapped IPv6 in deny list', () => {
            // Test edge cases for the mask adjustment logic
            expect(() => isDeniedIP('10.0.0.0', mappedCIDRDenyList)).toThrow('Access to this host is denied by policy.')
            expect(() => isDeniedIP('10.255.255.255', mappedCIDRDenyList)).toThrow('Access to this host is denied by policy.')
            expect(() => isDeniedIP('192.168.0.0', mappedCIDRDenyList)).toThrow('Access to this host is denied by policy.')
            expect(() => isDeniedIP('192.168.255.255', mappedCIDRDenyList)).toThrow('Access to this host is denied by policy.')
        })
    })

    describe('Non-Canonical IPv6 Address Matching', () => {
        it('should block IPv6 address when deny list has uppercase variant', () => {
            // Deny list has FE80::1 (uppercase), should still match fe80::1
            const denyListUppercase = ['FE80::1']
            expect(() => isDeniedIP('fe80::1', denyListUppercase)).toThrow('Access to this host is denied by policy.')
        })

        it('should block IPv6 address when deny list has leading zeros', () => {
            // Deny list has 2001:0DB8::1 (leading zeros), should still match 2001:db8::1
            const denyListLeadingZeros = ['2001:0DB8::1']
            expect(() => isDeniedIP('2001:db8::1', denyListLeadingZeros)).toThrow('Access to this host is denied by policy.')
        })

        it('should block canonical IPv6 when deny list has non-canonical form', () => {
            // Deny list has non-canonical form, canonical request should still be blocked
            const denyListNonCanonical = ['FE80:0000:0000:0000:0000:0000:0000:0001']
            expect(() => isDeniedIP('fe80::1', denyListNonCanonical)).toThrow('Access to this host is denied by policy.')
        })

        it('should block non-canonical IPv6 when deny list has canonical form', () => {
            // Deny list has canonical form, non-canonical request should still be blocked
            const denyListCanonical = ['fe80::1']
            expect(() => isDeniedIP('FE80::1', denyListCanonical)).toThrow('Access to this host is denied by policy.')
            expect(() => isDeniedIP('FE80:0000:0000:0000:0000:0000:0000:0001', denyListCanonical)).toThrow(
                'Access to this host is denied by policy.'
            )
        })

        it('should block IPv4-mapped IPv6 with mixed case in deny list', () => {
            // Deny list has ::FFFF:127.0.0.1 (uppercase), should match any variant
            const denyListMixedCase = ['::FFFF:127.0.0.1']
            expect(() => isDeniedIP('::ffff:127.0.0.1', denyListMixedCase)).toThrow('Access to this host is denied by policy.')
            expect(() => isDeniedIP('127.0.0.1', denyListMixedCase)).toThrow('Access to this host is denied by policy.')
        })

        it('should normalize both sides when deny list has non-canonical IPv4-mapped IPv6', () => {
            // Deny list has 0000:0000:0000:0000:0000:FFFF:7F00:0001 (non-canonical form of ::ffff:127.0.0.1)
            const denyListLongForm = ['0000:0000:0000:0000:0000:FFFF:7F00:0001']
            expect(() => isDeniedIP('::ffff:127.0.0.1', denyListLongForm)).toThrow('Access to this host is denied by policy.')
            expect(() => isDeniedIP('127.0.0.1', denyListLongForm)).toThrow('Access to this host is denied by policy.')
        })

        it('should allow IPv6 addresses that do not match despite normalization', () => {
            const denyListFe80 = ['FE80::1']
            expect(() => isDeniedIP('fe80::2', denyListFe80)).not.toThrow()
            expect(() => isDeniedIP('2001:4860:4860::8888', denyListFe80)).not.toThrow()
        })
    })

    describe('Malformed IPv4-Mapped IPv6 CIDR Handling', () => {
        it('should skip malformed IPv4-mapped IPv6 CIDR with mask < 96', () => {
            // ::ffff:10.0.0.0/64 would create negative adjustedMask (-32)
            const malformedList = ['::ffff:10.0.0.0/64']

            // Public IPs should NOT be blocked
            expect(() => isDeniedIP('8.8.8.8', malformedList)).not.toThrow()
            expect(() => isDeniedIP('1.1.1.1', malformedList)).not.toThrow()
        })

        it('should skip malformed entry but still check other valid entries', () => {
            // Mix malformed and valid entries
            const mixedList = [
                '::ffff:10.0.0.0/64', // Malformed - should be skipped
                '127.0.0.0/8' // Valid - should still work
            ]

            // Should block based on valid entry
            expect(() => isDeniedIP('127.0.0.1', mixedList)).toThrow('Access to this host is denied by policy.')

            // Should allow public IPs (malformed entry skipped)
            expect(() => isDeniedIP('8.8.8.8', mixedList)).not.toThrow()
        })

        it('should accept valid IPv4-mapped IPv6 CIDR with mask >= 96', () => {
            // Valid: mask = 104 >= 96, adjustedMask = 104 - 96 = 8
            const validList = ['::ffff:10.0.0.0/104']

            // Should block 10.x.x.x
            expect(() => isDeniedIP('10.5.5.5', validList)).toThrow('Access to this host is denied by policy.')

            // Should allow public IPs
            expect(() => isDeniedIP('8.8.8.8', validList)).not.toThrow()
        })

        it('should handle edge case: mask = 96 (exactly at boundary)', () => {
            // Valid: mask = 96, adjustedMask = 96 - 96 = 0 (matches all IPv4)
            const boundaryList = ['::ffff:0.0.0.0/96']

            // Should block all IPv4 (which is valid behavior for /96)
            expect(() => isDeniedIP('8.8.8.8', boundaryList)).toThrow('Access to this host is denied by policy.')
            expect(() => isDeniedIP('1.1.1.1', boundaryList)).toThrow('Access to this host is denied by policy.')
        })

        it('should skip multiple malformed entries', () => {
            // Multiple malformed entries
            const multiMalformedList = [
                '::ffff:10.0.0.0/64', // Malformed
                '::ffff:192.168.0.0/50', // Malformed
                '8.8.8.8' // Valid exact match
            ]

            // Should block exact match
            expect(() => isDeniedIP('8.8.8.8', multiMalformedList)).toThrow('Access to this host is denied by policy.')

            // Should allow other IPs (malformed entries skipped)
            expect(() => isDeniedIP('1.1.1.1', multiMalformedList)).not.toThrow()
            expect(() => isDeniedIP('10.0.0.1', multiMalformedList)).not.toThrow()
        })
    })
})

describe('secureFetch redirect policy', () => {
    const originalSecurityCheck = process.env.HTTP_SECURITY_CHECK
    const mockedFetch = fetch as unknown as jest.Mock
    const policy = {
        enforceDefaultDenyList: true,
        validateUrl(url: URL) {
            if (url.protocol !== 'https:') throw new Error('Provider requests must use HTTPS')
            if (url.origin !== 'https://8.8.8.8') throw new Error('Provider redirect origin is not allowed')
        }
    }

    afterEach(() => {
        mockedFetch.mockReset()
        if (originalSecurityCheck === undefined) delete process.env.HTTP_SECURITY_CHECK
        else process.env.HTTP_SECURITY_CHECK = originalSecurityCheck
    })

    it.each([301, 302, 303, 307, 308])('rejects cross-origin HTTP %s before a second request', async (status) => {
        const destroy = jest.fn()
        mockedFetch.mockResolvedValueOnce({
            status,
            headers: new Headers({ location: 'https://1.1.1.1/redirected' }),
            body: { destroy }
        } as unknown as Response)

        await expect(
            secureFetch(
                'https://8.8.8.8/start',
                { method: 'POST', headers: { Authorization: 'Bearer fixture' }, body: 'fixture-body' },
                5,
                undefined,
                policy
            )
        ).rejects.toThrow(/origin/i)

        expect(mockedFetch).toHaveBeenCalledTimes(1)
        expect(destroy).toHaveBeenCalledTimes(1)
    })

    it.each([301, 302, 303, 307, 308])('rejects HTTPS downgrade on HTTP %s before a second request', async (status) => {
        mockedFetch.mockResolvedValueOnce(new Response('', { status, headers: { location: 'http://8.8.8.8/redirected' } }))

        await expect(
            secureFetch(
                'https://8.8.8.8/start',
                { method: 'POST', headers: { Authorization: 'Bearer fixture' }, body: 'fixture-body' },
                5,
                undefined,
                policy
            )
        ).rejects.toThrow(/HTTPS/i)

        expect(mockedFetch).toHaveBeenCalledTimes(1)
    })

    it.each([301, 302, 303])('changes POST to GET without forwarding its body on same-origin HTTP %s', async (status) => {
        mockedFetch
            .mockResolvedValueOnce(new Response('', { status, headers: { location: '/redirected' } }))
            .mockResolvedValueOnce(new Response('ok', { status: 200 }))

        await expect(
            secureFetch(
                'https://8.8.8.8/start',
                {
                    method: 'POST',
                    headers: {
                        Authorization: 'Bearer fixture',
                        'Content-Length': '12',
                        'Content-Type': 'text/plain',
                        'Transfer-Encoding': 'chunked',
                        'X-Trace': 'same-origin'
                    },
                    body: 'fixture-body'
                },
                5,
                undefined,
                policy
            )
        ).resolves.toHaveProperty('status', 200)

        expect(mockedFetch).toHaveBeenCalledTimes(2)
        const redirectedHeaders = new Headers(mockedFetch.mock.calls[1][1].headers)
        expect(mockedFetch.mock.calls[1][1]).toEqual(expect.objectContaining({ method: 'GET', body: undefined }))
        expect(redirectedHeaders.get('authorization')).toBe('Bearer fixture')
        expect(redirectedHeaders.get('x-trace')).toBe('same-origin')
        expect(redirectedHeaders.get('content-length')).toBeNull()
        expect(redirectedHeaders.get('content-type')).toBeNull()
        expect(redirectedHeaders.get('transfer-encoding')).toBeNull()
    })

    it.each([307, 308])('preserves POST body on same-origin HTTP %s', async (status) => {
        mockedFetch
            .mockResolvedValueOnce(new Response('', { status, headers: { location: '/redirected' } }))
            .mockResolvedValueOnce(new Response('ok', { status: 200 }))

        await secureFetch(
            'https://8.8.8.8/start',
            { method: 'POST', headers: { Authorization: 'Bearer fixture' }, body: 'fixture-body' },
            5,
            undefined,
            policy
        )

        expect(mockedFetch.mock.calls[1][1]).toEqual(
            expect.objectContaining({ method: 'POST', body: 'fixture-body', headers: { Authorization: 'Bearer fixture' } })
        )
    })

    it.each(['https://100.64.0.1/', 'https://203.0.113.1/', 'https://[::]/', 'https://[3fff::1]/', 'https://[64:ff9b::a00:1]/'])(
        'keeps the default deny list for Provider policy when the global switch is off: %s',
        async (url) => {
            process.env.HTTP_SECURITY_CHECK = 'false'

            await expect(
                secureFetch(url, undefined, 5, undefined, { enforceDefaultDenyList: true, validateUrl: () => undefined })
            ).rejects.toThrow(/denied by policy/i)
            expect(mockedFetch).not.toHaveBeenCalled()
        }
    )

    it.each([
        [301, 'PUT'],
        [302, 'PATCH'],
        [303, 'POST'],
        [307, 'POST'],
        [308, 'PATCH']
    ])('fails closed before cross-origin HTTP %s can forward %s credentials or body', async (status, method) => {
        mockedFetch.mockResolvedValueOnce(new Response('', { status, headers: { location: 'https://1.1.1.1/redirected' } }))

        await expect(
            secureFetch('https://8.8.8.8/start', {
                method,
                headers: { Authorization: 'Bearer fixture', Cookie: 'session=fixture' },
                body: 'fixture-body'
            })
        ).rejects.toThrow(/cross-origin redirect/i)

        expect(mockedFetch).toHaveBeenCalledTimes(1)
    })

    const sensitiveHeaderCases: Array<[string, Headers | string[][] | Record<string, string>]> = [
        [
            'Headers',
            new Headers({
                Authorization: 'Bearer fixture',
                'Proxy-Authorization': 'Basic fixture',
                ApiKey: 'api-key-fixture',
                Cookie: 'session=fixture',
                Cookie2: 'legacy=fixture',
                'Set-Cookie': 'server-cookie=fixture',
                Accept: 'application/json',
                'X-Trace': 'keep-me'
            })
        ],
        [
            'array',
            [
                ['Authorization', 'Bearer fixture'],
                ['Proxy-Authorization', 'Basic fixture'],
                ['ApiKey', 'api-key-fixture'],
                ['Cookie', 'session=fixture'],
                ['Cookie2', 'legacy=fixture'],
                ['Set-Cookie', 'server-cookie=fixture'],
                ['Accept', 'application/json'],
                ['X-Trace', 'keep-me']
            ]
        ],
        [
            'object',
            {
                Authorization: 'Bearer fixture',
                'Proxy-Authorization': 'Basic fixture',
                ApiKey: 'api-key-fixture',
                Cookie: 'session=fixture',
                Cookie2: 'legacy=fixture',
                'Set-Cookie': 'server-cookie=fixture',
                Accept: 'application/json',
                'X-Trace': 'keep-me'
            }
        ]
    ]

    it.each(['GET', 'HEAD'])('retains only allowlisted headers on safe cross-origin %s redirects', async (method) => {
        for (const [_label, headers] of sensitiveHeaderCases) {
            mockedFetch
                .mockResolvedValueOnce(new Response('', { status: 307, headers: { location: 'https://1.1.1.1/redirected' } }))
                .mockResolvedValueOnce(new Response('ok', { status: 200 }))

            await secureFetch('https://8.8.8.8/start', { method, headers })

            const redirectedHeaders = new Headers(mockedFetch.mock.calls.at(-1)[1].headers)
            expect(redirectedHeaders.get('authorization')).toBeNull()
            expect(redirectedHeaders.get('proxy-authorization')).toBeNull()
            expect(redirectedHeaders.get('apikey')).toBeNull()
            expect(redirectedHeaders.get('cookie')).toBeNull()
            expect(redirectedHeaders.get('cookie2')).toBeNull()
            expect(redirectedHeaders.get('set-cookie')).toBeNull()
            expect(redirectedHeaders.get('x-trace')).toBeNull()
            expect(redirectedHeaders.get('accept')).toBe('application/json')
        }
    })
})

describe('canonical Flowise request targets', () => {
    const originalAppUrl = process.env.APP_URL

    afterEach(() => {
        if (originalAppUrl === undefined) delete process.env.APP_URL
        else process.env.APP_URL = originalAppUrl
    })

    it('uses APP_URL rather than a request-derived runtime URL when no saved target exists', () => {
        process.env.APP_URL = 'https://8.8.8.8/'

        expect(resolveFlowiseRequestTarget()).toEqual({
            baseUrl: 'https://8.8.8.8',
            canonicalOrigin: 'https://8.8.8.8',
            isCanonicalOrigin: true
        })
    })

    it('classifies an explicitly saved external origin as non-canonical', () => {
        process.env.APP_URL = 'https://8.8.8.8'

        expect(resolveFlowiseRequestTarget('https://1.1.1.1/')).toEqual({
            baseUrl: 'https://1.1.1.1',
            canonicalOrigin: 'https://8.8.8.8',
            isCanonicalOrigin: false
        })
    })

    it.each([
        undefined,
        '',
        'file:///tmp/flowise',
        'ftp://8.8.8.8',
        'https://user:password@8.8.8.8',
        'https://8.8.8.8/subpath',
        'https://8.8.8.8/?query=secret',
        'https://8.8.8.8/#fragment'
    ])('fails closed for an unsafe canonical APP_URL: %s', (appUrl) => {
        if (appUrl === undefined) delete process.env.APP_URL
        else process.env.APP_URL = appUrl

        expect(() => resolveFlowiseRequestTarget()).toThrow('Flowise base URL is not configured securely.')
    })
})

describe('secureAxiosRequest redirect and address policy', () => {
    const mockedAxios = axios as unknown as jest.Mock
    const originalSecurityCheck = process.env.HTTP_SECURITY_CHECK
    const originalDenyList = process.env.HTTP_DENY_LIST

    beforeEach(() => {
        process.env.HTTP_SECURITY_CHECK = 'true'
        process.env.HTTP_DENY_LIST = ''
    })

    afterEach(() => {
        mockedAxios.mockReset()
        jest.restoreAllMocks()
    })

    afterAll(() => {
        if (originalSecurityCheck === undefined) delete process.env.HTTP_SECURITY_CHECK
        else process.env.HTTP_SECURITY_CHECK = originalSecurityCheck
        if (originalDenyList === undefined) delete process.env.HTTP_DENY_LIST
        else process.env.HTTP_DENY_LIST = originalDenyList
    })

    it.each([301, 302, 303, 307, 308])('fails before cross-origin HTTP %s can forward an Axios body or credentials', async (status) => {
        const destroy = jest.fn()
        mockedAxios.mockResolvedValueOnce({
            status,
            headers: { location: 'https://1.1.1.1/redirected' },
            data: { destroy }
        })

        await expect(
            secureAxiosRequest({
                method: 'POST',
                url: 'https://8.8.8.8/start',
                headers: { Authorization: 'Bearer fixture', Cookie: 'session=fixture' },
                data: 'fixture-body'
            })
        ).rejects.toThrow(/cross-origin redirect/i)

        expect(mockedAxios).toHaveBeenCalledTimes(1)
        expect(destroy).toHaveBeenCalledTimes(1)
    })

    it.each([301, 302, 303, 307, 308])('strips Axios credentials from safe cross-origin HTTP %s GET redirects', async (status) => {
        mockedAxios
            .mockResolvedValueOnce({ status, headers: { location: 'https://1.1.1.1/redirected' }, data: '' })
            .mockResolvedValueOnce({ status: 200, headers: {}, data: 'ok' })

        await secureAxiosRequest({
            method: 'GET',
            url: 'https://8.8.8.8/start',
            headers: {
                Authorization: 'Bearer fixture',
                'Proxy-Authorization': 'Basic fixture',
                ApiKey: 'api-key-fixture',
                Cookie: 'session=fixture',
                Accept: 'application/json',
                'X-Vendor-Token': 'vendor-secret',
                'X-Trace': 'keep-me'
            },
            auth: { username: 'fixture-user', password: 'fixture-password' },
            params: { token: 'query-secret' }
        })

        expect(mockedAxios).toHaveBeenCalledTimes(2)
        const redirectedConfig = mockedAxios.mock.calls[1][0]
        const redirectedHeaders = AxiosHeaders.from(redirectedConfig.headers)
        expect(redirectedHeaders.get('authorization')).toBeUndefined()
        expect(redirectedHeaders.get('proxy-authorization')).toBeUndefined()
        expect(redirectedHeaders.get('apikey')).toBeUndefined()
        expect(redirectedHeaders.get('cookie')).toBeUndefined()
        expect(redirectedHeaders.get('x-vendor-token')).toBeUndefined()
        expect(redirectedHeaders.get('x-trace')).toBeUndefined()
        expect(redirectedHeaders.get('accept')).toBe('application/json')
        expect(redirectedConfig.auth).toBeUndefined()
        expect(redirectedConfig.params).toBeUndefined()
        expect(redirectedConfig.proxy).toBe(false)
    })

    it('flattens Axios method header groups and drops their vendor credentials on a cross-origin GET', async () => {
        mockedAxios
            .mockResolvedValueOnce({ status: 302, headers: { location: 'https://1.1.1.1/redirected' }, data: '' })
            .mockResolvedValueOnce({ status: 200, headers: {}, data: 'ok' })

        await secureAxiosRequest({
            method: 'GET',
            url: 'https://8.8.8.8/start',
            headers: {
                common: { Authorization: 'Bearer fixture' },
                get: { 'X-Vendor-Token': 'vendor-secret' },
                Accept: 'application/json'
            } as never
        })

        const initialHeaders = AxiosHeaders.from(mockedAxios.mock.calls[0][0].headers)
        const redirectedHeaders = AxiosHeaders.from(mockedAxios.mock.calls[1][0].headers)
        expect(initialHeaders.get('authorization')).toBe('Bearer fixture')
        expect(initialHeaders.get('x-vendor-token')).toBe('vendor-secret')
        expect(redirectedHeaders.get('authorization')).toBeUndefined()
        expect(redirectedHeaders.get('x-vendor-token')).toBeUndefined()
        expect(redirectedHeaders.get('accept')).toBe('application/json')
    })

    it.each([301, 302, 303])('rewrites same-origin Axios POST HTTP %s to GET without entity headers', async (status) => {
        mockedAxios
            .mockResolvedValueOnce({ status, headers: { location: '/redirected' }, data: '' })
            .mockResolvedValueOnce({ status: 200, headers: {}, data: 'ok' })

        await secureAxiosRequest({
            method: 'POST',
            url: 'https://8.8.8.8/start',
            headers: {
                Authorization: 'Bearer fixture',
                'Content-Length': '12',
                'Content-Type': 'text/plain',
                'X-Trace': 'same-origin'
            },
            data: 'fixture-body'
        })

        const redirectedConfig = mockedAxios.mock.calls[1][0]
        const redirectedHeaders = AxiosHeaders.from(redirectedConfig.headers)
        expect(redirectedConfig).toEqual(expect.objectContaining({ method: 'GET', data: undefined }))
        expect(redirectedHeaders.get('authorization')).toBe('Bearer fixture')
        expect(redirectedHeaders.get('content-length')).toBeUndefined()
        expect(redirectedHeaders.get('content-type')).toBeUndefined()
        expect(redirectedHeaders.get('x-trace')).toBe('same-origin')
    })

    it.each([307, 308])('preserves same-origin Axios POST body on HTTP %s', async (status) => {
        mockedAxios
            .mockResolvedValueOnce({ status, headers: { location: '/redirected' }, data: '' })
            .mockResolvedValueOnce({ status: 200, headers: {}, data: 'ok' })

        await secureAxiosRequest({
            method: 'POST',
            url: 'https://8.8.8.8/start',
            headers: { Authorization: 'Bearer fixture' },
            data: 'fixture-body'
        })

        const redirectedConfig = mockedAxios.mock.calls[1][0]
        expect(redirectedConfig.method).toBe('POST')
        expect(redirectedConfig.data).toBe('fixture-body')
        expect(AxiosHeaders.from(redirectedConfig.headers).get('authorization')).toBe('Bearer fixture')
    })

    it('blocks DNS rebinding to link-local space before the redirected request', async () => {
        jest.spyOn(dns, 'lookup')
            .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }] as never)
            .mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }] as never)
        mockedAxios.mockResolvedValueOnce({ status: 307, headers: { location: '/redirected' }, data: '' })

        await expect(secureAxiosRequest({ method: 'GET', url: 'https://rebind.fixture.invalid/start' })).rejects.toThrow(
            /denied by policy/i
        )

        expect(mockedAxios).toHaveBeenCalledTimes(1)
        expect(dns.lookup).toHaveBeenCalledTimes(2)
    })

    it.each(['http://127.0.0.1', 'http://169.254.169.254', 'http://10.0.0.1', 'http://172.16.0.1', 'http://192.168.0.1'])(
        'enforces global reachability for a fixed internal target even when the global switch is off: %s',
        async (baseUrl) => {
            process.env.HTTP_SECURITY_CHECK = 'false'

            await expect(
                secureAxiosRequest(
                    { method: 'POST', url: `${baseUrl}/api/v1/prediction/fixture` },
                    5,
                    undefined,
                    createFixedOriginPolicy(baseUrl)
                )
            ).rejects.toThrow(/denied by policy/i)
            expect(mockedAxios).not.toHaveBeenCalled()
        }
    )

    it.each(['file:///tmp/fixture', 'ftp://8.8.8.8/fixture', 'https://user:password@8.8.8.8/fixture'])(
        'rejects a non-HTTP or credential-bearing Axios target before transport: %s',
        async (url) => {
            await expect(secureAxiosRequest({ method: 'GET', url })).rejects.toThrow('Request target is denied by policy.')
            expect(mockedAxios).not.toHaveBeenCalled()
        }
    )

    it('keeps a fixed-origin policy from following even a credential-free cross-origin GET', async () => {
        mockedAxios.mockResolvedValueOnce({
            status: 302,
            headers: { location: 'https://1.1.1.1/redirected' },
            data: ''
        })

        await expect(
            secureAxiosRequest({ method: 'GET', url: 'https://8.8.8.8/start' }, 5, undefined, createFixedOriginPolicy('https://8.8.8.8'))
        ).rejects.toThrow('Request target is denied by policy.')
        expect(mockedAxios).toHaveBeenCalledTimes(1)
    })
})

describe('default global-reachability policy', () => {
    const originalSecurityCheck = process.env.HTTP_SECURITY_CHECK
    const originalDenyList = process.env.HTTP_DENY_LIST
    const mockedFetch = fetch as unknown as jest.Mock

    beforeEach(() => {
        process.env.HTTP_SECURITY_CHECK = 'true'
        process.env.HTTP_DENY_LIST = ''
    })

    afterEach(() => {
        mockedFetch.mockReset()
        jest.restoreAllMocks()
    })

    afterAll(() => {
        if (originalSecurityCheck === undefined) delete process.env.HTTP_SECURITY_CHECK
        else process.env.HTTP_SECURITY_CHECK = originalSecurityCheck
        if (originalDenyList === undefined) delete process.env.HTTP_DENY_LIST
        else process.env.HTTP_DENY_LIST = originalDenyList
    })

    it.each([
        'https://0.1.2.3/',
        'https://192.0.0.8/',
        'https://192.0.2.1/',
        'https://198.18.0.1/',
        'https://198.51.100.1/',
        'https://203.0.113.1/',
        'https://192.88.99.2/',
        'https://[100::1]/',
        'https://[100:0:0:1::1]/',
        'https://[2001:2::1]/',
        'https://[2001:db8::1]/',
        'https://[3ffe::1]/',
        'https://[3fff::1]/',
        'https://[4000::1]/',
        'https://[5f00::1]/',
        'https://[fec0::1]/',
        'https://[64:ff9b:1::808:808]/',
        'https://[64:ff9b::a00:1]/'
    ])('rejects a literal address that is not globally reachable: %s', async (url) => {
        await expect(checkDenyList(url)).rejects.toThrow(/denied by policy/i)
    })

    it.each([
        'https://8.8.8.8/',
        'https://192.0.0.9/',
        'https://192.0.0.10/',
        'https://[2001:1::3]/',
        'https://[2001:20::1]/',
        'https://[2606:4700:4700::1111]/',
        'https://[64:ff9b::808:808]/'
    ])('allows a globally reachable literal address: %s', async (url) => {
        await expect(checkDenyList(url)).resolves.toBeUndefined()
    })

    it('rejects a hostname when mocked DNS resolves to special-use space', async () => {
        jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '198.51.100.40', family: 4 }] as never)

        await expect(checkDenyList('https://special.fixture.invalid/')).rejects.toThrow(/denied by policy/i)
    })

    it.each(['4000::1', 'fec0::1'])('rejects a hostname when mocked DNS returns reserved IPv6 %s', async (address) => {
        jest.spyOn(dns, 'lookup').mockResolvedValue([{ address, family: 6 }] as never)

        await expect(checkDenyList('https://reserved-v6.fixture.invalid/')).rejects.toThrow(/denied by policy/i)
    })

    it('allows public IPv4 and IPv6 answers from mocked DNS', async () => {
        jest.spyOn(dns, 'lookup').mockResolvedValue([
            { address: '8.8.8.8', family: 4 },
            { address: '2606:4700:4700::1111', family: 6 }
        ] as never)

        await expect(checkDenyList('https://public.fixture.invalid/')).resolves.toBeUndefined()
    })

    it('blocks a public-to-special redirect before the second request', async () => {
        mockedFetch.mockResolvedValueOnce(
            new Response('', { status: 302, headers: { location: 'https://special.fixture.invalid/redirected' } })
        )
        jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '203.0.113.50', family: 4 }] as never)

        await expect(secureFetch('https://8.8.8.8/start')).rejects.toThrow(/denied by policy/i)
        expect(mockedFetch).toHaveBeenCalledTimes(1)
    })

    it('preserves custom-list-only semantics when global checks and request enforcement are disabled', async () => {
        process.env.HTTP_SECURITY_CHECK = 'false'
        process.env.HTTP_DENY_LIST = '10.0.0.40'

        await expect(checkDenyList('https://10.0.0.41/')).resolves.toBeUndefined()
        await expect(checkDenyList('https://10.0.0.40/')).rejects.toThrow(/denied by policy/i)
    })

    it('denies a custom hostname case-insensitively with trailing-dot normalization without echoing it', async () => {
        process.env.HTTP_SECURITY_CHECK = 'false'
        process.env.HTTP_DENY_LIST = 'LoCaLhOsT.'
        jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never)

        const errorText = await checkDenyList('http://LOCALHOST/').then(
            () => '',
            (error) => String(error)
        )

        expect(errorText).toMatch(/denied by policy/i)
        expect(errorText.toLowerCase()).not.toContain('localhost')
    })

    it('blocks secureFetch on a custom canonical hostname before DNS or fetch', async () => {
        process.env.HTTP_SECURITY_CHECK = 'false'
        process.env.HTTP_DENY_LIST = 'LOCALHOST'
        const lookup = jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '127.0.0.1', family: 4 }] as never)

        await expect(secureFetch('http://localhost./')).rejects.toThrow(/denied by policy/i)
        expect(lookup).not.toHaveBeenCalled()
        expect(mockedFetch).not.toHaveBeenCalled()
    })

    it('allows a non-matching custom hostname when mocked DNS is globally reachable', async () => {
        process.env.HTTP_SECURITY_CHECK = 'false'
        process.env.HTTP_DENY_LIST = 'blocked.fixture.invalid.'
        jest.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never)

        await expect(checkDenyList('https://ALLOWED.fixture.invalid./')).resolves.toBeUndefined()
    })

    it.each(['8.8.8.8', '8.8.8.0/24'])('applies custom IPv4 deny entry %s to NAT64 embedded IPv4', async (denyEntry) => {
        process.env.HTTP_SECURITY_CHECK = 'false'
        process.env.HTTP_DENY_LIST = denyEntry

        await expect(checkDenyList('https://[64:ff9b::808:808]/')).rejects.toThrow(/denied by policy/i)
    })

    it('allows NAT64 when the custom IPv4 deny list does not match its embedded address', async () => {
        process.env.HTTP_SECURITY_CHECK = 'false'
        process.env.HTTP_DENY_LIST = '9.9.9.0/24'

        await expect(checkDenyList('https://[64:ff9b::808:808]/')).resolves.toBeUndefined()
    })
})

describe('secure HTTP resource bounds', () => {
    const mockedFetch = fetch as unknown as jest.Mock
    const mockedAxios = axios as unknown as jest.Mock
    const originalSecurityCheck = process.env.HTTP_SECURITY_CHECK
    const originalDenyList = process.env.HTTP_DENY_LIST

    const createLimitPolicy = (limits: { timeoutMs?: number; maxRequestBytes?: number; maxResponseBytes?: number } = {}) =>
        createFixedOriginPolicy(
            'https://8.8.8.8',
            createTrustedSecureRequestResourceLimits({
                timeoutMs: limits.timeoutMs ?? 1000,
                maxRequestBytes: limits.maxRequestBytes ?? 1024,
                maxResponseBytes: limits.maxResponseBytes ?? 1024
            })
        )

    beforeEach(() => {
        process.env.HTTP_SECURITY_CHECK = 'false'
        process.env.HTTP_DENY_LIST = ''
        mockedFetch.mockReset()
        mockedAxios.mockReset()
    })

    afterEach(() => {
        jest.restoreAllMocks()
        if (originalSecurityCheck === undefined) delete process.env.HTTP_SECURITY_CHECK
        else process.env.HTTP_SECURITY_CHECK = originalSecurityCheck
        if (originalDenyList === undefined) delete process.env.HTTP_DENY_LIST
        else process.env.HTTP_DENY_LIST = originalDenyList
    })

    it('applies conservative defaults when Axios and fetch callers try to disable limits', async () => {
        mockedAxios.mockResolvedValueOnce({ status: 200, headers: {}, data: 'ok' })
        mockedFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }))

        await secureAxiosRequest({
            method: 'GET',
            url: 'https://8.8.8.8/axios',
            timeout: 0,
            maxBodyLength: -1,
            maxContentLength: Number.POSITIVE_INFINITY
        })
        const fetchResponse = await secureFetch('https://8.8.8.8/fetch', {
            timeout: 0,
            size: 0,
            maxBodyLength: -1
        })
        await expect(fetchResponse.text()).resolves.toBe('ok')

        expect(mockedAxios.mock.calls[0][0]).toEqual(
            expect.objectContaining({
                timeout: 10 * 60 * 1000,
                maxBodyLength: 32 * 1024 * 1024,
                maxContentLength: 32 * 1024 * 1024,
                signal: expect.any(Object)
            })
        )
        expect(mockedFetch.mock.calls[0][1]).toEqual(
            expect.objectContaining({
                timeout: 10 * 60 * 1000,
                size: 32 * 1024 * 1024,
                signal: expect.any(Object)
            })
        )
    })

    it.each(['config spread', 'header normalization'])(
        'redacts %s Proxy failures and removes caller abort listeners',
        async (failurePoint) => {
            const sentinel = `SENTINEL_${failurePoint.replace(' ', '_').toUpperCase()}`
            const listeners = new Set<() => void>()
            const signal = {
                aborted: false,
                addEventListener: (_type: 'abort', listener: () => void) => listeners.add(listener),
                removeEventListener: (_type: 'abort', listener: () => void) => listeners.delete(listener)
            }
            const baseConfig: Record<string, unknown> = {
                method: 'GET',
                url: 'https://8.8.8.8/proxy-failure',
                signal,
                ...(failurePoint === 'header normalization'
                    ? {
                          headers: new Proxy(
                              {},
                              {
                                  ownKeys: () => {
                                      throw new Error(sentinel)
                                  }
                              }
                          )
                      }
                    : {})
            }
            const config =
                failurePoint === 'config spread'
                    ? new Proxy(baseConfig, {
                          ownKeys: () => {
                              throw new Error(sentinel)
                          }
                      })
                    : baseConfig

            const errorText = await secureAxiosRequest(config as never).then(
                () => '',
                (error) => String(error)
            )

            expect(errorText).toBe('Error: Secure HTTP request failed.')
            expect(errorText).not.toContain(sentinel)
            expect(listeners.size).toBe(0)
            expect(mockedAxios).not.toHaveBeenCalled()
        }
    )

    it('allows only a branded, hard-capped policy to relax defaults while request config can still tighten it', async () => {
        mockedFetch
            .mockResolvedValueOnce(new Response('relaxed', { status: 200 }))
            .mockResolvedValueOnce(new Response('tightened', { status: 200 }))
        const policy = createFixedOriginPolicy(
            'https://8.8.8.8',
            createTrustedSecureRequestResourceLimits({
                timeoutMs: 15 * 60 * 1000,
                maxRequestBytes: 64 * 1024 * 1024,
                maxResponseBytes: 64 * 1024 * 1024
            })
        )
        const relaxedResponse = await secureFetch('https://8.8.8.8/relaxed', undefined, 5, undefined, policy)
        await expect(relaxedResponse.text()).resolves.toBe('relaxed')
        const tightenedResponse = await secureFetch(
            'https://8.8.8.8/fetch',
            { timeout: 5000, size: 1024, maxBodyLength: 2048 },
            5,
            undefined,
            policy
        )
        await expect(tightenedResponse.text()).resolves.toBe('tightened')

        expect(mockedFetch.mock.calls[0][1]).toEqual(
            expect.objectContaining({ timeout: 15 * 60 * 1000, size: 64 * 1024 * 1024, signal: expect.any(Object) })
        )
        expect(mockedFetch.mock.calls[1][1]).toEqual(expect.objectContaining({ timeout: 5000, size: 1024, signal: expect.any(Object) }))
    })

    it('rejects static request bodies before transport when a caller-scoped cap is exceeded', async () => {
        const policy = createLimitPolicy({ maxRequestBytes: 8 })

        await expect(secureFetch('https://8.8.8.8/fetch', { method: 'POST', body: '123456789' }, 5, undefined, policy)).rejects.toThrow(
            'HTTP request exceeded a configured resource limit.'
        )
        await expect(
            secureAxiosRequest({ method: 'POST', url: 'https://8.8.8.8/axios', data: '123456789' }, 5, undefined, policy)
        ).rejects.toThrow('HTTP request exceeded a configured resource limit.')

        expect(mockedFetch).not.toHaveBeenCalled()
        expect(mockedAxios).not.toHaveBeenCalled()
    })

    it.each([307, 308])('counts a fetch body again on same-origin HTTP %s replay', async (status) => {
        mockedFetch.mockResolvedValueOnce(new Response('', { status, headers: { location: '/next' } }))
        const policy = createLimitPolicy({ maxRequestBytes: 20 })

        await expect(secureFetch('https://8.8.8.8/start', { method: 'POST', body: 'fixture-body' }, 5, undefined, policy)).rejects.toThrow(
            'HTTP request exceeded a configured resource limit.'
        )

        expect(mockedFetch).toHaveBeenCalledTimes(1)
    })

    it.each([307, 308])('counts an Axios body again on same-origin HTTP %s replay', async (status) => {
        mockedAxios.mockResolvedValueOnce({ status, headers: { location: '/next' }, data: '' })
        const policy = createLimitPolicy({ maxRequestBytes: 20 })

        await expect(
            secureAxiosRequest({ method: 'POST', url: 'https://8.8.8.8/start', data: 'fixture-body' }, 5, undefined, policy)
        ).rejects.toThrow('HTTP request exceeded a configured resource limit.')

        expect(mockedAxios).toHaveBeenCalledTimes(1)
    })

    it('denies an Axios body-preserving redirect when a custom transform makes replay size unknowable', async () => {
        mockedAxios.mockResolvedValueOnce({ status: 307, headers: { location: '/next' }, data: '' })

        await expect(
            secureAxiosRequest(
                {
                    method: 'POST',
                    url: 'https://8.8.8.8/start',
                    data: 'fixture-body',
                    transformRequest: () => 'x'.repeat(1024)
                },
                5,
                undefined,
                createLimitPolicy({ maxRequestBytes: 20 })
            )
        ).rejects.toThrow('HTTP request exceeded a configured resource limit.')
        expect(mockedAxios).toHaveBeenCalledTimes(1)
    })

    it('counts a streaming fetch request instead of trusting caller length metadata', async () => {
        mockedFetch.mockImplementationOnce(async (_url, init) => {
            for await (const _chunk of init.body as Readable) {
                // Consume the raw body to exercise the transport-facing counter.
            }
            return new Response('ok', { status: 200 })
        })
        const policy = createLimitPolicy({ maxRequestBytes: 8 })

        await expect(
            secureFetch('https://8.8.8.8/upload', { method: 'POST', body: Readable.from(['12345', '6789']) }, 5, undefined, policy)
        ).rejects.toThrow('HTTP request exceeded a configured resource limit.')
    })

    it('fails closed with a fixed error for a non-stream FormData implementation unsupported by node-fetch v2', async () => {
        const sentinel = 'SENTINEL_FORM_VALUE'
        const body = new globalThis.FormData()
        body.set('field', sentinel)

        const errorText = await secureFetch(
            'https://8.8.8.8/upload',
            { method: 'POST', body: body as never },
            5,
            undefined,
            createLimitPolicy()
        ).then(
            () => '',
            (error) => String(error)
        )

        expect(errorText).toBe('Error: HTTP request exceeded a configured resource limit.')
        expect(errorText).not.toContain(sentinel)
        expect(mockedFetch).not.toHaveBeenCalled()
    })

    it('enforces the response cap for raw stream consumers, not only Body helper methods', async () => {
        mockedFetch.mockResolvedValueOnce(new Response(Readable.from([Buffer.alloc(5), Buffer.alloc(5)]), { status: 200 }))
        const response = await secureFetch('https://8.8.8.8/stream', undefined, 5, undefined, createLimitPolicy({ maxResponseBytes: 8 }))

        const consumeRawBody = async () => {
            for await (const _chunk of response.body as Readable) {
                // Raw stream consumption must cross the same byte counter.
            }
        }

        await expect(consumeRawBody()).rejects.toThrow('HTTP request exceeded a configured resource limit.')
    })

    it('denies cloning a streaming response before node-fetch can create unbounded tee branches', async () => {
        const source = Readable.from(['bounded-response'])
        mockedFetch.mockResolvedValueOnce(new Response(source, { status: 200 }))
        const response = await secureFetch('https://8.8.8.8/stream', undefined, 5, undefined, createLimitPolicy())

        for (let index = 0; index < 32; index++) {
            expect(() => response.clone()).toThrow('HTTP request exceeded a configured resource limit.')
        }
        expect(source.readableFlowing).not.toBe(true)
        await expect(response.text()).resolves.toBe('bounded-response')
    })

    it('enforces the response cap for raw Axios stream consumers', async () => {
        mockedAxios.mockResolvedValueOnce({ status: 200, headers: {}, data: Readable.from([Buffer.alloc(5), Buffer.alloc(5)]) })
        const response = await secureAxiosRequest(
            { method: 'GET', url: 'https://8.8.8.8/stream', responseType: 'stream' },
            5,
            undefined,
            createLimitPolicy({ maxResponseBytes: 8 })
        )

        const consumeRawBody = async () => {
            for await (const _chunk of response.data as Readable) {
                // Axios streams must cross the same counter as fetch streams.
            }
        }

        await expect(consumeRawBody()).rejects.toThrow('HTTP request exceeded a configured resource limit.')
    })

    it('accounts buffered Axios redirect bodies against the total response budget', async () => {
        mockedAxios
            .mockResolvedValueOnce({ status: 302, headers: { location: '/next' }, data: '12345678' })
            .mockResolvedValueOnce({ status: 200, headers: {}, data: '12345678' })

        await expect(
            secureAxiosRequest({ method: 'GET', url: 'https://8.8.8.8/start' }, 5, undefined, createLimitPolicy({ maxResponseBytes: 12 }))
        ).rejects.toThrow('HTTP request exceeded a configured resource limit.')
        expect(mockedAxios).toHaveBeenCalledTimes(2)
    })

    it('ignores a misleading Content-Length and counts raw Axios bytes before a compacting transform', async () => {
        const sentinel = 'SENTINEL_RAW_RESPONSE'
        const rawResponse = sentinel.padEnd(887, 'x')
        const runHop = (status: number, headers: Record<string, string>) => async (config: Record<string, any>) => {
            let data: unknown = rawResponse
            const transforms = Array.isArray(config.transformResponse) ? config.transformResponse : [config.transformResponse]
            for (const transform of transforms) data = transform.call(config, data, headers, status)
            return { status, headers, data, config }
        }
        mockedAxios
            .mockImplementationOnce(runHop(302, { location: '/next', 'content-length': '1' }))
            .mockImplementationOnce(runHop(200, { 'content-length': '1' }))

        const errorText = await secureAxiosRequest(
            {
                method: 'GET',
                url: 'https://8.8.8.8/start',
                transformResponse: () => ({ x: 1 })
            },
            5,
            undefined,
            createLimitPolicy({ maxResponseBytes: 1024 })
        ).then(
            () => '',
            (error) => String(error)
        )

        expect(errorText).toBe('Error: HTTP request exceeded a configured resource limit.')
        expect(errorText).not.toContain(sentinel)
        expect(mockedAxios).toHaveBeenCalledTimes(2)
        expect(mockedAxios.mock.calls[1][0].maxContentLength).toBe(137)
    })

    it('accounts buffered fetch redirect bodies against the total response budget', async () => {
        mockedFetch
            .mockResolvedValueOnce(new Response('12345678', { status: 302, headers: { location: '/next' } }))
            .mockResolvedValueOnce(new Response('12345678', { status: 200 }))

        await expect(
            secureFetch('https://8.8.8.8/start', undefined, 5, undefined, createLimitPolicy({ maxResponseBytes: 12 }))
        ).rejects.toThrow('HTTP request exceeded a configured resource limit.')
        expect(mockedFetch).toHaveBeenCalledTimes(2)
    })

    it('rejects and destroys a declared-oversize streaming redirect body before the next hop', async () => {
        const source = new PassThrough()
        mockedFetch.mockResolvedValueOnce(new Response(source, { status: 307, headers: { location: '/next', 'content-length': '9' } }))

        await expect(
            secureFetch('https://8.8.8.8/start', undefined, 5, undefined, createLimitPolicy({ maxResponseBytes: 8 }))
        ).rejects.toThrow('HTTP request exceeded a configured resource limit.')
        expect(mockedFetch).toHaveBeenCalledTimes(1)
        expect(source.destroyed).toBe(true)
    })

    it('destroys a declared-oversize Axios redirect stream before returning the fixed error', async () => {
        const source = new PassThrough()
        mockedAxios.mockResolvedValueOnce({
            status: 307,
            headers: { location: '/next', 'content-length': '9' },
            data: source
        })

        await expect(
            secureAxiosRequest(
                { method: 'GET', url: 'https://8.8.8.8/start', responseType: 'stream' },
                5,
                undefined,
                createLimitPolicy({ maxResponseBytes: 8 })
            )
        ).rejects.toThrow('HTTP request exceeded a configured resource limit.')
        expect(mockedAxios).toHaveBeenCalledTimes(1)
        expect(source.destroyed).toBe(true)
    })

    it('maps a secret-bearing raw response stream failure to a fixed error', async () => {
        const sentinel = 'SENTINEL_REMOTE_STREAM_ERROR'
        const source = new Readable({
            read() {
                this.destroy(new Error(`https://secret.invalid/${sentinel}`))
            }
        })
        mockedFetch.mockResolvedValueOnce(new Response(source, { status: 200 }))
        const response = await secureFetch('https://8.8.8.8/stream', undefined, 5, undefined, createLimitPolicy())

        const errorText = await response.text().then(
            () => '',
            (error) => String(error)
        )

        expect(errorText).toBe('Error: Secure HTTP request failed.')
        expect(errorText).not.toContain(sentinel)
        expect(errorText).not.toContain('secret.invalid')
    })

    it('destroys an unconsumed raw response at the total deadline without an uncaught error', async () => {
        const source = new PassThrough()
        mockedFetch.mockResolvedValueOnce(new Response(source, { status: 200 }))
        const sourceListenerBaseline = source.listenerCount('error')
        const callerAbortListeners = new Set<() => void>()
        const callerSignal = {
            aborted: false,
            addEventListener: (_type: 'abort', listener: () => void) => callerAbortListeners.add(listener),
            removeEventListener: (_type: 'abort', listener: () => void) => callerAbortListeners.delete(listener)
        }
        const response = await secureFetch(
            'https://8.8.8.8/stream',
            { signal: callerSignal as never },
            5,
            undefined,
            createLimitPolicy({ timeoutMs: 20 })
        )

        expect(callerAbortListeners.size).toBe(1)
        expect(source.listenerCount('error')).toBe(sourceListenerBaseline + 1)

        await new Promise((resolve) => setTimeout(resolve, 50))
        expect(source.destroyed).toBe(true)
        expect(callerAbortListeners.size).toBe(0)
        expect(source.listenerCount('error')).toBe(sourceListenerBaseline)
        await expect(response.text()).rejects.toThrow('HTTP request exceeded a configured resource limit.')
    })

    it('applies the same total deadline while DNS resolution is pending', async () => {
        jest.spyOn(dns, 'lookup').mockImplementation(() => new Promise(() => undefined) as never)
        const policy = createFixedOriginPolicy(
            'https://dns-timeout.fixture.invalid',
            createTrustedSecureRequestResourceLimits({ timeoutMs: 20, maxRequestBytes: 1024, maxResponseBytes: 1024 })
        )

        await expect(secureFetch('https://dns-timeout.fixture.invalid/path', undefined, 5, undefined, policy)).rejects.toThrow(
            'HTTP request exceeded a configured resource limit.'
        )
        expect(mockedFetch).not.toHaveBeenCalled()
    })

    it('redacts URL and body data from transport errors and hard-caps trusted relaxations', async () => {
        const sentinel = 'SENTINEL_TRANSPORT_SECRET'
        mockedFetch.mockRejectedValueOnce(new Error(`https://secret.invalid/${sentinel}`))

        const errorText = await secureFetch('https://8.8.8.8/path', undefined, 5, undefined, createLimitPolicy()).then(
            () => '',
            (error) => String(error)
        )
        expect(errorText).toBe('Error: Secure HTTP request failed.')
        expect(errorText).not.toContain(sentinel)
        expect(errorText).not.toContain('secret.invalid')

        expect(() =>
            createTrustedSecureRequestResourceLimits({
                timeoutMs: 30 * 60 * 1000 + 1,
                maxRequestBytes: 32 * 1024 * 1024,
                maxResponseBytes: 32 * 1024 * 1024
            })
        ).toThrow('HTTP request exceeded a configured resource limit.')
    })
})

describe('secureFetch pinned lookup integration', () => {
    const originalSecurityCheck = process.env.HTTP_SECURITY_CHECK
    const originalDenyList = process.env.HTTP_DENY_LIST
    let server: http.Server
    let port: number
    let transformedRequestHits = 0
    let transformedResponseHits = 0
    let utf16ResponseHits = 0

    beforeAll(async () => {
        server = http.createServer((request, response) => {
            if (request.url === '/transformed-request-start' || request.url === '/transformed-request-next') {
                transformedRequestHits += 1
                request.resume()
                request.once('end', () => {
                    if (request.url === '/transformed-request-start') {
                        response.writeHead(307, { location: '/transformed-request-next' })
                        response.end()
                    } else {
                        response.writeHead(200, { 'content-type': 'text/plain' })
                        response.end('unexpected replay')
                    }
                })
                return
            }

            if (request.url === '/transformed-response-start' || request.url === '/transformed-response-next') {
                transformedResponseHits += 1
                const payload = 'x'.repeat(887)
                response.writeHead(request.url === '/transformed-response-start' ? 302 : 200, {
                    ...(request.url === '/transformed-response-start' ? { location: '/transformed-response-next' } : {}),
                    'content-type': 'application/octet-stream',
                    'transfer-encoding': 'chunked'
                })
                response.write(payload.slice(0, 443))
                response.end(payload.slice(443))
                return
            }

            if (request.url === '/utf16-response-start' || request.url === '/utf16-response-next') {
                utf16ResponseHits += 1
                const payload = Buffer.from(request.url === '/utf16-response-start' ? 'a'.repeat(300) : 'b'.repeat(350), 'utf16le')
                response.writeHead(request.url === '/utf16-response-start' ? 302 : 200, {
                    ...(request.url === '/utf16-response-start' ? { location: '/utf16-response-next' } : {}),
                    'content-type': 'text/plain',
                    'transfer-encoding': 'chunked'
                })
                response.write(payload.subarray(0, payload.length / 2))
                response.end(payload.subarray(payload.length / 2))
                return
            }

            if (request.url?.startsWith('/response-semantics/')) {
                const fixture = request.url.slice('/response-semantics/'.length)
                const bodies: Record<string, Buffer> = {
                    arraybuffer: Buffer.from([0, 1, 2, 255]),
                    default: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('default-text')]),
                    empty: Buffer.alloc(0),
                    json: Buffer.from(JSON.stringify({ ok: true })),
                    text: Buffer.from('中文文本', 'utf16le')
                }
                const body = bodies[fixture]
                if (body) {
                    response.writeHead(200, { 'content-type': fixture === 'json' ? 'application/json' : 'text/plain' })
                    response.end(body)
                    return
                }
            }

            response.writeHead(200, { 'content-type': 'text/plain' })
            response.end('local fixture')
        })
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject)
            server.listen(0, '127.0.0.1', () => resolve())
        })
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('local fixture did not bind a TCP port')
        port = address.port
    })

    beforeEach(() => {
        transformedRequestHits = 0
        transformedResponseHits = 0
        utf16ResponseHits = 0
    })

    afterAll(async () => {
        await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()))
        })
        if (originalSecurityCheck === undefined) delete process.env.HTTP_SECURITY_CHECK
        else process.env.HTTP_SECURITY_CHECK = originalSecurityCheck
        if (originalDenyList === undefined) delete process.env.HTTP_DENY_LIST
        else process.env.HTTP_DENY_LIST = originalDenyList
    })

    it('supports Node 24 all-address lookup while preserving the pinned IP', async () => {
        expect(process.versions.node).toMatch(/^24\./)
        process.env.HTTP_SECURITY_CHECK = 'false'
        process.env.HTTP_DENY_LIST = ''

        let actualSecureFetch!: typeof secureFetch
        jest.dontMock('node-fetch')
        jest.isolateModules(() => {
            actualSecureFetch = require('./httpSecurity').secureFetch
        })

        const response = await actualSecureFetch(`http://localhost:${port}/fixture`)

        await expect(response.text()).resolves.toBe('local fixture')
    })

    it('pins Axios to the validated address and bypasses ambient proxy configuration', async () => {
        expect(process.versions.node).toMatch(/^24\./)
        process.env.HTTP_SECURITY_CHECK = 'false'
        process.env.HTTP_DENY_LIST = ''

        let actualSecureAxiosRequest!: typeof secureAxiosRequest
        jest.dontMock('axios')
        jest.isolateModules(() => {
            actualSecureAxiosRequest = require('./httpSecurity').secureAxiosRequest
        })

        const injectedLookup = jest.fn((_hostname, _options, callback) => callback(null, '127.0.0.1', 4))
        const injectedCreateConnection = jest.fn(() => {
            throw new Error('caller-controlled createConnection must not run')
        })
        const response = await actualSecureAxiosRequest({ method: 'GET', url: `http://localhost:${port}/fixture` }, 5, {
            lookup: injectedLookup,
            createConnection: injectedCreateConnection
        } as any)

        expect(response.status).toBe(200)
        expect(response.data).toBe('local fixture')
        expect(response.config.proxy).toBe(false)
        expect(injectedLookup).not.toHaveBeenCalled()
        expect(injectedCreateConnection).not.toHaveBeenCalled()
    })

    it('counts a body synthesized by transformRequest on every 307 replay hop', async () => {
        expect(process.versions.node).toMatch(/^24\./)
        process.env.HTTP_SECURITY_CHECK = 'false'
        process.env.HTTP_DENY_LIST = ''

        let actualHttpSecurity!: typeof import('./httpSecurity')
        jest.dontMock('axios')
        jest.isolateModules(() => {
            actualHttpSecurity = require('./httpSecurity')
        })
        const policy = {
            trustedResourceLimits: actualHttpSecurity.createTrustedSecureRequestResourceLimits({
                timeoutMs: 1000,
                maxRequestBytes: 1024,
                maxResponseBytes: 1024
            })
        }

        const errorText = await actualHttpSecurity
            .secureAxiosRequest(
                {
                    method: 'POST',
                    url: `http://localhost:${port}/transformed-request-start`,
                    transformRequest: () => 'r'.repeat(887)
                },
                5,
                undefined,
                policy
            )
            .then(
                () => '',
                (error) => String(error)
            )

        expect(errorText).toBe('Error: HTTP request exceeded a configured resource limit.')
        expect(errorText).not.toContain('transformed-request')
        expect(transformedRequestHits).toBe(1)
    })

    it('counts raw decompressed response bytes before transformResponse on every redirect hop', async () => {
        expect(process.versions.node).toMatch(/^24\./)
        process.env.HTTP_SECURITY_CHECK = 'false'
        process.env.HTTP_DENY_LIST = ''

        let actualHttpSecurity!: typeof import('./httpSecurity')
        jest.dontMock('axios')
        jest.isolateModules(() => {
            actualHttpSecurity = require('./httpSecurity')
        })
        const policy = {
            trustedResourceLimits: actualHttpSecurity.createTrustedSecureRequestResourceLimits({
                timeoutMs: 1000,
                maxRequestBytes: 1024,
                maxResponseBytes: 1024
            })
        }

        const errorText = await actualHttpSecurity
            .secureAxiosRequest(
                {
                    method: 'GET',
                    url: `http://localhost:${port}/transformed-response-start`,
                    transformResponse: () => ({ x: 1 })
                },
                5,
                undefined,
                policy
            )
            .then(
                () => '',
                (error) => String(error)
            )

        expect(errorText).toBe('Error: HTTP request exceeded a configured resource limit.')
        expect(errorText).not.toContain('transformed-response')
        expect(transformedResponseHits).toBe(2)
    })

    it('counts utf16le responses by raw decompressed bytes before caller transforms', async () => {
        expect(process.versions.node).toMatch(/^24\./)
        process.env.HTTP_SECURITY_CHECK = 'false'
        process.env.HTTP_DENY_LIST = ''

        let actualHttpSecurity!: typeof import('./httpSecurity')
        jest.dontMock('axios')
        jest.isolateModules(() => {
            actualHttpSecurity = require('./httpSecurity')
        })
        const policy = {
            trustedResourceLimits: actualHttpSecurity.createTrustedSecureRequestResourceLimits({
                timeoutMs: 1000,
                maxRequestBytes: 1024,
                maxResponseBytes: 1024
            })
        }
        const transformedBodies: unknown[] = []

        const errorText = await actualHttpSecurity
            .secureAxiosRequest(
                {
                    method: 'GET',
                    url: `http://localhost:${port}/utf16-response-start`,
                    responseEncoding: 'utf16le',
                    responseType: 'text',
                    transformResponse: (data) => {
                        transformedBodies.push(data)
                        return { compact: true }
                    }
                },
                5,
                undefined,
                policy
            )
            .then(
                () => '',
                (error) => String(error)
            )

        expect(errorText).toBe('Error: HTTP request exceeded a configured resource limit.')
        expect(errorText).not.toContain('utf16-response')
        expect(utf16ResponseHits).toBe(2)
        expect(transformedBodies).toEqual(['a'.repeat(300)])
    })

    it('preserves Axios arraybuffer, json, text, default BOM, and empty-body response semantics', async () => {
        expect(process.versions.node).toMatch(/^24\./)
        process.env.HTTP_SECURITY_CHECK = 'false'
        process.env.HTTP_DENY_LIST = ''

        let actualSecureAxiosRequest!: typeof secureAxiosRequest
        jest.dontMock('axios')
        jest.isolateModules(() => {
            actualSecureAxiosRequest = require('./httpSecurity').secureAxiosRequest
        })
        const baseUrl = `http://localhost:${port}/response-semantics`

        const arraybufferResponse = await actualSecureAxiosRequest({
            method: 'GET',
            url: `${baseUrl}/arraybuffer`,
            responseType: 'arraybuffer'
        })
        const jsonResponse = await actualSecureAxiosRequest({ method: 'GET', url: `${baseUrl}/json`, responseType: 'json' })
        const textResponse = await actualSecureAxiosRequest({
            method: 'GET',
            url: `${baseUrl}/text`,
            responseType: 'text',
            responseEncoding: 'utf16le',
            transformResponse: (data) => `${data}:transformed`
        })
        const defaultResponse = await actualSecureAxiosRequest({ method: 'GET', url: `${baseUrl}/default` })
        const emptyResponse = await actualSecureAxiosRequest({ method: 'GET', url: `${baseUrl}/empty` })

        expect(Buffer.isBuffer(arraybufferResponse.data)).toBe(true)
        expect(arraybufferResponse.data).toEqual(Buffer.from([0, 1, 2, 255]))
        expect(arraybufferResponse.config.responseType).toBe('arraybuffer')
        expect(jsonResponse.data).toEqual({ ok: true })
        expect(jsonResponse.config.responseType).toBe('json')
        expect(textResponse.data).toBe('中文文本:transformed')
        expect(textResponse.config.responseType).toBe('text')
        expect(defaultResponse.data).toBe('default-text')
        expect(defaultResponse.config.responseType).toBeUndefined()
        expect(emptyResponse.data).toBe('')
    })
})
