import { Response } from 'node-fetch'
import { checkDenyList, secureFetch } from '../../src/httpSecurity'
import { getCredentialData, getCredentialParam } from '../../src/utils'

const mockChatCloudflareWorkersAI = jest.fn().mockImplementation(function (this: Record<string, unknown>, fields: object) {
    Object.assign(this, fields)
})
const mockLangchainChatOpenAI = jest.fn()
const mockFlowiseChatGoogleGenerativeAI = jest.fn()
const mockFlowiseChatOpenAI = jest.fn().mockImplementation(() => ({ setMultiModalOption: jest.fn() }))
const mockFlowiseChatOllama = jest.fn().mockImplementation(() => ({ setMultiModalOption: jest.fn() }))
const mockLlamaIndexOllama = jest.fn()
const mockNemoClient = jest.fn()

jest.mock('../../src/httpSecurity', () => ({
    checkDenyList: jest.fn(),
    secureFetch: jest.fn()
}))

jest.mock('../../src/utils', () => ({
    getBaseClasses: jest.fn().mockReturnValue(['BaseChatModel']),
    getCredentialData: jest.fn(),
    getCredentialParam: jest.fn()
}))

jest.mock('../../src', () => ({
    getBaseClasses: jest.fn().mockReturnValue(['BaseChatModel'])
}))

jest.mock('../../src/modelLoader', () => ({
    MODEL_TYPE: { CHAT: 'chat' },
    getModels: jest.fn()
}))

jest.mock('@langchain/cloudflare', () => ({
    ChatCloudflareWorkersAI: mockChatCloudflareWorkersAI
}))

jest.mock('@langchain/openai', () => ({
    ChatOpenAI: mockLangchainChatOpenAI
}))

jest.mock('@google/generative-ai', () => ({
    HarmBlockThreshold: {
        BLOCK_NONE: 'BLOCK_NONE',
        BLOCK_ONLY_HIGH: 'BLOCK_ONLY_HIGH',
        BLOCK_MEDIUM_AND_ABOVE: 'BLOCK_MEDIUM_AND_ABOVE',
        BLOCK_LOW_AND_ABOVE: 'BLOCK_LOW_AND_ABOVE',
        HARM_BLOCK_THRESHOLD_UNSPECIFIED: 'HARM_BLOCK_THRESHOLD_UNSPECIFIED'
    },
    HarmCategory: {
        HARM_CATEGORY_DANGEROUS_CONTENT: 'HARM_CATEGORY_DANGEROUS_CONTENT',
        HARM_CATEGORY_HARASSMENT: 'HARM_CATEGORY_HARASSMENT',
        HARM_CATEGORY_HATE_SPEECH: 'HARM_CATEGORY_HATE_SPEECH',
        HARM_CATEGORY_SEXUALLY_EXPLICIT: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
        HARM_CATEGORY_CIVIC_INTEGRITY: 'HARM_CATEGORY_CIVIC_INTEGRITY'
    }
}))

jest.mock('./ChatGoogleGenerativeAI/FlowiseChatGoogleGenerativeAI', () => ({
    ChatGoogleGenerativeAI: mockFlowiseChatGoogleGenerativeAI
}))

jest.mock('./ChatOpenAI/FlowiseChatOpenAI', () => ({
    ChatOpenAI: mockFlowiseChatOpenAI
}))

jest.mock('./ChatOllama/FlowiseChatOllama', () => ({
    ChatOllama: mockFlowiseChatOllama
}))

jest.mock('llamaindex', () => ({
    Ollama: mockLlamaIndexOllama
}))

jest.mock('./ChatNemoGuardrails/NemoClient', () => ({
    NemoClient: mockNemoClient
}))

const { nodeClass: ChatCloudflareWorkersAI } = require('./ChatCloudflareWorkersAI/ChatCloudflareWorkersAI')
const { nodeClass: ChatGoogleGenerativeAI } = require('./ChatGoogleGenerativeAI/ChatGoogleGenerativeAI')
const { nodeClass: ChatLitellm } = require('./ChatLitellm/ChatLitellm')
const { nodeClass: ChatLocalAI } = require('./ChatLocalAI/ChatLocalAI')
const { nodeClass: ChatNemoGuardrails } = require('./ChatNemoGuardrails/ChatNemoGuardrails')
const { nodeClass: ChatNvdiaNIM } = require('./ChatNvdiaNIM/ChatNvdiaNIM')
const { nodeClass: ChatOllama } = require('./ChatOllama/ChatOllama')
const { nodeClass: ChatOllamaLlamaIndex } = require('./ChatOllama/ChatOllama_LlamaIndex')
const { nodeClass: ChatOpenAICustom } = require('./ChatOpenAICustom/ChatOpenAICustom')

const DENIED_URL = 'http://127.0.0.1:9999/v1'
const DENIED_ERROR = new Error('Access to this host is denied by policy.')
const CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef'
const CLOUDFLARE_OFFICIAL_BASE_URL = `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run`
const GOOGLE_OFFICIAL_BASE_URL = 'https://generativelanguage.googleapis.com'

function nodeData(inputName: string, value: string, extraInputs: Record<string, unknown> = {}) {
    return {
        id: 'chat-model-fixture',
        credential: 'credential-fixture',
        inputs: {
            configurationId: 'configuration-fixture',
            model: '@cf/meta/model-fixture',
            modelName: 'model-fixture',
            [inputName]: value,
            ...extraInputs
        }
    }
}

describe('custom chat model base URL deny-list enforcement', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        delete process.env.CLOUDFLARE_WORKERS_AI_BASE_URL_ALLOWLIST
        delete process.env.HTTP_SECURITY_CHECK
        ;(checkDenyList as jest.Mock).mockRejectedValue(DENIED_ERROR)
        ;(getCredentialData as jest.Mock).mockResolvedValue({
            cloudflareAccountId: CLOUDFLARE_ACCOUNT_ID,
            cloudflareApiToken: 'token-fixture',
            litellmApiKey: 'token-fixture',
            localAIApiKey: 'token-fixture',
            nvidiaNIMApiKey: 'token-fixture',
            ollamaApiKey: 'token-fixture',
            openAIApiKey: 'token-fixture'
        })
        ;(getCredentialParam as jest.Mock).mockImplementation((name: string, data: Record<string, unknown>) => data[name])
    })

    const deniedCases: Array<[string, any, string, jest.Mock, string]> = [
        ['Cloudflare Workers AI', ChatCloudflareWorkersAI, 'baseUrl', mockChatCloudflareWorkersAI, CLOUDFLARE_OFFICIAL_BASE_URL],
        ['Google Gemini', ChatGoogleGenerativeAI, 'baseUrl', mockFlowiseChatGoogleGenerativeAI, GOOGLE_OFFICIAL_BASE_URL],
        ['LiteLLM', ChatLitellm, 'basePath', mockFlowiseChatOpenAI, DENIED_URL],
        ['LocalAI', ChatLocalAI, 'basePath', mockLangchainChatOpenAI, DENIED_URL],
        ['Nemo Guardrails', ChatNemoGuardrails, 'baseUrl', mockNemoClient, DENIED_URL],
        ['Nvidia NIM', ChatNvdiaNIM, 'basePath', mockLangchainChatOpenAI, DENIED_URL],
        ['Ollama', ChatOllama, 'baseUrl', mockFlowiseChatOllama, DENIED_URL],
        ['Ollama LlamaIndex', ChatOllamaLlamaIndex, 'baseUrl', mockLlamaIndexOllama, DENIED_URL],
        ['OpenAI Custom', ChatOpenAICustom, 'basepath', mockLangchainChatOpenAI, DENIED_URL]
    ]

    it.each(deniedCases)(
        'rejects a denied %s base URL before model creation',
        async (_label, NodeClass, inputName, modelConstructor, deniedUrl) => {
            const node = new NodeClass()

            await expect(node.init(nodeData(inputName, deniedUrl), '', {})).rejects.toBe(DENIED_ERROR)
            expect(checkDenyList).toHaveBeenCalledTimes(1)
            expect(checkDenyList).toHaveBeenCalledWith(deniedUrl)
            expect(modelConstructor).not.toHaveBeenCalled()
        }
    )

    it('checks the effective Ollama default when the input is omitted', async () => {
        const node = new ChatOllama()

        await expect(node.init(nodeData('unused', ''), '', {})).rejects.toBe(DENIED_ERROR)
        expect(checkDenyList).toHaveBeenCalledTimes(1)
        expect(checkDenyList).toHaveBeenCalledWith('http://localhost:11434')
        expect(mockFlowiseChatOllama).not.toHaveBeenCalled()
    })

    it('constructs Ollama after an allowed public base URL passes the policy check', async () => {
        const publicBaseUrl = 'https://models.example.com/v1'
        ;(checkDenyList as jest.Mock).mockResolvedValue(undefined)
        ;(secureFetch as jest.Mock).mockResolvedValue(new Response('{}', { status: 200 }))
        const node = new ChatOllama()

        await expect(node.init(nodeData('baseUrl', publicBaseUrl), '', {})).resolves.toBeDefined()
        expect(checkDenyList).toHaveBeenCalledTimes(1)
        expect(checkDenyList).toHaveBeenCalledWith(publicBaseUrl)
        expect(mockFlowiseChatOllama).toHaveBeenCalledTimes(1)
        expect(mockFlowiseChatOllama.mock.calls[0][1]).toMatchObject({
            baseUrl: publicBaseUrl,
            model: 'model-fixture',
            fetch: expect.any(Function)
        })
        await mockFlowiseChatOllama.mock.calls[0][1].fetch(`${publicBaseUrl}/api/chat`, { method: 'POST', body: '{}' })
        expect(secureFetch).toHaveBeenCalledWith(
            `${publicBaseUrl}/api/chat`,
            expect.objectContaining({ method: 'POST' }),
            5,
            undefined,
            expect.objectContaining({ enforceDefaultDenyList: false, validateUrl: expect.any(Function) })
        )
    })

    it.each([
        ['LiteLLM', ChatLitellm, 'basePath', mockFlowiseChatOpenAI, 1],
        ['LocalAI', ChatLocalAI, 'basePath', mockLangchainChatOpenAI, 0],
        ['Nvidia NIM', ChatNvdiaNIM, 'basePath', mockLangchainChatOpenAI, 0],
        ['OpenAI Custom', ChatOpenAICustom, 'basepath', mockLangchainChatOpenAI, 0]
    ])('injects an origin-bound transport into %s', async (_label, NodeClass, inputName, constructor, fieldsIndex) => {
        const publicBaseUrl = 'https://models.example.com/v1'
        ;(checkDenyList as jest.Mock).mockResolvedValue(undefined)
        ;(secureFetch as jest.Mock).mockResolvedValue(new Response('{}', { status: 200 }))
        const node = new NodeClass()

        await node.init(nodeData(inputName as string, publicBaseUrl), '', {})
        const fields = constructor.mock.calls[0][fieldsIndex as number]
        expect(fields.configuration).toMatchObject({ baseURL: publicBaseUrl, fetch: expect.any(Function) })

        await fields.configuration.fetch(`${publicBaseUrl}/chat/completions`, { method: 'POST', body: '{}' })
        expect(secureFetch).toHaveBeenCalledWith(
            `${publicBaseUrl}/chat/completions`,
            expect.objectContaining({ method: 'POST' }),
            5,
            undefined,
            expect.objectContaining({ enforceDefaultDenyList: false, validateUrl: expect.any(Function) })
        )
    })

    it('injects an origin-bound transport into LlamaIndex Ollama and checks its effective default', async () => {
        process.env.HTTP_SECURITY_CHECK = 'false'
        ;(checkDenyList as jest.Mock).mockResolvedValue(undefined)
        ;(secureFetch as jest.Mock).mockResolvedValue(new Response('{}', { status: 200 }))
        const node = new ChatOllamaLlamaIndex()

        await node.init(nodeData('unused', ''), '', {})

        expect(checkDenyList).toHaveBeenCalledWith('http://127.0.0.1:11434')
        expect(mockLlamaIndexOllama.mock.calls[0][0]).toMatchObject({
            config: { host: 'http://127.0.0.1:11434', fetch: expect.any(Function) }
        })
        await mockLlamaIndexOllama.mock.calls[0][0].config.fetch('http://127.0.0.1:11434/api/chat', {
            method: 'POST',
            body: '{}'
        })
        expect(secureFetch).toHaveBeenCalledWith(
            'http://127.0.0.1:11434/api/chat',
            expect.objectContaining({ method: 'POST' }),
            5,
            undefined,
            expect.objectContaining({ enforceDefaultDenyList: false, validateUrl: expect.any(Function) })
        )
    })

    it.each([
        ['LiteLLM', ChatLitellm, 'LiteLLM Base URL is required'],
        ['LocalAI', ChatLocalAI, 'LocalAI Base Path is required']
    ])('fails closed when the %s endpoint is absent', async (_label, NodeClass, message) => {
        ;(checkDenyList as jest.Mock).mockResolvedValue(undefined)
        const node = new NodeClass()

        await expect(node.init(nodeData('unused', ''), '', {})).rejects.toThrow(message as string)
    })

    it('uses secure official defaults for Nvidia NIM and OpenAI Custom', async () => {
        ;(checkDenyList as jest.Mock).mockResolvedValue(undefined)

        await new ChatNvdiaNIM().init(nodeData('unused', ''), '', {})
        expect(checkDenyList).toHaveBeenLastCalledWith('https://integrate.api.nvidia.com/v1')
        expect(mockLangchainChatOpenAI.mock.calls[0][0].configuration).toMatchObject({
            baseURL: 'https://integrate.api.nvidia.com/v1',
            fetch: expect.any(Function)
        })

        mockLangchainChatOpenAI.mockClear()
        await new ChatOpenAICustom().init(nodeData('unused', ''), '', {})
        expect(checkDenyList).toHaveBeenLastCalledWith('https://api.openai.com/v1')
        expect(mockLangchainChatOpenAI.mock.calls[0][0].configuration).toMatchObject({
            baseURL: 'https://api.openai.com/v1',
            fetch: expect.any(Function)
        })
    })

    const unsafeHeaderCases: Array<[string, string, string, RegExp]> = [
        ['Host', 'Host', 'models.internal', /not allowed/i],
        ['credential', 'Authorization', 'Bearer fixture-secret', /credential header/i],
        ['hop-by-hop', 'Connection', 'keep-alive', /not allowed/i],
        ['control-character', 'X-Trace-Mode', 'fixture\r\nHost: internal.example', /control characters/i]
    ]
    const headerParsingNodes: Array<[string, any]> = [
        ['Nvidia NIM', ChatNvdiaNIM],
        ['OpenAI Custom', ChatOpenAICustom]
    ]

    it.each(
        headerParsingNodes.flatMap(([label, NodeClass]) =>
            unsafeHeaderCases.map(([category, headerName, headerValue, expectedError]) => [
                label,
                category,
                NodeClass,
                headerName,
                headerValue,
                expectedError
            ])
        )
    )(
        'rejects %s %s base options through the shared provider header parser',
        async (_label, _category, NodeClass, headerName, headerValue, expectedError) => {
            ;(checkDenyList as jest.Mock).mockResolvedValue(undefined)
            const node = new NodeClass()

            await expect(
                node.init(nodeData('unused', '', { baseOptions: { [headerName as string]: headerValue } }), '', {})
            ).rejects.toThrow(expectedError as RegExp)
            expect(checkDenyList).not.toHaveBeenCalled()
            expect(mockLangchainChatOpenAI).not.toHaveBeenCalled()
        }
    )

    it.each(headerParsingNodes)('passes validated %s base options to the OpenAI client', async (_label, NodeClass) => {
        ;(checkDenyList as jest.Mock).mockResolvedValue(undefined)
        const node = new NodeClass()

        await node.init(nodeData('unused', '', { baseOptions: '{"X-Trace-Mode":"fixture"}' }), '', {})

        expect(mockLangchainChatOpenAI.mock.calls[0][0].configuration).toMatchObject({
            defaultHeaders: { 'X-Trace-Mode': 'fixture' },
            fetch: expect.any(Function)
        })
    })

    it('fails closed on a non-official Google origin before the generic deny list', async () => {
        ;(checkDenyList as jest.Mock).mockResolvedValue(undefined)
        const node = new ChatGoogleGenerativeAI()

        await expect(node.init(nodeData('baseUrl', 'https://proxy.example.com'), '', {})).rejects.toThrow(/origin is not allowed/)
        expect(checkDenyList).not.toHaveBeenCalled()
        expect(mockFlowiseChatGoogleGenerativeAI).not.toHaveBeenCalled()
    })

    it('requires an explicit administrator allowlist for a custom Cloudflare origin', async () => {
        ;(checkDenyList as jest.Mock).mockResolvedValue(undefined)
        const node = new ChatCloudflareWorkersAI()

        await expect(node.init(nodeData('baseUrl', 'https://proxy.example.com'), '', {})).rejects.toThrow(
            /CLOUDFLARE_WORKERS_AI_BASE_URL_ALLOWLIST/
        )
        expect(checkDenyList).not.toHaveBeenCalled()

        process.env.CLOUDFLARE_WORKERS_AI_BASE_URL_ALLOWLIST = 'https://proxy.example.com'
        await expect(node.init(nodeData('baseUrl', 'https://proxy.example.com'), '', {})).resolves.toBeDefined()
        expect(checkDenyList).toHaveBeenCalledTimes(1)
        expect(checkDenyList).toHaveBeenCalledWith('https://proxy.example.com')
    })
})
