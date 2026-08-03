import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import mcpEndpointService from '../../services/mcp-endpoint'
import mcpServerService from '../../services/mcp-server'
import { isSupportedMcpToken } from '../../services/mcp-server/mcpTokenSecurity'
import { RateLimiterManager } from '../../utils/rateLimit'
import logger from '../../utils/logger'

/**
 * Extract token from the Authorization: Bearer <token> header.
 * Returns null if not present or malformed.
 */
function extractToken(req: Request): string | null {
    const authHeader = req.headers.authorization
    if (!authHeader || !authHeader.startsWith('Bearer ')) return null
    const token = authHeader.slice(7).trim()
    return isSupportedMcpToken(token) ? token : null
}

const sendAuthenticationError = (res: Response, statusCode: number, message: string) => {
    res.status(statusCode).json({
        jsonrpc: '2.0',
        error: { code: -32001, message },
        id: null
    })
}

/**
 * Authentication middleware — validates Bearer token and attaches it to res.locals.
 */
const authenticateToken = async (req: Request, res: Response, next: NextFunction) => {
    const token = extractToken(req)
    if (!token) {
        sendAuthenticationError(res, StatusCodes.UNAUTHORIZED, 'Unauthorized: missing or invalid Authorization header. Use Bearer <token>.')
        return
    }

    try {
        const chatflow = await mcpServerService.getChatflowByIdAndVerifyToken(req.params.chatflowId, token)
        res.locals.mcpToken = token
        res.locals.mcpChatflow = chatflow
        next()
    } catch (error) {
        if (error instanceof InternalFlowiseError && error.statusCode === StatusCodes.NOT_FOUND) {
            sendAuthenticationError(res, StatusCodes.NOT_FOUND, 'MCP server not found')
            return
        }
        if (error instanceof InternalFlowiseError && error.statusCode === StatusCodes.UNAUTHORIZED) {
            sendAuthenticationError(res, StatusCodes.UNAUTHORIZED, 'Unauthorized')
            return
        }
        next(error)
    }
}

/**
 * Rate limiter middleware for MCP endpoint — reuses per-chatflow rate limiters.
 */
const getRateLimiterMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { chatflowId } = req.params
        if (!chatflowId) {
            sendAuthenticationError(res, StatusCodes.NOT_FOUND, 'MCP server not found')
            return
        }
        return RateLimiterManager.getInstance().getRateLimiterById(chatflowId)(req, res, next)
    } catch (error) {
        next(error)
    }
}

/**
 * Handle POST /api/v1/mcp/:chatflowId — MCP JSON-RPC messages
 * Auth: token must be in Authorization: Bearer <token> header
 */
const handlePost = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { chatflowId } = req.params
        const token = res.locals.mcpToken as string | undefined
        const chatflow = res.locals.mcpChatflow as ChatFlow | undefined
        if (!token || !chatflow || chatflow.id !== chatflowId) {
            sendAuthenticationError(res, StatusCodes.UNAUTHORIZED, 'Unauthorized')
            return
        }

        logger.debug(`[MCP] POST request for chatflow: ${chatflowId}`)
        await mcpEndpointService.handleMcpRequest(chatflowId, token, req, res, chatflow)
    } catch (error) {
        next(error)
    }
}

/**
 * Handle DELETE /api/v1/mcp/:chatflowId — Session termination
 */
const handleDelete = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { chatflowId } = req.params
        await mcpEndpointService.handleMcpDeleteRequest(chatflowId, req, res)
    } catch (error) {
        next(error)
    }
}

export default {
    authenticateToken,
    handlePost,
    handleDelete,
    getRateLimiterMiddleware
}
