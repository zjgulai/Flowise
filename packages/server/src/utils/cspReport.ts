import express, { NextFunction, Request, Response, Router } from 'express'
import { rateLimit } from 'express-rate-limit'
import logger from './logger'

const CSP_REPORT_BODY_LIMIT = '16kb'
const CSP_REPORT_MEDIA_TYPES = ['application/csp-report', 'application/reports+json', 'application/json']
const CSP_REPORT_RATE_LIMIT_WINDOW_MS = 60_000
const CSP_REPORT_RATE_LIMIT_MAX = 120
const CSP_REPORT_MAX_ENVELOPES = 10
const SAFE_BLOCKED_VALUES = new Set(['inline', 'eval', 'self', 'data', 'blob'])

interface CspReportLog {
    warn(message: string): unknown
}

interface CspReportRouterOptions {
    log?: CspReportLog
    rateLimitMax?: number
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function safeDirective(value: unknown): string | undefined {
    return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value) ? value : undefined
}

function safeDisposition(value: unknown): string | undefined {
    return value === 'enforce' || value === 'report' ? value : undefined
}

function safeStatusCode(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined
}

function safeOrigin(value: unknown, allowSpecialValues = false): string | undefined {
    if (typeof value !== 'string') return undefined
    if (allowSpecialValues && SAFE_BLOCKED_VALUES.has(value)) return value
    try {
        const parsed = new URL(value)
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : undefined
    } catch {
        return undefined
    }
}

function withoutUndefined(values: Record<string, string | number | undefined>): Record<string, string | number> {
    return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string | number] => entry[1] !== undefined))
}

function sanitizeLegacyReport(body: UnknownRecord): Record<string, string | number> | undefined {
    const report = body['csp-report']
    if (!isRecord(report)) return undefined
    const directive = safeDirective(report['effective-directive'] ?? report['violated-directive'])
    if (!directive) return undefined

    return withoutUndefined({
        directive,
        disposition: safeDisposition(report.disposition),
        statusCode: safeStatusCode(report['status-code']),
        documentOrigin: safeOrigin(report['document-uri']),
        blockedOrigin: safeOrigin(report['blocked-uri'], true)
    })
}

function sanitizeReportingApiReport(report: unknown): Record<string, string | number> | undefined {
    if (!isRecord(report) || report.type !== 'csp-violation' || !isRecord(report.body)) return undefined
    const directive = safeDirective(report.body.effectiveDirective)
    if (!directive) return undefined

    return withoutUndefined({
        directive,
        disposition: safeDisposition(report.body.disposition),
        statusCode: safeStatusCode(report.body.statusCode),
        documentOrigin: safeOrigin(report.body.documentURL ?? report.url),
        blockedOrigin: safeOrigin(report.body.blockedURL, true)
    })
}

function sanitizeReports(body: unknown): Array<Record<string, string | number>> {
    if (Array.isArray(body)) {
        return body
            .slice(0, CSP_REPORT_MAX_ENVELOPES)
            .map(sanitizeReportingApiReport)
            .filter((report): report is Record<string, string | number> => Boolean(report))
    }
    if (!isRecord(body)) return []
    const report = sanitizeLegacyReport(body)
    return report ? [report] : []
}

function requireSupportedMediaType(req: Request, res: Response, next: NextFunction): void {
    if (!req.is(CSP_REPORT_MEDIA_TYPES)) {
        res.sendStatus(415)
        return
    }
    next()
}

function handleBodyParserError(error: unknown, _req: Request, res: Response, next: NextFunction): void {
    const parserError = error as { status?: number; type?: string }
    if (parserError.type === 'entity.too.large') {
        res.sendStatus(413)
        return
    }
    if (error instanceof SyntaxError && parserError.status === 400) {
        res.sendStatus(400)
        return
    }
    next(error)
}

export function createCspReportRouter(options: CspReportRouterOptions = {}): Router {
    const router = express.Router()
    const reportLogger = options.log ?? logger
    const rateLimitMax = options.rateLimitMax ?? CSP_REPORT_RATE_LIMIT_MAX
    if (!Number.isInteger(rateLimitMax) || rateLimitMax < 1) {
        throw new Error('[CSP] Invalid report rate limit configuration.')
    }

    const reportRateLimit = rateLimit({
        windowMs: CSP_REPORT_RATE_LIMIT_WINDOW_MS,
        max: rateLimitMax,
        standardHeaders: true,
        legacyHeaders: false
    })

    router.post(
        '/',
        reportRateLimit,
        requireSupportedMediaType,
        express.json({ limit: CSP_REPORT_BODY_LIMIT, type: CSP_REPORT_MEDIA_TYPES }),
        (req: Request, res: Response) => {
            const reports = sanitizeReports(req.body)
            if (reports.length > 0) {
                reportLogger.warn(JSON.stringify({ event: 'csp-report', reports }))
            }
            res.status(204).end()
        }
    )
    router.use(handleBodyParserError)
    return router
}
