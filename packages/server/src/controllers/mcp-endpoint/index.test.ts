/**
 * Unit tests for MCP endpoint controller (packages/server/src/controllers/mcp-endpoint/index.ts)
 *
 * Tests the Express request handlers: token extraction, auth enforcement,
 * rate limiter middleware delegation, and request routing to the service layer.
 */
import { Request, Response, NextFunction } from 'express'
import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'

// --- Mock setup ---
const mockHandleMcpRequest = jest.fn()
const mockHandleMcpDeleteRequest = jest.fn()
const mockGetChatflowByIdAndVerifyToken = jest.fn()

jest.mock('../../services/mcp-endpoint', () => ({
    __esModule: true,
    default: {
        handleMcpRequest: (...args: any[]) => mockHandleMcpRequest(...args),
        handleMcpDeleteRequest: (...args: any[]) => mockHandleMcpDeleteRequest(...args)
    }
}))

jest.mock('../../services/mcp-server', () => ({
    __esModule: true,
    default: {
        getChatflowByIdAndVerifyToken: (...args: any[]) => mockGetChatflowByIdAndVerifyToken(...args)
    }
}))

const mockGetRateLimiterById = jest.fn().mockReturnValue((_req: any, _res: any, next: any) => next())

jest.mock('../../utils/rateLimit', () => ({
    RateLimiterManager: {
        getInstance: () => ({
            getRateLimiterById: (id: string) => mockGetRateLimiterById(id)
        })
    }
}))

jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    }
}))

// Import after mocking
import mcpEndpointController from '.'

// Helper: create mock Express objects
function mockReq(overrides: Record<string, any> = {}): Request {
    return {
        params: { chatflowId: 'flow-123' },
        headers: {},
        query: {},
        get: jest.fn(),
        ...overrides
    } as unknown as Request
}

function mockRes(): Response {
    const res: any = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        locals: {}
    }
    return res as Response
}

function mockNext(): NextFunction {
    return jest.fn()
}

beforeEach(() => {
    jest.clearAllMocks()
    mockGetChatflowByIdAndVerifyToken.mockResolvedValue({ id: 'flow-123' })
})

describe('MCP Endpoint Controller', () => {
    describe('authenticateToken', () => {
        it('returns 401 when Authorization header is missing', async () => {
            const req = mockReq({ headers: {} })
            const res = mockRes()
            const next = mockNext()

            await mcpEndpointController.authenticateToken(req, res, next)

            expect(res.status).toHaveBeenCalledWith(401)
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    jsonrpc: '2.0',
                    error: expect.objectContaining({ code: -32001 })
                })
            )
            expect(next).not.toHaveBeenCalled()
            expect(mockGetChatflowByIdAndVerifyToken).not.toHaveBeenCalled()
        })

        it('returns 401 when Authorization header is not Bearer', async () => {
            const req = mockReq({ headers: { authorization: 'Basic dXNlcjpwYXNz' } })
            const res = mockRes()
            const next = mockNext()

            await mcpEndpointController.authenticateToken(req, res, next)

            expect(res.status).toHaveBeenCalledWith(401)
            expect(next).not.toHaveBeenCalled()
        })

        it('returns 401 when Bearer token is empty', async () => {
            const req = mockReq({ headers: { authorization: 'Bearer ' } })
            const res = mockRes()
            const next = mockNext()

            await mcpEndpointController.authenticateToken(req, res, next)

            expect(res.status).toHaveBeenCalledWith(401)
            expect(next).not.toHaveBeenCalled()
        })

        it('verifies and binds the ChatFlow before calling next', async () => {
            const token = 'a'.repeat(64)
            const chatflow = { id: 'flow-123' }
            mockGetChatflowByIdAndVerifyToken.mockResolvedValue(chatflow)
            const req = mockReq({ headers: { authorization: `Bearer ${token}` } })
            const res = mockRes()
            const next = mockNext()

            await mcpEndpointController.authenticateToken(req, res, next)

            expect(mockGetChatflowByIdAndVerifyToken).toHaveBeenCalledWith('flow-123', token)
            expect(res.locals.mcpToken).toBe(token)
            expect(res.locals.mcpChatflow).toBe(chatflow)
            expect(next).toHaveBeenCalled()
            expect(res.status).not.toHaveBeenCalled()
        })

        it('rejects a well-formed but invalid Bearer token before calling next', async () => {
            mockGetChatflowByIdAndVerifyToken.mockRejectedValue(
                new InternalFlowiseError(StatusCodes.UNAUTHORIZED, 'provider detail must not escape')
            )
            const req = mockReq({ headers: { authorization: `Bearer ${'b'.repeat(64)}` } })
            const res = mockRes()
            const next = mockNext()

            await mcpEndpointController.authenticateToken(req, res, next)

            expect(res.status).toHaveBeenCalledWith(StatusCodes.UNAUTHORIZED)
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ message: 'Unauthorized' }) }))
            expect(next).not.toHaveBeenCalled()
        })

        it('returns a fixed not-found response for a disabled or absent MCP server', async () => {
            mockGetChatflowByIdAndVerifyToken.mockRejectedValue(
                new InternalFlowiseError(StatusCodes.NOT_FOUND, 'provider detail must not escape')
            )
            const req = mockReq({ headers: { authorization: `Bearer ${'c'.repeat(64)}` } })
            const res = mockRes()
            const next = mockNext()

            await mcpEndpointController.authenticateToken(req, res, next)

            expect(res.status).toHaveBeenCalledWith(StatusCodes.NOT_FOUND)
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({ error: expect.objectContaining({ message: 'MCP server not found' }) })
            )
            expect(next).not.toHaveBeenCalled()
        })

        it('forwards unexpected verification failures without exposing them in a response', async () => {
            const error = new Error('database secret')
            mockGetChatflowByIdAndVerifyToken.mockRejectedValue(error)
            const req = mockReq({ headers: { authorization: `Bearer ${'d'.repeat(64)}` } })
            const res = mockRes()
            const next = mockNext()

            await mcpEndpointController.authenticateToken(req, res, next)

            expect(next).toHaveBeenCalledWith(error)
            expect(res.status).not.toHaveBeenCalled()
        })
    })

    describe('handlePost', () => {
        it('calls the service with the middleware-bound token and ChatFlow', async () => {
            const req = mockReq({ params: { chatflowId: 'flow-123' } })
            const res = mockRes()
            const token = 'a'.repeat(64)
            const chatflow = { id: 'flow-123' }
            res.locals.mcpToken = token
            res.locals.mcpChatflow = chatflow
            const next = mockNext()
            mockHandleMcpRequest.mockResolvedValue(undefined)

            await mcpEndpointController.handlePost(req, res, next)

            expect(mockHandleMcpRequest).toHaveBeenCalledWith('flow-123', token, req, res, chatflow)
        })

        it('calls next(error) on unexpected errors', async () => {
            const req = mockReq({ params: { chatflowId: 'flow-123' } })
            const res = mockRes()
            const token = 'b'.repeat(64)
            const chatflow = { id: 'flow-123' }
            res.locals.mcpToken = token
            res.locals.mcpChatflow = chatflow
            const next = mockNext()
            const error = new Error('Unexpected')
            mockHandleMcpRequest.mockRejectedValue(error)

            await mcpEndpointController.handlePost(req, res, next)

            expect(next).toHaveBeenCalledWith(error)
        })

        it('fails closed when the verified ChatFlow context is missing or mismatched', async () => {
            const req = mockReq({ params: { chatflowId: 'flow-123' } })
            const res = mockRes()
            res.locals.mcpToken = 'c'.repeat(64)
            res.locals.mcpChatflow = { id: 'flow-other' }
            const next = mockNext()

            await mcpEndpointController.handlePost(req, res, next)

            expect(res.status).toHaveBeenCalledWith(StatusCodes.UNAUTHORIZED)
            expect(mockHandleMcpRequest).not.toHaveBeenCalled()
            expect(next).not.toHaveBeenCalled()
        })
    })

    describe('handleDelete', () => {
        it('delegates to handleMcpDeleteRequest with chatflowId', async () => {
            const req = mockReq({ params: { chatflowId: 'flow-789' } })
            const res = mockRes()
            const next = mockNext()
            mockHandleMcpDeleteRequest.mockResolvedValue(undefined)

            await mcpEndpointController.handleDelete(req, res, next)

            expect(mockHandleMcpDeleteRequest).toHaveBeenCalledWith('flow-789', req, res)
        })
    })

    describe('getRateLimiterMiddleware', () => {
        it('binds the limiter to the chatflowId route parameter', async () => {
            const req = mockReq()
            const res = mockRes()
            const next = mockNext()

            await mcpEndpointController.getRateLimiterMiddleware(req, res, next)

            expect(mockGetRateLimiterById).toHaveBeenCalledWith('flow-123')
        })
    })
})
