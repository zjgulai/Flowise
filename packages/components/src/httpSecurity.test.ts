import { describe, expect, it } from '@jest/globals'
import dns from 'dns/promises'
import http from 'http'
import fetch, { Headers, Response } from 'node-fetch'
import { checkDenyList, isDeniedIP, secureFetch } from './httpSecurity'

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
        mockedFetch.mockResolvedValueOnce(new Response('', { status, headers: { location: 'https://1.1.1.1/redirected' } }))

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
                'X-Trace': 'keep-me'
            }
        ]
    ]

    it.each(['GET', 'HEAD'])('strips sensitive headers from safe cross-origin %s redirects for every HeaderInit form', async (method) => {
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
            expect(redirectedHeaders.get('x-trace')).toBe('keep-me')
        }
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

describe('secureFetch pinned lookup integration', () => {
    const originalSecurityCheck = process.env.HTTP_SECURITY_CHECK
    const originalDenyList = process.env.HTTP_DENY_LIST
    let server: http.Server
    let port: number

    beforeAll(async () => {
        server = http.createServer((_request, response) => {
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
})
