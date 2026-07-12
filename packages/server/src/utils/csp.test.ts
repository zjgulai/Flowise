import { buildContentSecurityPolicy, getCspSecurityHeaders, resolveTrustProxy, validateCspReportTrustProxy } from './csp'

describe('buildContentSecurityPolicy', () => {
    it('preserves the current compatibility policy', () => {
        const policy = buildContentSecurityPolicy('compat', "'self'")
        expect(policy).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'")
        expect(policy).toContain("style-src 'self' 'unsafe-inline'")
        expect(policy).toContain("frame-ancestors 'self'")
    })

    it('removes one unsafe capability per policy stage', () => {
        const noEval = buildContentSecurityPolicy('no-eval', "'self'")
        expect(noEval).toContain("script-src 'self' 'unsafe-inline'")
        expect(noEval).not.toContain("'unsafe-eval'")

        const strictScript = buildContentSecurityPolicy('strict-script', "'self'")
        expect(strictScript).toContain("script-src 'self'")
        expect(strictScript).not.toMatch(/script-src[^;]*'unsafe-/)
        expect(strictScript).toContain("style-src 'self' 'unsafe-inline'")

        const strict = buildContentSecurityPolicy('strict', "'self'")
        expect(strict).not.toContain("'unsafe-inline'")
        expect(strict).not.toContain("'unsafe-eval'")
        expect(strict).toContain("style-src 'self'")
    })

    it('serializes all baseline directives exactly once in stable order', () => {
        const policy = buildContentSecurityPolicy('strict', 'https://embed.example.com')
        expect(policy).toBe(
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors https://embed.example.com"
        )
    })
})

describe('getCspSecurityHeaders', () => {
    it('defaults to compat enforcement with report-only disabled', () => {
        const headers = getCspSecurityHeaders("'self'", {})
        expect(headers['Content-Security-Policy']).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'")
        expect(headers).not.toHaveProperty('Content-Security-Policy-Report-Only')
        expect(headers).not.toHaveProperty('Reporting-Endpoints')
    })

    it('builds a stricter report-only candidate and reporting endpoint headers', () => {
        const headers = getCspSecurityHeaders("'self' https://embed.example.com", {
            CSP_ENFORCEMENT_MODE: 'compat',
            CSP_REPORT_ONLY_MODE: 'no-eval',
            APP_URL: 'https://flowise.example.com'
        })

        expect(headers['Content-Security-Policy']).toContain("frame-ancestors 'self' https://embed.example.com")
        expect(headers['Content-Security-Policy-Report-Only']).not.toContain('frame-ancestors')
        expect(headers['Content-Security-Policy-Report-Only']).not.toContain("'unsafe-eval'")
        expect(headers['Content-Security-Policy-Report-Only']).toContain('report-uri /api/v1/security/csp-report')
        expect(headers['Content-Security-Policy-Report-Only']).toContain('report-to flowise-csp')
        expect(headers['Reporting-Endpoints']).toBe('flowise-csp="https://flowise.example.com/api/v1/security/csp-report"')
    })

    it.each([
        [{ CSP_ENFORCEMENT_MODE: 'loose' }, /CSP_ENFORCEMENT_MODE/],
        [{ CSP_REPORT_ONLY_MODE: 'monitor' }, /CSP_REPORT_ONLY_MODE/],
        [{ CSP_ENFORCEMENT_MODE: 'strict-script', CSP_REPORT_ONLY_MODE: 'no-eval', APP_URL: 'https://flowise.example.com' }, /stricter/],
        [{ CSP_ENFORCEMENT_MODE: 'no-eval', CSP_REPORT_ONLY_MODE: 'no-eval', APP_URL: 'https://flowise.example.com' }, /stricter/],
        [{ CSP_ENFORCEMENT_MODE: 'strict', CSP_REPORT_ONLY_MODE: 'strict', APP_URL: 'https://flowise.example.com' }, /stricter/],
        [{ CSP_REPORT_ONLY_MODE: 'no-eval' }, /APP_URL/],
        [{ CSP_REPORT_ONLY_MODE: 'no-eval', APP_URL: 'not-a-url' }, /APP_URL/],
        [{ CSP_REPORT_ONLY_MODE: 'no-eval', APP_URL: 'http://flowise.example.com' }, /HTTPS/]
    ])('fails fast for invalid or misleading configuration %#', (env, expectedError) => {
        expect(() => getCspSecurityHeaders("'self'", env)).toThrow(expectedError)
    })

    it('does not reflect invalid mode values in errors', () => {
        const submitted = 'secret-mode-value'
        expect(() => getCspSecurityHeaders("'self'", { CSP_ENFORCEMENT_MODE: submitted })).toThrow(/CSP_ENFORCEMENT_MODE/)
        try {
            getCspSecurityHeaders("'self'", { CSP_ENFORCEMENT_MODE: submitted })
        } catch (error) {
            expect((error as Error).message).not.toContain(submitted)
        }
    })

    it('allows an HTTP loopback APP_URL for isolated local acceptance', () => {
        expect(
            getCspSecurityHeaders("'self'", {
                CSP_REPORT_ONLY_MODE: 'no-eval',
                APP_URL: 'http://127.0.0.1:33117'
            })['Reporting-Endpoints']
        ).toBe('flowise-csp="http://127.0.0.1:33117/api/v1/security/csp-report"')
    })
})

describe('validateCspReportTrustProxy', () => {
    it('rejects unrestricted proxy trust when CSP reporting is enabled', () => {
        expect(() => validateCspReportTrustProxy(true, true)).toThrow(/TRUST_PROXY/)
    })

    it.each([false, 0, 1, 2, 'loopback', '10.0.0.0/8'] as const)('accepts bounded proxy trust %p', (trustProxy) => {
        expect(() => validateCspReportTrustProxy(trustProxy, true)).not.toThrow()
    })

    it('does not constrain trust proxy when reporting is disabled', () => {
        expect(() => validateCspReportTrustProxy(true, false)).not.toThrow()
    })

    it.each([Infinity, -Infinity, NaN, 1.5, -1])('rejects invalid numeric trust proxy value %p', (trustProxy) => {
        expect(() => validateCspReportTrustProxy(trustProxy, false)).toThrow(/TRUST_PROXY/)
    })
})

describe('resolveTrustProxy', () => {
    it.each([
        [undefined, true],
        ['', true],
        ['true', true],
        ['false', false],
        ['0', 0],
        ['1', 1],
        ['2', 2],
        ['loopback', 'loopback'],
        ['10.0.0.0/8', '10.0.0.0/8']
    ] as const)('resolves bounded trust proxy value %p', (value, expected) => {
        expect(resolveTrustProxy(value)).toBe(expected)
    })

    it.each(['Infinity', '-Infinity', 'NaN', '1.5', '-1'])('rejects invalid numeric string %s without reflecting it', (value) => {
        let message = ''
        try {
            resolveTrustProxy(value)
        } catch (error) {
            message = (error as Error).message
        }

        expect(message).toMatch(/TRUST_PROXY/)
        expect(message).not.toContain(value)
    })
})
