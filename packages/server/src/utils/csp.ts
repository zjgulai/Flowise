import { RequestHandler } from 'express'

export const CSP_REPORT_ENDPOINT = '/api/v1/security/csp-report'
export const CSP_REPORT_GROUP = 'flowise-csp'

export type CspMode = 'compat' | 'no-eval' | 'strict-script' | 'strict'
type CspReportOnlyMode = CspMode | 'off'

type CspEnvironment = Record<string, string | undefined> & {
    CSP_ENFORCEMENT_MODE?: string
    CSP_REPORT_ONLY_MODE?: string
}

const CSP_MODES: CspMode[] = ['compat', 'no-eval', 'strict-script', 'strict']
const MODE_RANK: Record<CspMode, number> = {
    compat: 0,
    'no-eval': 1,
    'strict-script': 2,
    strict: 3
}

function validateTrustProxyHopCount(value: number): number {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
        throw new Error('[CSP] Invalid TRUST_PROXY: numeric hop counts must be finite, non-negative integers.')
    }
    return value
}

export function resolveTrustProxy(rawValue: string | undefined): string | boolean | number {
    const value = rawValue?.trim()
    if (!value || value === 'true') return true
    if (value === 'false') return false

    const numericValue = Number(value)
    if (value.toLowerCase() === 'nan' || !Number.isNaN(numericValue)) {
        return validateTrustProxyHopCount(numericValue)
    }
    return value
}

export function createSecurityHeadersMiddleware(headers: Readonly<Record<string, string>>): RequestHandler {
    return (_req, res, next) => {
        for (const [headerName, headerValue] of Object.entries(headers)) {
            res.setHeader(headerName, headerValue)
        }
        next()
    }
}

function resolveMode(value: string | undefined, variableName: string, fallback: CspMode): CspMode {
    const candidate = value?.trim() || fallback
    if (!CSP_MODES.includes(candidate as CspMode)) {
        throw new Error(`[CSP] Invalid ${variableName}: expected a supported policy mode.`)
    }
    return candidate as CspMode
}

function resolveReportOnlyMode(value: string | undefined): CspReportOnlyMode {
    const candidate = value?.trim() || 'off'
    if (candidate !== 'off' && !CSP_MODES.includes(candidate as CspMode)) {
        throw new Error('[CSP] Invalid CSP_REPORT_ONLY_MODE: expected off or a supported policy mode.')
    }
    return candidate as CspReportOnlyMode
}

function getScriptSources(mode: CspMode): string {
    if (mode === 'compat') return "'self' 'unsafe-inline' 'unsafe-eval'"
    if (mode === 'no-eval') return "'self' 'unsafe-inline'"
    return "'self'"
}

function getStyleSources(mode: CspMode): string {
    return mode === 'strict' ? "'self'" : "'self' 'unsafe-inline'"
}

function resolveReportingEndpoint(appUrl: string | undefined): string {
    if (!appUrl?.trim()) throw new Error('[CSP] APP_URL is required when CSP reporting is enabled.')

    let parsed: URL
    try {
        parsed = new URL(appUrl)
    } catch {
        throw new Error('[CSP] APP_URL must be a valid URL when CSP reporting is enabled.')
    }

    if (parsed.username || parsed.password) {
        throw new Error('[CSP] APP_URL credentials are not allowed when CSP reporting is enabled.')
    }
    const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]'
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
        throw new Error('[CSP] APP_URL must use HTTPS when CSP reporting is enabled.')
    }
    return new URL(CSP_REPORT_ENDPOINT, parsed.origin).toString()
}

export function buildContentSecurityPolicy(mode: CspMode, frameAncestors?: string): string {
    if (frameAncestors && /[\r\n;]/.test(frameAncestors)) {
        throw new Error('[CSP] Invalid frame-ancestors sources.')
    }

    const directives = [
        "default-src 'self'",
        `script-src ${getScriptSources(mode)}`,
        `style-src ${getStyleSources(mode)}`,
        "img-src 'self' data: blob:",
        "connect-src 'self' ws: wss:",
        "font-src 'self'",
        "manifest-src 'self'",
        "base-uri 'self'",
        "form-action 'self'"
    ]
    if (frameAncestors) directives.push(`frame-ancestors ${frameAncestors}`)
    return directives.join('; ')
}

export function getCspSecurityHeaders(frameAncestors: string, env: CspEnvironment = process.env): Record<string, string> {
    const enforcementMode = resolveMode(env.CSP_ENFORCEMENT_MODE, 'CSP_ENFORCEMENT_MODE', 'compat')
    const reportOnlyMode = resolveReportOnlyMode(env.CSP_REPORT_ONLY_MODE)
    const headers: Record<string, string> = {
        'Content-Security-Policy': buildContentSecurityPolicy(enforcementMode, frameAncestors)
    }

    if (reportOnlyMode === 'off') return headers
    if (MODE_RANK[reportOnlyMode] <= MODE_RANK[enforcementMode]) {
        throw new Error('[CSP] CSP_REPORT_ONLY_MODE must be stricter than CSP_ENFORCEMENT_MODE.')
    }
    const reportingEndpoint = resolveReportingEndpoint(env.APP_URL)

    headers['Content-Security-Policy-Report-Only'] = `${buildContentSecurityPolicy(
        reportOnlyMode
    )}; report-uri ${CSP_REPORT_ENDPOINT}; report-to ${CSP_REPORT_GROUP}`
    headers['Reporting-Endpoints'] = `${CSP_REPORT_GROUP}="${reportingEndpoint}"`
    return headers
}

export function validateCspReportTrustProxy(trustProxy: string | boolean | number | undefined, reportOnlyEnabled: boolean): void {
    if (typeof trustProxy === 'number') validateTrustProxyHopCount(trustProxy)
    if (reportOnlyEnabled && trustProxy === true) {
        throw new Error('[CSP] CSP reporting requires a bounded TRUST_PROXY policy; unrestricted true is not allowed.')
    }
}
