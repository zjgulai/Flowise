import { HumanMessage } from '@langchain/core/messages'
import { Response } from 'node-fetch'
import { secureFetch } from '../../../src/httpSecurity'
import { NemoClient } from './NemoClient'

jest.mock('../../../src/httpSecurity', () => ({
    secureFetch: jest.fn()
}))

const originalFetch = globalThis.fetch

describe('NemoClient secure transport', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        delete process.env.HTTP_SECURITY_CHECK
        globalThis.fetch = jest.fn().mockRejectedValue(new Error('UNEXPECTED_GLOBAL_FETCH'))
    })

    afterAll(() => {
        globalThis.fetch = originalFetch
    })

    it('sends chat requests through origin-bound secureFetch and parses the response', async () => {
        ;(secureFetch as jest.Mock).mockResolvedValue(
            new Response(JSON.stringify({ messages: [{ content: 'guarded-response' }] }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            })
        )
        const client = new NemoClient('https://nemo.example.com/', 'config-fixture')

        const messages = await client.chat([new HumanMessage('hello')])

        expect(messages).toHaveLength(1)
        expect(messages[0].content).toBe('guarded-response')
        expect(globalThis.fetch).not.toHaveBeenCalled()
        expect(secureFetch).toHaveBeenCalledWith(
            'https://nemo.example.com/v1/chat/completions',
            expect.objectContaining({ method: 'POST', body: expect.any(String) }),
            5,
            undefined,
            expect.objectContaining({ enforceDefaultDenyList: false, validateUrl: expect.any(Function) })
        )

        const request = JSON.parse((secureFetch as jest.Mock).mock.calls[0][1].body)
        expect(request).toEqual({
            config_id: 'config-fixture',
            messages: [{ role: 'user', content: 'hello' }]
        })
        const policy = (secureFetch as jest.Mock).mock.calls[0][4]
        expect(() => policy.validateUrl(new URL('https://nemo.example.com/v1/next'))).not.toThrow()
        expect(() => policy.validateUrl(new URL('https://redirect.example/v1/next'))).toThrow(/origin/i)
    })
})
