import express, { NextFunction, Request, Response } from 'express'
import { rateLimit } from 'express-rate-limit'
import { LoggedInUser } from '../../Interface.Enterprise'
import { AcceptanceLoginRejectedError } from '../../services/acceptanceLogin.service'
import { ACCEPTANCE_LOGIN_MESSAGE, ACCEPTANCE_LOGIN_PATH } from '../../utils/acceptanceLoginPolicy'

const ACCEPTANCE_RATE_LIMIT_WINDOW_MS = 60_000
const ACCEPTANCE_RATE_LIMIT_MAX = 5
const RATE_LIMIT_MESSAGE = '请求过于频繁，请稍后再试。'
const INTERNAL_ERROR_MESSAGE = '认证会话建立失败，请重新生成一次性认证码。'

export type SendAuthenticatedResponse = (res: Response, user: LoggedInUser, regenerateRefreshToken: boolean, req?: Request) => unknown

export interface AcceptanceRouteDependencies {
    appUrl: string | undefined
    consume: (code: unknown) => Promise<LoggedInUser>
    sendAuthenticatedResponse: SendAuthenticatedResponse
    rateLimitMax?: number
}

function callbackToPromise(operation: (done: (error?: unknown) => void) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        operation((error?: unknown) => {
            if (error) reject(error)
            else resolve()
        })
    })
}

async function destroySessionBestEffort(req: Request): Promise<void> {
    if (!req.session || typeof req.session.destroy !== 'function') return
    try {
        await callbackToPromise((done) => req.session.destroy(done))
    } catch {
        // Preserve the original session-establishment error.
    }
}

export async function establishAcceptanceSession(
    req: Request,
    res: Response,
    user: LoggedInUser,
    send: SendAuthenticatedResponse
): Promise<void> {
    try {
        await callbackToPromise((done) => req.session.regenerate(done))
        await callbackToPromise((done) => req.login(user, { session: true }, done))
        await callbackToPromise((done) => req.session.save(done))
        await Promise.resolve(send(res, user, true, req))
    } catch (error) {
        await destroySessionBestEffort(req)
        throw error
    }
}

function setAcceptanceResponseHeaders(_req: Request, res: Response, next: NextFunction): void {
    res.set('Cache-Control', 'no-store')
    res.set('Pragma', 'no-cache')
    res.set('Referrer-Policy', 'no-referrer')
    next()
}

function rejectAcceptanceRequest(res: Response): Response {
    return res.status(404).json({ message: ACCEPTANCE_LOGIN_MESSAGE })
}

function resolveExpectedOrigin(appUrl: string | undefined): string | undefined {
    if (!appUrl) return undefined
    return new URL(appUrl).origin
}

function hasValidRequestBoundary(req: Request, expectedOrigin: string | undefined): boolean {
    return (
        expectedOrigin !== undefined &&
        req.get('origin') === expectedOrigin &&
        req.get('x-request-from') === 'internal' &&
        req.is('application/json') === 'application/json' &&
        req.body !== null &&
        typeof req.body === 'object' &&
        !Array.isArray(req.body) &&
        Object.keys(req.body).length === 1 &&
        Object.prototype.hasOwnProperty.call(req.body, 'code')
    )
}

export function registerAcceptanceLoginRoute(app: express.Application, dependencies: AcceptanceRouteDependencies): void {
    const expectedOrigin = resolveExpectedOrigin(dependencies.appUrl)
    const rateLimitMax = dependencies.rateLimitMax ?? ACCEPTANCE_RATE_LIMIT_MAX
    if (!Number.isInteger(rateLimitMax) || rateLimitMax < 1) {
        throw new Error('Invalid acceptance login rate limit configuration')
    }

    const acceptanceLimiter = rateLimit({
        windowMs: ACCEPTANCE_RATE_LIMIT_WINDOW_MS,
        max: rateLimitMax,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (_req, res) => res.status(429).json({ message: RATE_LIMIT_MESSAGE })
    })

    app.all(ACCEPTANCE_LOGIN_PATH, setAcceptanceResponseHeaders, (req, res, next) => {
        if (req.method !== 'POST') return rejectAcceptanceRequest(res)
        next()
    })

    app.post(ACCEPTANCE_LOGIN_PATH, acceptanceLimiter, async (req, res) => {
        if (!hasValidRequestBoundary(req, expectedOrigin)) return rejectAcceptanceRequest(res)

        let user: LoggedInUser
        try {
            user = await dependencies.consume(req.body.code)
        } catch (error) {
            if (error instanceof AcceptanceLoginRejectedError) return rejectAcceptanceRequest(res)
            return res.status(500).json({ message: INTERNAL_ERROR_MESSAGE })
        }

        try {
            await establishAcceptanceSession(req, res, user, dependencies.sendAuthenticatedResponse)
        } catch {
            if (!res.headersSent) res.status(500).json({ message: INTERNAL_ERROR_MESSAGE })
        }
    })
}
