import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import logger from '../../utils/logger'
import errorHandlerMiddleware from '.'

jest.mock('../../utils/logger', () => ({ __esModule: true, default: { error: jest.fn() } }))

const makeResponse = () => {
    const response = {
        setHeader: jest.fn(),
        status: jest.fn(),
        json: jest.fn()
    }
    response.status.mockReturnValue(response)
    return response
}

describe('global error response boundary', () => {
    const previousNodeEnv = process.env.NODE_ENV

    beforeEach(() => {
        process.env.NODE_ENV = 'production'
        jest.clearAllMocks()
    })

    afterAll(() => {
        process.env.NODE_ENV = previousNodeEnv
    })

    it('returns a fixed 5xx message and request ID without leaking the internal error', async () => {
        const response = makeResponse()
        await errorHandlerMiddleware(
            new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'provider secret token and database path'),
            { body: {}, method: 'POST', path: '/api/v1/fixture' } as never,
            response as never,
            jest.fn()
        )

        expect(response.json).toHaveBeenCalledWith({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            success: false,
            message: '服务器内部错误，请稍后重试',
            requestId: expect.stringMatching(/^[0-9a-f-]{36}$/)
        })
        expect(JSON.stringify(response.json.mock.calls)).not.toContain('provider secret')
        expect(logger.error).toHaveBeenCalledWith(
            expect.stringMatching(/^request_failed requestId=[0-9a-f-]{36} statusCode=500 method=POST$/)
        )
        expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('provider secret')
    })

    it('preserves an expected 4xx message and does not write an error log', async () => {
        const response = makeResponse()
        await errorHandlerMiddleware(
            new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid request fixture'),
            { body: {}, method: 'GET', path: '/api/v1/fixture' } as never,
            response as never,
            jest.fn()
        )

        expect(response.json).toHaveBeenCalledWith(
            expect.objectContaining({
                statusCode: StatusCodes.BAD_REQUEST,
                message: 'Invalid request fixture',
                requestId: expect.any(String)
            })
        )
        expect(logger.error).not.toHaveBeenCalled()
    })

    it('maps provider API-key failures to fixed Chinese copy', async () => {
        const response = makeResponse()
        await errorHandlerMiddleware(
            new InternalFlowiseError(StatusCodes.UNAUTHORIZED, '401 Incorrect API key provided: secret provider detail'),
            { body: {}, method: 'POST', path: '/api/v1/fixture' } as never,
            response as never,
            jest.fn()
        )

        expect(response.json).toHaveBeenCalledWith(
            expect.objectContaining({ statusCode: StatusCodes.UNAUTHORIZED, message: 'API 密钥无效，请检查密钥及模型访问权限。' })
        )
        expect(JSON.stringify(response.json.mock.calls)).not.toContain('secret provider detail')
    })

    it('does not emit a JSON body for streaming requests', async () => {
        const response = makeResponse()
        await errorHandlerMiddleware(
            new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'secret'),
            { body: { streaming: true }, method: 'POST', path: '/api/v1/prediction' } as never,
            response as never,
            jest.fn()
        )

        expect(response.json).not.toHaveBeenCalled()
        expect(logger.error).toHaveBeenCalledTimes(1)
    })
})
