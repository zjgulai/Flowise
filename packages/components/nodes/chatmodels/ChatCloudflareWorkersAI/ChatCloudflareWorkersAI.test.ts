import { HumanMessage } from '@langchain/core/messages'
import { Response } from 'node-fetch'
import { checkDenyList, secureFetch } from '../../../src/httpSecurity'
import { getCredentialData, getCredentialParam } from '../../../src/utils'

jest.mock('../../../src/httpSecurity', () => ({
    checkDenyList: jest.fn(),
    secureFetch: jest.fn()
}))

jest.mock('../../../src/utils', () => ({
    getBaseClasses: jest.fn().mockReturnValue(['BaseChatModel']),
    getCredentialData: jest.fn(),
    getCredentialParam: jest.fn()
}))

const { nodeClass: ChatCloudflareWorkersAI } = require('./ChatCloudflareWorkersAI')
const originalFetch = globalThis.fetch
const CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef'

describe('Cloudflare Workers AI secure transport', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        delete process.env.CLOUDFLARE_WORKERS_AI_BASE_URL_ALLOWLIST
        delete process.env.HTTP_SECURITY_CHECK
        ;(checkDenyList as jest.Mock).mockResolvedValue(undefined)
        ;(getCredentialData as jest.Mock).mockResolvedValue({
            cloudflareAccountId: CLOUDFLARE_ACCOUNT_ID,
            cloudflareApiToken: 'token-fixture'
        })
        ;(getCredentialParam as jest.Mock).mockImplementation((name: string, data: Record<string, unknown>) => data[name])
        globalThis.fetch = jest.fn().mockRejectedValue(new Error('UNEXPECTED_GLOBAL_FETCH'))
    })

    afterAll(() => {
        globalThis.fetch = originalFetch
    })

    it('overrides the SDK request path so the real call uses secureFetch', async () => {
        ;(secureFetch as jest.Mock).mockResolvedValue(
            new Response(JSON.stringify({ result: { response: 'cloudflare-response' } }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            })
        )
        const node = new ChatCloudflareWorkersAI()
        const model = await node.init(
            {
                id: 'cloudflare-fixture',
                credential: 'credential-fixture',
                inputs: { model: '@cf/meta/test' }
            },
            '',
            {}
        )

        const response = await model._request([new HumanMessage('hello')], {}, false)

        expect(await response.json()).toEqual({ result: { response: 'cloudflare-response' } })
        expect(globalThis.fetch).not.toHaveBeenCalled()
        expect(secureFetch).toHaveBeenCalledWith(
            `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/meta/test`,
            expect.objectContaining({
                method: 'POST',
                body: expect.any(String),
                headers: expect.objectContaining({ Authorization: 'Bearer token-fixture' })
            }),
            5,
            undefined,
            expect.objectContaining({ enforceDefaultDenyList: false, validateUrl: expect.any(Function) })
        )
        const policy = (secureFetch as jest.Mock).mock.calls[0][4]
        expect(() =>
            policy.validateUrl(
                new URL(`https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/meta/redirected-model`)
            )
        ).not.toThrow()
        expect(() => policy.validateUrl(new URL('https://api.cloudflare.com/client/v4/user/tokens'))).toThrow(/path/i)
        expect(() => policy.validateUrl(new URL('https://redirect.example/client/v4/next'))).toThrow(/origin/i)
    })

    it.each([
        'account-fixture',
        '../0123456789abcdef0123456789abcdef',
        '0123456789abcdef0123456789abcde/',
        '0123456789abcdef0123456789abcde%2f',
        'g123456789abcdef0123456789abcdef'
    ])('rejects an unsafe account path segment before endpoint resolution: %s', async (cloudflareAccountId) => {
        ;(getCredentialData as jest.Mock).mockResolvedValue({
            cloudflareAccountId,
            cloudflareApiToken: 'token-fixture'
        })
        const node = new ChatCloudflareWorkersAI()

        await expect(
            node.init(
                {
                    id: 'cloudflare-fixture',
                    credential: 'credential-fixture',
                    inputs: { model: '@cf/meta/test' }
                },
                '',
                {}
            )
        ).rejects.toThrow(/Account ID.*path segment/i)
        expect(checkDenyList).not.toHaveBeenCalled()
        expect(secureFetch).not.toHaveBeenCalled()
    })

    it.each([
        '../../../user/tokens',
        '@cf/meta/../../user/tokens',
        '@cf/meta/%2e%2e',
        '@cf/meta/model\\..\\tokens',
        '@cf//model',
        '@cf/meta/model/extra'
    ])('rejects an unsafe model path before attaching the bearer token: %s', async (model) => {
        const node = new ChatCloudflareWorkersAI()

        await expect(
            node.init(
                {
                    id: 'cloudflare-fixture',
                    credential: 'credential-fixture',
                    inputs: { model }
                },
                '',
                {}
            )
        ).rejects.toThrow(/safe @cf.*path segments/i)
        expect(checkDenyList).not.toHaveBeenCalled()
        expect(secureFetch).not.toHaveBeenCalled()
    })

    it('rejects an official-origin base URL outside the configured account AI run path before DNS checks', async () => {
        const node = new ChatCloudflareWorkersAI()

        await expect(
            node.init(
                {
                    id: 'cloudflare-fixture',
                    credential: 'credential-fixture',
                    inputs: {
                        model: '@cf/meta/test',
                        baseUrl: 'https://api.cloudflare.com/client/v4/user/tokens'
                    }
                },
                '',
                {}
            )
        ).rejects.toThrow(/configured account AI run path/i)
        expect(checkDenyList).not.toHaveBeenCalled()
        expect(secureFetch).not.toHaveBeenCalled()
    })
})
