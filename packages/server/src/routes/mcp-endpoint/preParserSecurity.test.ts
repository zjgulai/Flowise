import express, { Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import request from 'supertest'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { rejectNonCanonicalApiPath } from '../../middlewares/canonicalApiPath'
import { createMcpRequestObservability, MCP_HTTP_ROUTE } from '../../middlewares/mcpRequestObservability'

const mockGetChatflowByIdAndVerifyToken = jest.fn()
const mockHandleMcpRequest = jest.fn()
const mockAuditInfo = jest.fn()
const mockObserveHttpRequest = jest.fn()
const mockGlobalParserReached = jest.fn()

jest.mock('../../services/mcp-server', () => ({
    __esModule: true,
    default: {
        getChatflowByIdAndVerifyToken: (...args: unknown[]) => mockGetChatflowByIdAndVerifyToken(...args)
    }
}))

jest.mock('../../services/mcp-endpoint', () => ({
    __esModule: true,
    default: {
        handleMcpRequest: (...args: unknown[]) => mockHandleMcpRequest(...args),
        handleMcpDeleteRequest: jest.fn()
    }
}))

jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    },
    auditLogger: { info: (...args: unknown[]) => mockAuditInfo(...args) }
}))

import mcpRouter from '.'
import { RateLimiterManager } from '../../utils/rateLimit'

const FLOW_ID = '11111111-1111-4111-8111-111111111111'
const TOKEN = 'a'.repeat(64)
let activeRequest: Request | undefined
const app = express()
    .use((req, _res, next) => {
        activeRequest = req
        next()
    })
    .use(
        '/api/v1/mcp',
        createMcpRequestObservability(() => ({ observeHttpRequest: mockObserveHttpRequest } as never))
    )
    .use(rejectNonCanonicalApiPath)
    .use('/api/v1/mcp', mcpRouter)
    .use(express.json({ limit: '50mb' }))
    .use((req, res) => {
        mockGlobalParserReached(req.body)
        res.status(StatusCodes.NOT_FOUND).json({ message: 'global fallback' })
    })

describe('MCP pre-parser security boundary', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        activeRequest = undefined
        RateLimiterManager.getInstance().removeRateLimiter(FLOW_ID)
        mockGetChatflowByIdAndVerifyToken.mockResolvedValue({ id: FLOW_ID, mcpServerConfig: '{}' })
        mockHandleMcpRequest.mockImplementation(async (_chatflowId: unknown, _token: unknown, _req: unknown, res: Response) =>
            res.status(200).json({ ok: true })
        )
    })

    afterAll(() => {
        RateLimiterManager.getInstance().removeRateLimiter(FLOW_ID)
    })

    it('rejects a false Bearer token before parsing a large JSON body', async () => {
        mockGetChatflowByIdAndVerifyToken.mockImplementation(async () => {
            expect(activeRequest?.body).toBeUndefined()
            throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, 'credential detail must not escape')
        })
        const largePayload = JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { data: 'x'.repeat(256_000) }
        })

        const response = await request(app)
            .post(`/api/v1/mcp/${FLOW_ID}`)
            .set('Authorization', `Bearer ${TOKEN}`)
            .set('Content-Type', 'application/json')
            .send(largePayload)

        expect(response.status).toBe(StatusCodes.UNAUTHORIZED)
        expect(response.status).not.toBe(413)
        expect(mockGetChatflowByIdAndVerifyToken).toHaveBeenCalledWith(FLOW_ID, TOKEN)
        expect(mockHandleMcpRequest).not.toHaveBeenCalled()
    })

    it.each([
        { method: 'put' as const, path: `/api/v1/mcp/${FLOW_ID}` },
        { method: 'post' as const, path: `/api/v1/mcp/${FLOW_ID}/unknown` }
    ])('rejects unmatched MCP $method $path before the global JSON parser', async ({ method, path }) => {
        const largePayload = JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { data: 'x'.repeat(256_000) }
        })

        const response = await request(app)[method](path).set('Content-Type', 'application/json').send(largePayload)

        expect(response.status).toBe(StatusCodes.NOT_FOUND)
        expect(response.body).toEqual({
            jsonrpc: '2.0',
            error: {
                code: -32601,
                message: 'MCP endpoint not found'
            },
            id: null
        })
        expect(activeRequest?.body).toBeUndefined()
        expect(mockGlobalParserReached).not.toHaveBeenCalled()
        expect(mockGetChatflowByIdAndVerifyToken).not.toHaveBeenCalled()
        expect(mockHandleMcpRequest).not.toHaveBeenCalled()
    })

    it.each(['/api/v1/mcp', '/api/v1/mcp/'])('audits an id-less MCP namespace request once before the global parser: %s', async (path) => {
        const response = await request(app)
            .put(path)
            .set('Content-Type', 'application/json')
            .send({ data: 'x'.repeat(256_000) })

        expect(response.status).toBe(StatusCodes.NOT_FOUND)
        expect(activeRequest?.body).toBeUndefined()
        expect(mockGlobalParserReached).not.toHaveBeenCalled()
        expect(mockAuditInfo).toHaveBeenCalledTimes(1)
        expect(mockAuditInfo).toHaveBeenCalledWith(
            'mcp_http_request',
            expect.objectContaining({
                method: 'PUT',
                route: MCP_HTTP_ROUTE,
                statusCode: StatusCodes.NOT_FOUND,
                completion: 'finish'
            })
        )
        expect(mockObserveHttpRequest).toHaveBeenCalledTimes(1)
        expect(mockAuditInfo.mock.calls[0][1]).not.toHaveProperty('chatflowId')
    })

    it.each(['/API/V1/MCP', '/api/v1/McP/'])('audits an id-less mixed-case MCP probe once before canonical rejection: %s', async (path) => {
        const response = await request(app)
            .put(path)
            .set('Content-Type', 'application/json')
            .send({ data: 'x'.repeat(256_000) })

        expect(response.status).toBe(StatusCodes.UNAUTHORIZED)
        expect(activeRequest?.body).toBeUndefined()
        expect(mockGlobalParserReached).not.toHaveBeenCalled()
        expect(mockAuditInfo).toHaveBeenCalledTimes(1)
        expect(mockAuditInfo).toHaveBeenCalledWith(
            'mcp_http_request',
            expect.objectContaining({
                method: 'PUT',
                route: MCP_HTTP_ROUTE,
                statusCode: StatusCodes.UNAUTHORIZED,
                completion: 'finish'
            })
        )
        expect(mockObserveHttpRequest).toHaveBeenCalledTimes(1)
        expect(mockAuditInfo.mock.calls[0][1]).not.toHaveProperty('chatflowId')
    })

    it('applies the configured flow limiter using chatflowId before JSON parsing', async () => {
        await RateLimiterManager.getInstance().addRateLimiter(FLOW_ID, 60, 1, 'rate limited')
        const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' }

        const first = await request(app).post(`/api/v1/mcp/${FLOW_ID}`).set('Authorization', `Bearer ${TOKEN}`).send(body)
        const second = await request(app).post(`/api/v1/mcp/${FLOW_ID}`).set('Authorization', `Bearer ${TOKEN}`).send(body)

        expect(first.status).toBe(StatusCodes.OK)
        expect(second.status).toBe(StatusCodes.TOO_MANY_REQUESTS)
        expect(mockGetChatflowByIdAndVerifyToken).toHaveBeenCalledTimes(1)
        expect(mockHandleMcpRequest).toHaveBeenCalledTimes(1)
    })

    it.each(['/API/V1/MCP', '/api/v1/McP'])(
        'rejects non-canonical API casing before the limiter, authentication, persistence, or parsing: %s',
        async (prefix) => {
            const limiterLookup = jest.spyOn(RateLimiterManager.getInstance(), 'getRateLimiterById')
            const response = await request(app)
                .post(`${prefix}/${FLOW_ID}`)
                .set('Authorization', `Bearer ${TOKEN}`)
                .set('Content-Type', 'application/json')
                .send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))

            expect(response.status).toBe(StatusCodes.UNAUTHORIZED)
            expect(activeRequest?.body).toBeUndefined()
            expect(limiterLookup).not.toHaveBeenCalled()
            expect(mockGetChatflowByIdAndVerifyToken).not.toHaveBeenCalled()
            expect(mockHandleMcpRequest).not.toHaveBeenCalled()
            expect(mockAuditInfo).toHaveBeenCalledTimes(1)
            expect(mockAuditInfo).toHaveBeenCalledWith(
                'mcp_http_request',
                expect.objectContaining({
                    method: 'POST',
                    route: MCP_HTTP_ROUTE,
                    statusCode: StatusCodes.UNAUTHORIZED,
                    completion: 'finish'
                })
            )
            expect(mockObserveHttpRequest).toHaveBeenCalledTimes(1)
            expect(mockObserveHttpRequest).toHaveBeenCalledWith(
                expect.objectContaining({
                    method: 'POST',
                    route: MCP_HTTP_ROUTE,
                    statusCode: StatusCodes.UNAUTHORIZED
                })
            )
            expect(JSON.stringify({ audits: mockAuditInfo.mock.calls, metrics: mockObserveHttpRequest.mock.calls })).not.toContain(TOKEN)
            limiterLookup.mockRestore()
        }
    )

    it('audits and measures 200, 401, 404, 429, and 413 without recording Authorization or body content', async () => {
        const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
        const bodySentinel = 'body-content-must-not-enter-audit'

        expect((await request(app).post(`/api/v1/mcp/${FLOW_ID}`).set('Authorization', `Bearer ${TOKEN}`).send(body)).status).toBe(
            StatusCodes.OK
        )
        expect((await request(app).post(`/api/v1/mcp/${FLOW_ID}`).send(body)).status).toBe(StatusCodes.UNAUTHORIZED)

        mockGetChatflowByIdAndVerifyToken.mockRejectedValueOnce(
            new InternalFlowiseError(StatusCodes.NOT_FOUND, 'persistence detail must not escape')
        )
        expect((await request(app).post(`/api/v1/mcp/${FLOW_ID}`).set('Authorization', `Bearer ${TOKEN}`).send(body)).status).toBe(
            StatusCodes.NOT_FOUND
        )

        const oversizedBody = JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { data: bodySentinel.repeat(50_000) }
        })
        expect(
            (
                await request(app)
                    .post(`/api/v1/mcp/${FLOW_ID}`)
                    .set('Authorization', `Bearer ${TOKEN}`)
                    .set('Content-Type', 'application/json')
                    .send(oversizedBody)
            ).status
        ).toBe(StatusCodes.REQUEST_TOO_LONG)

        await RateLimiterManager.getInstance().addRateLimiter(FLOW_ID, 60, 1, 'rate limited')
        expect((await request(app).post(`/api/v1/mcp/${FLOW_ID}`).set('Authorization', `Bearer ${TOKEN}`).send(body)).status).toBe(
            StatusCodes.OK
        )
        expect((await request(app).post(`/api/v1/mcp/${FLOW_ID}`).set('Authorization', `Bearer ${TOKEN}`).send(body)).status).toBe(
            StatusCodes.TOO_MANY_REQUESTS
        )

        const auditCalls = mockAuditInfo.mock.calls.filter(([event]) => event === 'mcp_http_request')
        expect(auditCalls.map(([, metadata]) => (metadata as Record<string, unknown>).statusCode)).toEqual(
            expect.arrayContaining([
                StatusCodes.OK,
                StatusCodes.UNAUTHORIZED,
                StatusCodes.NOT_FOUND,
                StatusCodes.TOO_MANY_REQUESTS,
                StatusCodes.REQUEST_TOO_LONG
            ])
        )
        for (const [event, metadata] of auditCalls) {
            expect(event).toBe('mcp_http_request')
            expect(Object.keys(metadata as Record<string, unknown>).sort()).toEqual(
                ['completion', 'durationMs', 'method', 'requestId', 'route', 'statusCode'].sort()
            )
            expect(metadata).toEqual(
                expect.objectContaining({
                    method: 'POST',
                    route: MCP_HTTP_ROUTE,
                    completion: 'finish'
                })
            )
        }

        expect(mockObserveHttpRequest.mock.calls.map(([observation]) => observation.statusCode)).toEqual(
            auditCalls.map(([, metadata]) => (metadata as Record<string, unknown>).statusCode)
        )
        expect(
            JSON.stringify({
                audits: mockAuditInfo.mock.calls,
                metrics: mockObserveHttpRequest.mock.calls
            })
        ).not.toContain(TOKEN)
        expect(
            JSON.stringify({
                audits: mockAuditInfo.mock.calls,
                metrics: mockObserveHttpRequest.mock.calls
            })
        ).not.toContain(bodySentinel)
    })
})
