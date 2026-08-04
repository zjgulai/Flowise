import { NextFunction, Request, Response } from 'express'

const API_V1_CASE_INSENSITIVE = /\/api\/v1\//i
const API_V1_CANONICAL = /\/api\/v1\//
const MCP_PATH_CASE_INSENSITIVE = /^\/api\/v1\/mcp(?:\/|$)/i
const MCP_PATH_CANONICAL = /^\/api\/v1\/mcp(?:\/|$)/

export const isApiV1Path = (requestPath: string): boolean => API_V1_CASE_INSENSITIVE.test(requestPath)

export const isCanonicalApiV1Path = (requestPath: string): boolean => API_V1_CANONICAL.test(requestPath)

const isNonCanonicalMcpPath = (requestPath: string): boolean =>
    MCP_PATH_CASE_INSENSITIVE.test(requestPath) && !MCP_PATH_CANONICAL.test(requestPath)

/**
 * Reject non-canonical API casing before any early-mounted API route can
 * reach rate limiting, authentication, persistence or body parsing.
 */
export const rejectNonCanonicalApiPath = (req: Request, res: Response, next: NextFunction): void => {
    if ((isApiV1Path(req.path) && !isCanonicalApiV1Path(req.path)) || isNonCanonicalMcpPath(req.path)) {
        res.status(401).json({ error: 'Unauthorized Access' })
        return
    }
    next()
}
