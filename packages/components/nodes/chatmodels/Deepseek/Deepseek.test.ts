import { Response } from 'node-fetch'
import { getCredentialData, getCredentialParam } from '../../../src/utils'
import { getModels } from '../../../src/modelLoader'
import { secureFetch } from '../../../src/httpSecurity'

jest.mock('../../../src/utils', () => ({
    getBaseClasses: jest.fn().mockReturnValue(['BaseChatModel']),
    getCredentialData: jest.fn(),
    getCredentialParam: jest.fn()
}))

jest.mock('../../../src/modelLoader', () => ({
    MODEL_TYPE: { CHAT: 'chat' },
    getModels: jest.fn()
}))

jest.mock('../../../src/httpSecurity', () => ({
    secureFetch: jest.fn()
}))

const { nodeClass: Deepseek } = require('./Deepseek')

const API_KEY = 'deepseek-fixture-key'
const originalFetch = (globalThis as any).fetch

function completionResponse(content = 'mocked deepseek response') {
    return new Response(
        JSON.stringify({
            id: 'chatcmpl-deepseek-1',
            object: 'chat.completion',
            created: 1,
            model: 'deepseek-v4-flash',
            choices: [
                {
                    index: 0,
                    message: { role: 'assistant', content, reasoning_content: 'mocked reasoning' },
                    finish_reason: 'stop'
                }
            ],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
    )
}

function baseNodeData(inputs: Record<string, unknown> = {}) {
    return {
        credential: 'deepseek-credential',
        inputs: {
            modelName: 'deepseek-v4-flash',
            streaming: false,
            ...inputs
        }
    }
}

describe('Deepseek provider contract', () => {
    beforeAll(() => {
        ;(globalThis as any).fetch = jest.fn().mockRejectedValue(new Error('UNEXPECTED_GLOBAL_FETCH'))
    })

    afterAll(() => {
        ;(globalThis as any).fetch = originalFetch
    })

    beforeEach(() => {
        jest.clearAllMocks()
        ;(getCredentialData as jest.Mock).mockResolvedValue({ deepseekApiKey: API_KEY })
        ;(getCredentialParam as jest.Mock).mockImplementation((name, data) => data[name])
    })

    it('exposes required credential without unsupported reasoning controls', () => {
        const node = new Deepseek()
        const modelInput = node.inputs.find((input: any) => input.name === 'modelName')
        const basePathInput = node.inputs.find((input: any) => input.name === 'basepath')
        const maxTokensInput = node.inputs.find((input: any) => input.name === 'maxTokens')
        const timeoutInput = node.inputs.find((input: any) => input.name === 'timeout')

        expect(node.credential.credentialNames).toEqual(['deepseekApi'])
        expect(node.credential.optional).not.toBe(true)
        expect(modelInput.default).toBe('deepseek-v4-flash')
        expect(basePathInput.default).toBe('https://api.deepseek.com')
        expect(maxTokensInput.description).toBeUndefined()
        expect(timeoutInput.description).toBe('Request timeout in milliseconds.')
        expect(node.inputs.map((input: any) => input.name)).toEqual(expect.arrayContaining(['baseOptions']))
        expect(node.inputs.map((input: any) => input.name)).not.toEqual(expect.arrayContaining(['thinking', 'reasoningEffort']))
    })

    it('loads Deepseek models through the shared catalog', async () => {
        ;(getModels as jest.Mock).mockResolvedValue([{ label: 'deepseek-v4-flash', name: 'deepseek-v4-flash' }])

        const node = new Deepseek()
        const models = await node.loadMethods.listModels()

        expect(getModels).toHaveBeenCalledWith('chat', 'deepseek')
        expect(models).toEqual([{ label: 'deepseek-v4-flash', name: 'deepseek-v4-flash' }])
    })

    it('maps credentials, numeric options, stop words, headers, disabled thinking, and secure transport', async () => {
        const node = new Deepseek()
        const model = await node.init(
            baseNodeData({
                credentialId: 'override-credential',
                temperature: '0.2',
                maxTokens: '4096',
                topP: '0.8',
                frequencyPenalty: '0.1',
                presencePenalty: '0.2',
                timeout: '2500',
                stopSequence: 'END, STOP',
                baseOptions: '{"X-Trace-Mode":"test"}'
            }),
            '',
            {}
        )

        expect(getCredentialData).toHaveBeenCalledWith('override-credential', {})
        expect((model as any).apiKey).toBe(API_KEY)
        expect((model as any).model).toBe('deepseek-v4-flash')
        expect((model as any).temperature).toBe(0.2)
        expect((model as any).maxTokens).toBe(4096)
        expect((model as any).topP).toBe(0.8)
        expect((model as any).frequencyPenalty).toBe(0.1)
        expect((model as any).presencePenalty).toBe(0.2)
        expect((model as any).timeout).toBe(2500)
        expect((model as any).stop).toEqual(['END', 'STOP'])
        expect((model as any).modelKwargs).toEqual({ thinking: { type: 'disabled' } })
        expect((model as any).clientConfig.baseURL).toBe('https://api.deepseek.com')
        expect((model as any).clientConfig.defaultHeaders).toEqual({ 'X-Trace-Mode': 'test' })
        expect((model as any).clientConfig.fetch).toEqual(expect.any(Function))
    })

    it('sends the expected non-stream request through secureFetch', async () => {
        ;(secureFetch as jest.Mock).mockResolvedValue(completionResponse())
        const node = new Deepseek()
        const model = await node.init(baseNodeData(), '', {})

        const response = await model.invoke('hello deepseek')

        expect(response.content).toBe('mocked deepseek response')
        expect(secureFetch).toHaveBeenCalledTimes(1)
        const [url, init] = (secureFetch as jest.Mock).mock.calls[0]
        expect(url).toBe('https://api.deepseek.com/chat/completions')
        expect(JSON.parse(init.body)).toMatchObject({
            model: 'deepseek-v4-flash',
            stream: false,
            thinking: { type: 'disabled' },
            messages: [{ role: 'user', content: 'hello deepseek' }]
        })
        expect((globalThis as any).fetch).not.toHaveBeenCalled()
    })

    it('enforces timeout with one secure transport attempt', async () => {
        let requestSignal: AbortSignal | undefined
        let watchdog: ReturnType<typeof setTimeout> | undefined
        ;(secureFetch as jest.Mock).mockImplementation((_url, init) => {
            return new Promise((_resolve, reject) => {
                const signal = init?.signal
                if (!signal) return reject(new Error('missing abort signal'))
                requestSignal = signal
                const abort = () => {
                    const error = new Error('request aborted')
                    error.name = 'AbortError'
                    reject(error)
                }
                watchdog = setTimeout(() => reject(new Error(`timeout watchdog: signal.aborted=${signal.aborted}`)), 250)
                if (signal.aborted) abort()
                else signal.addEventListener('abort', abort, { once: true })
            })
        })
        const node = new Deepseek()
        const model = await node.init(baseNodeData({ timeout: '20' }), '', {})

        try {
            await expect(model.invoke('timeout')).rejects.toThrow()
        } finally {
            if (watchdog) clearTimeout(watchdog)
        }
        expect(requestSignal?.aborted).toBe(true)
        expect(secureFetch).toHaveBeenCalledTimes(1)
    })

    it('does not include the credential value in a provider 401 error', async () => {
        ;(secureFetch as jest.Mock).mockResolvedValue(
            new Response(JSON.stringify({ error: { message: 'invalid API key', type: 'authentication_error', code: 'invalid_api_key' } }), {
                status: 401,
                headers: { 'content-type': 'application/json' }
            })
        )
        const node = new Deepseek()
        const model = await node.init(baseNodeData(), '', {})

        let errorText = ''
        try {
            await model.invoke('unauthorized')
        } catch (error) {
            errorText = String(error)
        }
        expect(errorText).toContain('401')
        expect(errorText).not.toContain(API_KEY)
    })

    it('rejects missing credentials without falling back to process environment', async () => {
        ;(getCredentialParam as jest.Mock).mockReturnValue(undefined)
        const node = new Deepseek()

        await expect(node.init(baseNodeData(), '', {})).rejects.toThrow('Deepseek API key is required')
    })

    it.each(['http://api.deepseek.com', 'https://127.0.0.1/v1', 'https://example.com/v1'])(
        'rejects disallowed Base Path %s',
        async (basepath) => {
            const node = new Deepseek()

            await expect(node.init(baseNodeData({ basepath }), '', {})).rejects.toThrow(/Base Path/)
        }
    )

    it('rejects malformed headers and numeric values before model creation', async () => {
        const node = new Deepseek()

        await expect(node.init(baseNodeData({ baseOptions: '{bad json' }), '', {})).rejects.toThrow(/Base Options/)
        await expect(node.init(baseNodeData({ timeout: '20seconds' }), '', {})).rejects.toThrow(/Timeout/)
    })

    it.each([{ thinking: true }, { reasoningEffort: 'high' }, { modelName: 'deepseek-reasoner' }])(
        'fails closed on unsupported reasoning configuration %#',
        async (inputs) => {
            const node = new Deepseek()

            await expect(node.init(baseNodeData(inputs), '', {})).rejects.toThrow(/reasoning|thinking/i)
            expect(getCredentialData).not.toHaveBeenCalled()
        }
    )

    it.each(['-0.1', '2.1'])('rejects Deepseek temperature outside 0..2: %s', async (temperature) => {
        const node = new Deepseek()

        await expect(node.init(baseNodeData({ temperature }), '', {})).rejects.toThrow(/Temperature/)
    })

    it.each([429, 500])('performs one transport attempt for HTTP %s', async (status) => {
        ;(secureFetch as jest.Mock).mockResolvedValue(
            new Response(JSON.stringify({ error: { message: 'fixture failure' } }), {
                status,
                headers: { 'content-type': 'application/json' }
            })
        )
        const node = new Deepseek()
        const model = await node.init(baseNodeData(), '', {})

        await expect(model.invoke('single attempt')).rejects.toThrow()
        expect(secureFetch).toHaveBeenCalledTimes(1)
    })
})
