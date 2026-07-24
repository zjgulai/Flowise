import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'

/**
 * Sensitive account operations require the user established by Passport's interactive session.
 * API-key principals intentionally have no serialized session user and cannot enter this path.
 */
export function isInteractiveSessionRequest(req: Request): boolean {
    const sessionUserId = (req.session as Request['session'] & { passport?: { user?: { id?: string } } })?.passport?.user?.id
    return Boolean(req.user?.id && sessionUserId && sessionUserId === req.user.id)
}

export function requireInteractiveSession(req: Request, res: Response, next: NextFunction) {
    if (!isInteractiveSessionRequest(req)) return res.status(StatusCodes.FORBIDDEN).json({ message: 'Forbidden' })
    next()
}

export function requireOrganizationAdminSession(req: Request, res: Response, next: NextFunction) {
    if (!isInteractiveSessionRequest(req) || req.user?.isOrganizationAdmin !== true) {
        return res.status(StatusCodes.FORBIDDEN).json({ message: 'Forbidden' })
    }
    next()
}
