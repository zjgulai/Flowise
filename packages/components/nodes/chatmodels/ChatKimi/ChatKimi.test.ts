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

const { nodeClass: ChatKimi } = require('./ChatKimi')
const { credClass: KimiApi } = require('../../../credentials/KimiApi.credential')

const API_KEY = 'kimi-fixture-key'
const originalFetch = (globalThis as any).fetch

function completionResponse(content = 'mocked kimi response') {
    return new Response(
        JSON.stringify({
            id: 'chatcmpl-kimi-1',
            object: 'chat.completion',
            created: 1,
            model: 'kimi-k2.6',
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
    )
}

function baseNodeData(inputs: Record<string, unknown> = {}) {
    return {
        credential: 'kimi-credential',
        inputs: {
            modelName: 'kimi-k2.6',
            streaming: false,
            ...inputs
        }
    }
}

describe('Kimi provider contract', () => {
    beforeAll(() => {
        ;(globalThis as any).fetch = jest.fn().mockRejectedValue(new Error('UNEXPECTED_GLOBAL_FETCH'))
    })

    afterAll(() => {
        ;(globalThis as any).fetch = originalFetch
    })

    beforeEach(() => {
        jest.clearAllMocks()
        ;(getCredentialData as jest.Mock).mockResolvedValue({ kimiApiKey: API_KEY })
        ;(getCredentialParam as jest.Mock).mockImplementation((name, data) => data[name])
    })

    it('exposes a required Kimi credential without an unsupported thinking control', () => {
        const node = new ChatKimi()
        const modelInput = node.inputs.find((input: any) => input.name === 'modelName')

        expect(node.credential.credentialNames).toEqual(['kimiApi'])
        expect(node.credential.optional).not.toBe(true)
        expect(modelInput.default).toBe('kimi-k2.6')
        expect(node.inputs.map((input: any) => input.name)).toEqual(expect.arrayContaining(['basepath', 'baseOptions']))
        expect(node.inputs.map((input: any) => input.name)).not.toContain('thinking')
    })

    it('defines exactly one password credential field', () => {
        const credential = new KimiApi()

        expect(credential.name).toBe('kimiApi')
        expect(credential.inputs).toEqual([{ label: 'Kimi API Key', name: 'kimiApiKey', type: 'password' }])
    })

    it('loads Kimi models through the shared catalog', async () => {
        ;(getModels as jest.Mock).mockResolvedValue([{ label: 'kimi-k2.6', name: 'kimi-k2.6' }])
        const node = new ChatKimi()

        expect(await node.loadMethods.listModels()).toEqual([{ label: 'kimi-k2.6', name: 'kimi-k2.6' }])
        expect(getModels).toHaveBeenCalledWith('chat', 'kimi')
    })

    it('maps supported inputs and secure client configuration', async () => {
        const node = new ChatKimi()
        const model = await node.init(
            baseNodeData({
                temperature: '0.6',
                maxTokens: '2048',
                timeout: '3000',
                thinking: false,
                baseOptions: { 'X-Trace-Mode': 'test' }
            }),
            '',
            {}
        )

        expect((model as any).apiKey).toBe(API_KEY)
        expect((model as any).model).toBe('kimi-k2.6')
        expect((model as any).temperature).toBe(0.6)
        expect((model as any).maxTokens).toBeUndefined()
        expect((model as any).timeout).toBe(3000)
        expect((model as any).modelKwargs).toMatchObject({ thinking: { type: 'disabled' }, max_completion_tokens: 2048 })
        expect((model as any).clientConfig.baseURL).toBe('https://api.moonshot.cn/v1')
        expect((model as any).clientConfig.defaultHeaders).toEqual({ 'X-Trace-Mode': 'test' })
        expect((model as any).clientConfig.fetch).toEqual(expect.any(Function))
    })

    it('sends a non-streaming request through secureFetch', async () => {
        ;(secureFetch as jest.Mock).mockImplementation(() => Promise.resolve(completionResponse()))
        const node = new ChatKimi()
        const model = await node.init(baseNodeData({ maxTokens: '2048' }), '', {})

        const response = await model.invoke('hello kimi')

        expect(response.content).toBe('mocked kimi response')
        const [url, init] = (secureFetch as jest.Mock).mock.calls[0]
        expect(url).toBe('https://api.moonshot.cn/v1/chat/completions')
        expect(JSON.parse(init.body)).toMatchObject({
            model: 'kimi-k2.6',
            stream: false,
            thinking: { type: 'disabled' },
            max_completion_tokens: 2048,
            messages: [{ role: 'user', content: 'hello kimi' }]
        })
        expect(JSON.parse(init.body)).not.toHaveProperty('max_tokens')
        expect((globalThis as any).fetch).not.toHaveBeenCalled()
    })

    it('supports streaming SSE through the secure transport', async () => {
        const sse = [
            'data: {"id":"chunk-1","object":"chat.completion.chunk","created":1,"model":"kimi-k2.6","choices":[{"index":0,"delta":{"role":"assistant","content":"hello"},"finish_reason":null}]}',
            '',
            'data: {"id":"chunk-1","object":"chat.completion.chunk","created":1,"model":"kimi-k2.6","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":"stop"}]}',
            '',
            'data: [DONE]',
            ''
        ].join('\n')
        ;(secureFetch as jest.Mock).mockResolvedValue(
            new globalThis.Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
        )
        const node = new ChatKimi()
        const model = await node.init(baseNodeData({ streaming: true }), '', {})

        let text = ''
        for await (const chunk of await model.stream('stream kimi')) text += chunk.content

        expect(text).toContain('hello world')
        expect(JSON.parse((secureFetch as jest.Mock).mock.calls[0][1].body)).toMatchObject({ stream: true })
    })

    it('maps bound tools to the OpenAI-compatible request', async () => {
        ;(secureFetch as jest.Mock).mockResolvedValue(completionResponse('tool-ready'))
        const node = new ChatKimi()
        const model = await node.init(baseNodeData(), '', {})
        const withTools = model.bindTools([
            {
                type: 'function',
                function: {
                    name: 'get_weather',
                    description: 'Get weather',
                    parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }
                }
            }
        ])

        await withTools.invoke('weather')

        const body = JSON.parse((secureFetch as jest.Mock).mock.calls[0][1].body)
        expect(body.tools[0].function.name).toBe('get_weather')
    })

    it('propagates cancellation to secureFetch', async () => {
        let resolveTransportStarted!: () => void
        const transportStarted = new Promise<void>((resolve) => {
            resolveTransportStarted = resolve
        })
        ;(secureFetch as jest.Mock).mockImplementation((_url, init) => {
            return new Promise((_resolve, reject) => {
                const signal = init?.signal
                if (!signal) return reject(new Error('missing abort signal'))
                resolveTransportStarted()
                const abort = () => {
                    const error = new Error('request aborted')
                    error.name = 'AbortError'
                    reject(error)
                }
                if (signal.aborted) abort()
                else signal.addEventListener('abort', abort, { once: true })
            })
        })
        const node = new ChatKimi()
        const model = await node.init(baseNodeData({ timeout: '1000' }), '', {})
        const controller = new AbortController()
        const request = model.invoke('cancel kimi', { signal: controller.signal })

        await transportStarted
        controller.abort()

        await expect(request).rejects.toThrow()
        expect(secureFetch).toHaveBeenCalledTimes(1)
    })

    it('does not include the credential value in a provider 401 error', async () => {
        ;(secureFetch as jest.Mock).mockResolvedValue(
            new Response(JSON.stringify({ error: { message: 'invalid API key', type: 'authentication_error', code: 'invalid_api_key' } }), {
                status: 401,
                headers: { 'content-type': 'application/json' }
            })
        )
        const node = new ChatKimi()
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

    it('rejects missing credentials instead of falling back to OPENAI_API_KEY', async () => {
        ;(getCredentialParam as jest.Mock).mockReturnValue(undefined)
        const node = new ChatKimi()

        await expect(node.init(baseNodeData(), '', {})).rejects.toThrow('Kimi API key is required')
    })

    it.each([
        ['kimi-k2.6', { temperature: '1' }, /temperature/i],
        ['kimi-k2.5', { topP: '0.8' }, /Top Probability/i],
        ['kimi-k2.5', { frequencyPenalty: '0.1' }, /Frequency Penalty/i],
        ['kimi-k2.5', { presencePenalty: '0.1' }, /Presence Penalty/i]
    ])('rejects invalid non-thinking fixed parameters for %s %#', async (modelName, invalidInputs, message) => {
        const node = new ChatKimi()

        await expect(node.init(baseNodeData({ modelName, ...invalidInputs }), '', {})).rejects.toThrow(message)
    })

    it.each(['kimi-k2.6', 'kimi-k2.5'])('accepts documented non-thinking parameters for %s', async (modelName) => {
        const node = new ChatKimi()

        await expect(
            node.init(
                baseNodeData({
                    modelName,
                    temperature: '0.6',
                    topP: '0.95',
                    frequencyPenalty: '0',
                    presencePenalty: '0'
                }),
                '',
                {}
            )
        ).resolves.toBeDefined()
    })

    it.each([{ thinking: true }, { modelName: 'kimi-k2.7-code' }, { modelName: 'kimi-k2.7-code-highspeed' }])(
        'fails closed on unsupported Kimi reasoning configuration %#',
        async (inputs) => {
            const node = new ChatKimi()

            await expect(node.init(baseNodeData(inputs), '', {})).rejects.toThrow(/reasoning|thinking/i)
            expect(getCredentialData).not.toHaveBeenCalled()
        }
    )

    it('sends explicit disabled thinking for Kimi K2.5 and K2.6', async () => {
        ;(secureFetch as jest.Mock).mockImplementation(() => Promise.resolve(completionResponse()))
        const node = new ChatKimi()

        for (const modelName of ['kimi-k2.5', 'kimi-k2.6']) {
            const model = await node.init(baseNodeData({ modelName }), '', {})
            await model.invoke('non-thinking')
            const body = JSON.parse((secureFetch as jest.Mock).mock.calls.at(-1)[1].body)
            expect(body.thinking).toEqual({ type: 'disabled' })
        }
    })

    it.each(['http://api.moonshot.cn/v1', 'https://169.254.169.254/v1', 'https://example.com/v1'])(
        'rejects disallowed Base Path %s',
        async (basepath) => {
            const node = new ChatKimi()
            await expect(node.init(baseNodeData({ basepath }), '', {})).rejects.toThrow(/Base Path/)
        }
    )

    it('rejects malformed headers and numeric values', async () => {
        const node = new ChatKimi()

        await expect(node.init(baseNodeData({ baseOptions: '{bad json' }), '', {})).rejects.toThrow(/Base Options/)
        await expect(node.init(baseNodeData({ maxTokens: '2048tokens' }), '', {})).rejects.toThrow(/Max Tokens/)
    })

    it.each(['-0.1', '1.1'])('rejects Moonshot V1 temperature outside 0..1: %s', async (temperature) => {
        const node = new ChatKimi()

        await expect(node.init(baseNodeData({ modelName: 'moonshot-v1-8k', temperature }), '', {})).rejects.toThrow(/Temperature/)
    })
})
