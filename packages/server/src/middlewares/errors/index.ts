import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { randomUUID } from 'crypto'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import logger from '../../utils/logger'

// we need eslint because we have to pass next arg for the error middleware
// eslint-disable-next-line
async function errorHandlerMiddleware(err: InternalFlowiseError, req: Request, res: Response, next: NextFunction) {
    const statusCode = err.statusCode || StatusCodes.INTERNAL_SERVER_ERROR
    const requestId = randomUUID()
    const isServerError = statusCode >= StatusCodes.INTERNAL_SERVER_ERROR
    const originalMessage = typeof err.message === 'string' ? err.message : ''
    const clientMessage = isServerError
        ? '服务器内部错误，请稍后重试'
        : originalMessage.includes('401 Incorrect API key provided')
        ? 'API 密钥无效，请检查密钥及模型访问权限。'
        : originalMessage
    if (isServerError) {
        logger.error(`request_failed requestId=${requestId} statusCode=${statusCode} method=${req.method}`)
    }
    const displayedError = {
        statusCode,
        success: false,
        message: clientMessage,
        requestId,
        // Provide error stack trace only in development
        ...(process.env.NODE_ENV === 'development' ? { stack: err.stack } : {})
    }

    if (!req.body || !req.body.streaming || req.body.streaming === 'false') {
        res.setHeader('Content-Type', 'application/json')
        res.status(displayedError.statusCode).json(displayedError)
    }
}

export default errorHandlerMiddleware
