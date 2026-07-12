// At the top of XSS.test.ts, before importing getAllowedIframeOrigins
jest.mock('./domainValidation', () => ({
    extractChatflowId: jest.fn(),
    isPublicChatflowRequest: jest.fn(),
    isTTSGenerateRequest: jest.fn(),
    validateChatflowDomain: jest.fn()
}))

jest.mock('./logger', () => ({
    __esModule: true,
    default: { warn: jest.fn(), info: jest.fn(), error: jest.fn() }
}))

import logger from './logger'
import { getAllowedIframeOrigins, getCorsOptions, getIframeSecurityHeaders, parseIframeOrigins, validateCorsConfig } from './XSS'
import { extractChatflowId, isPublicChatflowRequest, isTTSGenerateRequest, validateChatflowDomain } from './domainValidation'

// ---------------------------------------------------------------------------
// getCorsOptions
// ---------------------------------------------------------------------------

describe('getCorsOptions', () => {
    const SAVED_CORS_ORIGINS = process.env.CORS_ORIGINS
    const SAVED_CORS_ALLOW_CREDENTIALS = process.env.CORS_ALLOW_CREDENTIALS
    const SAVED_IFRAME_ORIGINS = process.env.IFRAME_ORIGINS
    const SAVED_NODE_ENV = process.env.NODE_ENV

    afterEach(() => {
        if (SAVED_CORS_ORIGINS !== undefined) process.env.CORS_ORIGINS = SAVED_CORS_ORIGINS
        else delete process.env.CORS_ORIGINS
        if (SAVED_CORS_ALLOW_CREDENTIALS !== undefined) process.env.CORS_ALLOW_CREDENTIALS = SAVED_CORS_ALLOW_CREDENTIALS
        else delete process.env.CORS_ALLOW_CREDENTIALS
        if (SAVED_IFRAME_ORIGINS !== undefined) process.env.IFRAME_ORIGINS = SAVED_IFRAME_ORIGINS
        else delete process.env.IFRAME_ORIGINS
        if (SAVED_NODE_ENV !== undefined) process.env.NODE_ENV = SAVED_NODE_ENV
        else delete process.env.NODE_ENV
        jest.clearAllMocks()
    })

    function getCredentials(corsOrigins: string | undefined, corsAllowCredentials: string | undefined): boolean {
        if (corsOrigins === undefined) delete process.env.CORS_ORIGINS
        else process.env.CORS_ORIGINS = corsOrigins
        if (corsAllowCredentials === undefined) delete process.env.CORS_ALLOW_CREDENTIALS
        else process.env.CORS_ALLOW_CREDENTIALS = corsAllowCredentials

        let captured: any
        getCorsOptions()({ url: '/api/v1/test' }, (_err: any, options: any) => {
            captured = options
        })
        return captured.credentials
    }

    describe('wildcard + credentials guard', () => {
        it('forces credentials to false when CORS_ORIGINS=* and CORS_ALLOW_CREDENTIALS=true', () => {
            expect(getCredentials('*', 'true')).toBe(false)
        })

        it('leaves credentials false when CORS_ORIGINS=* and CORS_ALLOW_CREDENTIALS is unset', () => {
            expect(getCredentials('*', undefined)).toBe(false)
        })

        it('allows credentials when CORS_ORIGINS is an explicit list', () => {
            expect(getCredentials('https://trusted.example.com', 'true')).toBe(true)
        })

        it('allows credentials when CORS_ORIGINS has multiple explicit origins', () => {
            expect(getCredentials('https://app.example.com,https://admin.example.com', 'true')).toBe(true)
        })

        it('uses credentials=false when CORS_ALLOW_CREDENTIALS is unset regardless of CORS_ORIGINS', () => {
            expect(getCredentials('https://trusted.example.com', undefined)).toBe(false)
        })
    })

    describe('public chatflow domain checks', () => {
        async function getOriginDecision(req: any, origin: string): Promise<boolean | undefined> {
            let captured: any
            getCorsOptions()(req, (_err: any, options: any) => {
                captured = options
            })

            return new Promise((resolve, reject) => {
                captured.origin(origin, (err: Error | null, allow?: boolean) => {
                    if (err) reject(err)
                    else resolve(allow)
                })
            })
        }

        it('denies malformed public chatflow IDs without calling domain validation', async () => {
            delete process.env.CORS_ORIGINS
            ;(isPublicChatflowRequest as jest.Mock).mockReturnValue(true)
            ;(isTTSGenerateRequest as jest.Mock).mockReturnValue(false)
            ;(extractChatflowId as jest.Mock).mockReturnValue('not-a-uuid')

            await expect(getOriginDecision({ url: '/api/v1/prediction/not-a-uuid' }, 'https://evil.example')).resolves.toBe(false)
            expect(validateChatflowDomain).not.toHaveBeenCalled()
        })

        it('still uses domain validation for valid public chatflow IDs', async () => {
            delete process.env.CORS_ORIGINS
            ;(isPublicChatflowRequest as jest.Mock).mockReturnValue(true)
            ;(isTTSGenerateRequest as jest.Mock).mockReturnValue(false)
            ;(extractChatflowId as jest.Mock).mockReturnValue('123e4567-e89b-42d3-a456-426614174000')
            ;(validateChatflowDomain as jest.Mock).mockResolvedValue(true)

            await expect(
                getOriginDecision({ url: '/api/v1/prediction/123e4567-e89b-42d3-a456-426614174000' }, 'https://trusted.example')
            ).resolves.toBe(true)
            expect(validateChatflowDomain).toHaveBeenCalledWith(
                '123e4567-e89b-42d3-a456-426614174000',
                'https://trusted.example',
                undefined
            )
        })
    })

    describe('validateCorsConfig', () => {
        beforeEach(() => jest.clearAllMocks())

        it('warns when CORS_ORIGINS=* and CORS_ALLOW_CREDENTIALS=true', () => {
            process.env.CORS_ORIGINS = '*'
            process.env.CORS_ALLOW_CREDENTIALS = 'true'
            validateCorsConfig()
            expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('[CORS]'))
        })

        it('does not warn when CORS_ORIGINS=* without CORS_ALLOW_CREDENTIALS', () => {
            process.env.CORS_ORIGINS = '*'
            delete process.env.CORS_ALLOW_CREDENTIALS
            validateCorsConfig()
            expect(logger.warn).not.toHaveBeenCalled()
        })

        it('does not warn when CORS_ORIGINS is an explicit list with CORS_ALLOW_CREDENTIALS=true', () => {
            process.env.CORS_ORIGINS = 'https://trusted.example.com'
            process.env.CORS_ALLOW_CREDENTIALS = 'true'
            validateCorsConfig()
            expect(logger.warn).not.toHaveBeenCalled()
        })

        it('warns once at startup when production CORS origins are missing, not once per request', () => {
            process.env.NODE_ENV = 'production'
            process.env.IFRAME_ORIGINS = "'self'"
            delete process.env.CORS_ORIGINS

            validateCorsConfig()
            expect(logger.warn).toHaveBeenCalledTimes(1)

            for (let requestIndex = 0; requestIndex < 3; requestIndex += 1) {
                getCorsOptions()({ url: '/api/v1/test' }, jest.fn())
            }
            expect(logger.warn).toHaveBeenCalledTimes(1)
        })
    })
})

describe('getAllowedIframeOrigins', () => {
    const originalEnv = process.env.IFRAME_ORIGINS
    const originalNodeEnv = process.env.NODE_ENV

    afterEach(() => {
        if (originalEnv !== undefined) {
            process.env.IFRAME_ORIGINS = originalEnv
        } else {
            delete process.env.IFRAME_ORIGINS
        }
        if (originalNodeEnv !== undefined) {
            process.env.NODE_ENV = originalNodeEnv
        } else {
            delete process.env.NODE_ENV
        }
    })

    it.each([undefined, '', '   '])("defaults %p to 'self'", (value) => {
        if (value === undefined) delete process.env.IFRAME_ORIGINS
        else process.env.IFRAME_ORIGINS = value
        expect(getAllowedIframeOrigins()).toBe("'self'")
    })

    it('normalizes, deduplicates, and preserves first-source order', () => {
        expect(
            parseIframeOrigins("'self', HTTPS://EXAMPLE.COM:443,https://embed.example.com:8443,https://example.com", 'production')
        ).toEqual(["'self'", 'https://example.com', 'https://embed.example.com:8443'])
    })

    it("allows 'none' only as a standalone source", () => {
        expect(parseIframeOrigins("'none'", 'production')).toEqual(["'none'"])
        expect(() => parseIframeOrigins("'none',https://example.com", 'production')).toThrow(/IFRAME_ORIGINS/)
    })

    it('allows local HTTP and wildcard only outside production', () => {
        expect(parseIframeOrigins('http://localhost:3000,http://127.0.0.1:3001,http://[::1]:3002', 'development')).toEqual([
            'http://localhost:3000',
            'http://127.0.0.1:3001',
            'http://[::1]:3002'
        ])
        expect(parseIframeOrigins('*', 'development')).toEqual(['*'])
        expect(() => parseIframeOrigins('*', 'production')).toThrow(/wildcard/i)
    })

    it.each([
        ['bare self', 'self'],
        ['bare none', 'none'],
        ['unsupported quoted keyword', "'unsafe-inline'"],
        ['directive separator', "'self'; script-src *"],
        ['newline', "'self'\nhttps://evil.example"],
        ['leading empty CSV item', ',https://example.com'],
        ['trailing empty CSV item', 'https://example.com,'],
        ['consecutive empty CSV item', 'https://one.example,,https://two.example'],
        ['path', 'https://example.com/embed'],
        ['query', 'https://example.com/?key=value'],
        ['fragment', 'https://example.com/#embed'],
        ['credentials', 'https://user:password@example.com'],
        ['scheme source', 'https:'],
        ['remote HTTP in development', 'http://example.com']
    ])('rejects %s values without reflecting them', (_label, value) => {
        let message = ''
        try {
            parseIframeOrigins(value, 'development')
        } catch (error) {
            message = (error as Error).message
        }
        expect(message).toMatch(/IFRAME_ORIGINS/)
        expect(message).not.toContain(value)
    })

    it('rejects all remote HTTP origins in production', () => {
        expect(() => parseIframeOrigins('http://example.com', 'production')).toThrow(/HTTPS/i)
        expect(() => parseIframeOrigins('http://localhost:3000', 'production')).toThrow(/HTTPS/i)
    })

    it.each(['https://*.example.com', 'https://foo*bar.example.com', 'https://*', 'https://%2a.example.com', 'https://%2A.example.com'])(
        'rejects hostname wildcards after URL normalization: %s',
        (value) => {
            let message = ''
            try {
                parseIframeOrigins(value, 'development')
            } catch (error) {
                message = (error as Error).message
            }

            expect(message).toMatch(/IFRAME_ORIGINS/)
            expect(message).not.toContain(value)
        }
    )

    it('fails validation instead of warning and falling back from a production wildcard', () => {
        process.env.NODE_ENV = 'production'
        process.env.IFRAME_ORIGINS = '*'
        expect(() => validateCorsConfig()).toThrow(/wildcard/i)
    })
})

describe('getIframeSecurityHeaders', () => {
    const originalEnv = process.env.IFRAME_ORIGINS
    const originalNodeEnv = process.env.NODE_ENV

    afterEach(() => {
        if (originalEnv !== undefined) {
            process.env.IFRAME_ORIGINS = originalEnv
        } else {
            delete process.env.IFRAME_ORIGINS
        }
        if (originalNodeEnv !== undefined) {
            process.env.NODE_ENV = originalNodeEnv
        } else {
            delete process.env.NODE_ENV
        }
    })

    it('returns CSP only for development wildcard allowlists', () => {
        process.env.NODE_ENV = 'development'
        process.env.IFRAME_ORIGINS = '*'
        expect(getIframeSecurityHeaders()).toEqual({
            'Content-Security-Policy': 'frame-ancestors *'
        })
    })

    it("returns SAMEORIGIN only for 'self'", () => {
        process.env.IFRAME_ORIGINS = "'self'"
        expect(getIframeSecurityHeaders()).toEqual({
            'Content-Security-Policy': "frame-ancestors 'self'",
            'X-Frame-Options': 'SAMEORIGIN'
        })
    })

    it("returns DENY for 'none'", () => {
        process.env.IFRAME_ORIGINS = "'none'"
        expect(getIframeSecurityHeaders()).toEqual({
            'Content-Security-Policy': "frame-ancestors 'none'",
            'X-Frame-Options': 'DENY'
        })
    })

    it('omits X-Frame-Options for custom allowlists', () => {
        process.env.IFRAME_ORIGINS = 'https://embed.example.com,https://admin.example.com'
        expect(getIframeSecurityHeaders()).toEqual({
            'Content-Security-Policy': 'frame-ancestors https://embed.example.com https://admin.example.com'
        })
    })
})
