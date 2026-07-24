import { Request, Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import { createHash } from 'node:crypto'

const DEFAULT_WINDOW_MS = 15 * 60_000
const DEFAULT_ACCOUNT_MAX = 10
const DEFAULT_IP_MAX = 30
const RATE_LIMIT_MESSAGE = '请求过于频繁，请稍后再试。'

export interface AdminAuthenticationRateLimitOptions {
    windowMs?: number
    /** Legacy test/config shorthand: applies the same ceiling to both dimensions. */
    max?: number
    accountMax?: number
    ipMax?: number
    skipSuccessfulRequests?: boolean
}

function positiveInteger(value: string | undefined, fallback: number, variableName: string): number {
    if (value === undefined || value.trim() === '') return fallback
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${variableName} must be a positive integer`)
    }
    return parsed
}

function normalizedAccountKey(req: Request): string {
    const candidate = req.body?.email ?? req.body?.user?.email
    if (typeof candidate === 'string') return candidate.trim().toLowerCase()

    const token = req.body?.tempToken ?? req.body?.user?.tempToken
    if (typeof token === 'string' && token.length > 0) {
        return `token:${createHash('sha256').update(token).digest('hex')}`
    }
    return '<missing-account-key>'
}

export function createAdminAuthenticationRateLimiter(options: AdminAuthenticationRateLimitOptions = {}) {
    const windowMs =
        options.windowMs ??
        positiveInteger(process.env.ADMIN_AUTH_RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS, 'ADMIN_AUTH_RATE_LIMIT_WINDOW_MS')
    const accountMax =
        options.accountMax ??
        options.max ??
        positiveInteger(process.env.ADMIN_AUTH_RATE_LIMIT_MAX, DEFAULT_ACCOUNT_MAX, 'ADMIN_AUTH_RATE_LIMIT_MAX')
    const ipMax =
        options.ipMax ??
        options.max ??
        positiveInteger(process.env.ADMIN_AUTH_IP_RATE_LIMIT_MAX, DEFAULT_IP_MAX, 'ADMIN_AUTH_IP_RATE_LIMIT_MAX')

    const commonOptions = {
        windowMs,
        standardHeaders: true,
        legacyHeaders: false,
        skipSuccessfulRequests: options.skipSuccessfulRequests ?? false,
        handler: (_req: Request, res: Response) => res.status(429).json({ message: RATE_LIMIT_MESSAGE })
    }

    return [
        // This limiter cannot be bypassed by rotating nonexistent email addresses from one source.
        rateLimit({ ...commonOptions, max: ipMax }),
        // This limiter shares the account budget across source IPs within the configured process/store.
        rateLimit({ ...commonOptions, max: accountMax, keyGenerator: (req) => normalizedAccountKey(req) })
    ]
}

// Login and recovery use separate stores/budgets so public recovery requests cannot lock out administrator login.
export const adminLoginRateLimiter = createAdminAuthenticationRateLimiter({ skipSuccessfulRequests: true })
export const adminPasswordRecoveryRateLimiter = createAdminAuthenticationRateLimiter()
// Invitation verification has its own process-local budget so abuse cannot consume
// either administrator login attempts or password-recovery capacity.
export const adminVerificationRateLimiter = createAdminAuthenticationRateLimiter()
