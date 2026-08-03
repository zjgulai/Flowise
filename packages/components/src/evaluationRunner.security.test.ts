import axios, { AxiosHeaders } from 'axios'
import { EvaluationRunner } from '../evaluation/EvaluationRunner'
import { FLOWISE_REQUEST_ERROR } from './internalFlowRequest'
import { isValidUUID } from './validator'

jest.mock('axios', () => {
    const actual = jest.requireActual('axios')
    return { ...actual, __esModule: true, default: jest.fn() }
})

const mockedAxios = axios as unknown as jest.Mock
const flowId = '00000000-0000-4000-8000-000000000001'

const evaluationData = (apiKey?: string) => ({
    chatflowId: JSON.stringify([flowId]),
    evaluationId: 'evaluation-fixture',
    dataset: { rows: [{ input: 'fixture question', output: 'fixture answer', sequenceNo: 1 }] },
    ...(apiKey ? { apiKeys: [{ chatflowId: flowId, apiKey }] } : {})
})

describe('EvaluationRunner internal prediction security', () => {
    const originalAppUrl = process.env.APP_URL

    beforeEach(() => {
        process.env.APP_URL = 'https://8.8.8.8/'
        mockedAxios.mockReset()
    })

    afterAll(() => {
        if (originalAppUrl === undefined) delete process.env.APP_URL
        else process.env.APP_URL = originalAppUrl
    })

    it('ignores the constructor URL and sends trusted evaluation headers only to canonical APP_URL', async () => {
        mockedAxios.mockResolvedValueOnce({ status: 200, headers: {}, data: { text: 'ok' } })

        const result = await new EvaluationRunner('https://attacker.example').runEvaluations(evaluationData('flow-api-key'))

        expect(result.rows[0].evaluations[0]).toEqual(expect.objectContaining({ status: 'complete', actualOutput: 'ok' }))
        expect(mockedAxios).toHaveBeenCalledTimes(1)
        const config = mockedAxios.mock.calls[0][0]
        const headers = AxiosHeaders.from(config.headers)
        const evaluationRequestId = headers.get('X-Request-ID') as string
        expect(config.url).toBe(`https://8.8.8.8/api/v1/prediction/${flowId}`)
        expect(config.url).not.toContain('attacker.example')
        expect(headers.get('Authorization')).toBe('Bearer flow-api-key')
        expect(headers.get('X-Flowise-Evaluation')).toBe('true')
        expect(isValidUUID(evaluationRequestId)).toBe(true)
        expect(config.data).toEqual({
            question: 'fixture question',
            evaluationRunId: evaluationRequestId,
            evaluation: true
        })
        expect(config).toEqual(expect.objectContaining({ maxRedirects: 0, proxy: false }))
    })

    it('blocks a private canonical target before transport even without an API key', async () => {
        process.env.APP_URL = 'http://127.0.0.1:3000/'

        const result = await new EvaluationRunner('https://attacker.example').runEvaluations(evaluationData())

        expect(mockedAxios).not.toHaveBeenCalled()
        expect(result.rows[0].evaluations[0]).toEqual(
            expect.objectContaining({ status: 'error', actualOutput: '', error: FLOWISE_REQUEST_ERROR })
        )
    })

    it('rejects a cross-origin redirect before forwarding the API key or evaluation headers', async () => {
        const destroy = jest.fn()
        mockedAxios.mockResolvedValueOnce({
            status: 307,
            headers: { location: 'https://1.1.1.1/redirected' },
            data: { destroy }
        })

        const result = await new EvaluationRunner('https://attacker.example').runEvaluations(evaluationData('flow-api-key'))

        expect(mockedAxios).toHaveBeenCalledTimes(1)
        expect(destroy).toHaveBeenCalledTimes(1)
        expect(result.rows[0].evaluations[0]).toEqual(
            expect.objectContaining({ status: 'error', actualOutput: '', error: FLOWISE_REQUEST_ERROR })
        )
        expect(JSON.stringify(result)).not.toContain('1.1.1.1')
        expect(JSON.stringify(result)).not.toContain('flow-api-key')
    })

    it('stores only a fixed error when the transport throws secret-bearing details', async () => {
        mockedAxios.mockRejectedValueOnce(new Error('Bearer leaked-key at http://169.254.169.254/latest/meta-data'))

        const result = await new EvaluationRunner('https://attacker.example').runEvaluations(evaluationData('flow-api-key'))

        expect(result.rows[0].evaluations[0]).toEqual(
            expect.objectContaining({ status: 'error', actualOutput: '', error: FLOWISE_REQUEST_ERROR })
        )
        expect(JSON.stringify(result)).not.toContain('leaked-key')
        expect(JSON.stringify(result)).not.toContain('169.254.169.254')
    })
})
