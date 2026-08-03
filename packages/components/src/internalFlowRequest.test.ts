import fs from 'fs'
import path from 'path'
import { secureAxiosRequest } from './httpSecurity'
import { FLOWISE_REQUEST_ERROR, requestFlowisePrediction } from './internalFlowRequest'

jest.mock('./httpSecurity', () => {
    const actual = jest.requireActual('./httpSecurity')
    return { ...actual, secureAxiosRequest: jest.fn() }
})

describe('requestFlowisePrediction', () => {
    const mockedSecureAxiosRequest = secureAxiosRequest as jest.MockedFunction<typeof secureAxiosRequest>
    const originalAppUrl = process.env.APP_URL
    const originalNodeEnv = process.env.NODE_ENV
    const flowId = '00000000-0000-4000-8000-000000000001'

    beforeEach(() => {
        process.env.APP_URL = 'https://8.8.8.8/'
        mockedSecureAxiosRequest.mockReset()
    })

    afterEach(() => {
        if (originalNodeEnv === undefined) delete process.env.NODE_ENV
        else process.env.NODE_ENV = originalNodeEnv
    })

    afterAll(() => {
        if (originalAppUrl === undefined) delete process.env.APP_URL
        else process.env.APP_URL = originalAppUrl
    })

    it('binds a Flow API key to the canonical APP_URL origin', async () => {
        mockedSecureAxiosRequest.mockResolvedValue({ status: 200, data: { text: 'ok' } } as never)

        await expect(
            requestFlowisePrediction({
                flowId,
                body: { question: 'fixture' },
                apiKey: 'internal-flow-key',
                flowiseTool: true
            })
        ).resolves.toEqual({ text: 'ok' })

        expect(mockedSecureAxiosRequest).toHaveBeenCalledTimes(1)
        const [config, maxRedirects, agentOptions, policy] = mockedSecureAxiosRequest.mock.calls[0]
        expect(config).toEqual(
            expect.objectContaining({
                method: 'POST',
                url: `https://8.8.8.8/api/v1/prediction/${flowId}`,
                headers: {
                    Authorization: 'Bearer internal-flow-key',
                    'Content-Type': 'application/json',
                    'flowise-tool': 'true'
                },
                timeout: 10 * 60 * 1000,
                maxBodyLength: 32 * 1024 * 1024,
                maxContentLength: 32 * 1024 * 1024,
                data: { question: 'fixture' }
            })
        )
        expect(maxRedirects).toBe(5)
        expect(agentOptions).toBeUndefined()
        expect(policy?.enforceDefaultDenyList).toBe(true)
        expect(() => policy?.validateUrl?.(new URL('https://1.1.1.1/redirected'))).toThrow('Request target is denied by policy.')
    })

    it('creates trusted evaluation headers and binds the request body to the same UUID', async () => {
        const evaluationRequestId = '00000000-0000-4000-8000-000000000002'
        mockedSecureAxiosRequest.mockResolvedValue({ status: 200, data: { text: 'ok' } } as never)

        await requestFlowisePrediction({
            flowId,
            body: { question: 'fixture', evaluationRunId: 'attacker-value', evaluation: false },
            apiKey: 'internal-flow-key',
            evaluationRequestId
        })

        const [config] = mockedSecureAxiosRequest.mock.calls[0]
        expect(config.headers).toEqual({
            Authorization: 'Bearer internal-flow-key',
            'Content-Type': 'application/json',
            'X-Request-ID': evaluationRequestId,
            'X-Flowise-Evaluation': 'true'
        })
        expect(config.data).toEqual({
            question: 'fixture',
            evaluationRunId: evaluationRequestId,
            evaluation: true
        })
    })

    it.each(['not-a-uuid', '', null])('rejects an invalid explicit evaluation request ID before transport: %p', async (value) => {
        await expect(
            requestFlowisePrediction({
                flowId,
                body: { question: 'fixture' },
                evaluationRequestId: value
            })
        ).rejects.toThrow(FLOWISE_REQUEST_ERROR)

        expect(mockedSecureAxiosRequest).not.toHaveBeenCalled()
    })

    it('allows an explicitly saved external origin only when no Flow API key is attached', async () => {
        mockedSecureAxiosRequest.mockResolvedValue({ status: 200, data: { text: 'external' } } as never)

        await expect(
            requestFlowisePrediction({
                configuredBaseUrl: 'https://1.1.1.1',
                flowId,
                body: { question: 'fixture' }
            })
        ).resolves.toEqual({ text: 'external' })

        const [config] = mockedSecureAxiosRequest.mock.calls[0]
        expect(config.url).toBe(`https://1.1.1.1/api/v1/prediction/${flowId}`)
        expect(config.headers).not.toHaveProperty('Authorization')
    })

    it('rejects a persisted external HTTP origin before sending the flow body', async () => {
        const errorText = await requestFlowisePrediction({
            configuredBaseUrl: 'http://8.8.4.4',
            flowId,
            body: { question: 'secret flow input' }
        }).then(
            () => '',
            (error) => String(error)
        )

        expect(errorText).toBe(`Error: ${FLOWISE_REQUEST_ERROR}`)
        expect(errorText).not.toContain('8.8.4.4')
        expect(errorText).not.toContain('secret flow input')
        expect(mockedSecureAxiosRequest).not.toHaveBeenCalled()
    })

    it.each(['development', 'test', 'production'])('rejects canonical HTTP in the %s environment', async (nodeEnv) => {
        process.env.APP_URL = 'http://8.8.8.8/'
        process.env.NODE_ENV = nodeEnv

        const errorText = await requestFlowisePrediction({
            flowId,
            body: { question: 'secret flow input' }
        }).then(
            () => '',
            (error) => String(error)
        )

        expect(errorText).toBe(`Error: ${FLOWISE_REQUEST_ERROR}`)
        expect(mockedSecureAxiosRequest).not.toHaveBeenCalled()
    })

    it('fails before transport when an internal Flow API key is paired with a non-canonical origin', async () => {
        await expect(
            requestFlowisePrediction({
                configuredBaseUrl: 'https://1.1.1.1',
                flowId,
                body: { question: 'fixture' },
                apiKey: 'internal-flow-key'
            })
        ).rejects.toThrow(FLOWISE_REQUEST_ERROR)

        expect(mockedSecureAxiosRequest).not.toHaveBeenCalled()
    })

    it('fails with one fixed error before transport when canonical APP_URL would send a Flow API key over HTTP', async () => {
        process.env.APP_URL = 'http://8.8.8.8/'

        const errorText = await requestFlowisePrediction({
            flowId,
            body: { question: 'fixture' },
            apiKey: 'internal-flow-key'
        }).then(
            () => '',
            (error) => String(error)
        )

        expect(errorText).toBe(`Error: ${FLOWISE_REQUEST_ERROR}`)
        expect(errorText).not.toContain('internal-flow-key')
        expect(errorText).not.toContain('http://8.8.8.8')
        expect(mockedSecureAxiosRequest).not.toHaveBeenCalled()
    })

    it('returns one fixed error without exposing response bodies, headers, targets, or credentials', async () => {
        mockedSecureAxiosRequest.mockResolvedValue({
            status: 500,
            statusText: 'Bearer leaked-key',
            headers: { 'set-cookie': 'secret-cookie' },
            data: { error: 'http://169.254.169.254/latest/meta-data' }
        } as never)

        const errorText = await requestFlowisePrediction({
            flowId,
            body: { question: 'fixture' },
            apiKey: 'internal-flow-key'
        }).then(
            () => '',
            (error) => String(error)
        )

        expect(errorText).toBe(`Error: ${FLOWISE_REQUEST_ERROR}`)
        expect(errorText).not.toContain('leaked-key')
        expect(errorText).not.toContain('secret-cookie')
        expect(errorText).not.toContain('169.254')
    })

    it.each([
        ['timeout', new Error('timeout after 600000ms at https://8.8.8.8')],
        ['request size', new Error('maxBodyLength exceeded by secret flow input')],
        ['response size', new Error('maxContentLength exceeded with secret response')]
    ])('returns one fixed error when the %s resource limit is enforced', async (_label, transportError) => {
        mockedSecureAxiosRequest.mockRejectedValueOnce(transportError)

        const errorText = await requestFlowisePrediction({
            flowId,
            body: { question: 'fixture' }
        }).then(
            () => '',
            (error) => String(error)
        )

        expect(errorText).toBe(`Error: ${FLOWISE_REQUEST_ERROR}`)
        expect(errorText).not.toContain(transportError.message)
    })

    it('redacts transport exceptions and rejects invalid flow IDs before transport', async () => {
        mockedSecureAxiosRequest.mockRejectedValueOnce(new Error('Bearer leaked-key to http://10.0.0.1'))

        await expect(requestFlowisePrediction({ flowId, body: { question: 'fixture' }, apiKey: 'internal-flow-key' })).rejects.toThrow(
            FLOWISE_REQUEST_ERROR
        )
        await expect(requestFlowisePrediction({ flowId: '../metadata', body: {} })).rejects.toThrow(FLOWISE_REQUEST_ERROR)
        expect(mockedSecureAxiosRequest).toHaveBeenCalledTimes(1)
    })
})

describe('internal Flowise callers never trust options.baseURL', () => {
    const callerPaths = [
        '../nodes/agentflow/ExecuteFlow/ExecuteFlow.ts',
        '../nodes/sequentialagents/ExecuteFlow/ExecuteFlow.ts',
        '../nodes/tools/AgentAsTool/AgentAsTool.ts',
        '../nodes/tools/ChatflowTool/ChatflowTool.ts',
        '../evaluation/EvaluationRunner.ts'
    ]

    it.each(callerPaths)('%s uses the common request contract without request-derived baseURL fallback', (relativePath) => {
        const source = fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8')

        expect(source).toContain('requestFlowisePrediction')
        expect(source).not.toMatch(/options\.baseURL/)
        expect(source).not.toContain('URL of the incoming request')
        expect(source).not.toContain('http://localhost:3000')
        expect(source).not.toMatch(/require\(['"]node-fetch['"]\)/)
    })
})
