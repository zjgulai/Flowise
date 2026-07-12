import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'

export function resolveSecureCookie(env: NodeJS.ProcessEnv = process.env): boolean {
    if (env.NODE_ENV === 'production') return true
    if (env.SECURE_COOKIES === 'false') return false
    if (env.SECURE_COOKIES === 'true') return true
    return env.APP_URL?.startsWith('https') ?? false
}

export function enforceAuthResolvePostOnly(req: Request, res: Response, next: NextFunction): void {
    if (req.method === 'POST') {
        next()
        return
    }

    res.setHeader('Allow', 'POST')
    res.status(StatusCodes.METHOD_NOT_ALLOWED).json({
        statusCode: StatusCodes.METHOD_NOT_ALLOWED,
        success: false,
        message: 'Method Not Allowed'
    })
}
