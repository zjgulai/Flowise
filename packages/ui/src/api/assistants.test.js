import assistantsApi from './assistants'
import client from './client'

jest.mock('./client', () => ({
    __esModule: true,
    default: {
        delete: jest.fn(),
        get: jest.fn(),
        patch: jest.fn(),
        post: jest.fn(),
        put: jest.fn()
    }
}))

describe('assistants API URL encoding', () => {
    beforeEach(() => jest.clearAllMocks())

    it('encodes untrusted assistant and vector-store path segments', () => {
        const hostileId = '../admin?x=#'
        assistantsApi.getAssistantObj(hostileId, 'credential-safe')
        assistantsApi.updateAssistant(hostileId, {})
        assistantsApi.deleteAssistantVectorStore(hostileId, 'credential-safe')

        expect(client.get).toHaveBeenCalledWith('/openai-assistants/..%2Fadmin%3Fx%3D%23?credential=credential-safe', expect.any(Object))
        expect(client.put).toHaveBeenCalledWith('/assistants/..%2Fadmin%3Fx%3D%23', {}, expect.any(Object))
        expect(client.delete).toHaveBeenCalledWith(
            '/openai-assistants-vector-store/..%2Fadmin%3Fx%3D%23?credential=credential-safe',
            expect.any(Object)
        )
    })

    it('encodes credential query values so they cannot inject delete flags', () => {
        const hostileCredential = 'credential-a&isDeleteBoth=true#fragment'
        assistantsApi.listAssistantVectorStore(hostileCredential)
        assistantsApi.uploadFilesToAssistant(hostileCredential, new FormData())

        expect(client.get).toHaveBeenCalledWith(
            '/openai-assistants-vector-store?credential=credential-a%26isDeleteBoth%3Dtrue%23fragment',
            expect.any(Object)
        )
        expect(client.post.mock.calls[0][0]).toBe('/openai-assistants-file/upload?credential=credential-a%26isDeleteBoth%3Dtrue%23fragment')
        expect(client.post.mock.calls[0][0]).not.toMatch(/[?&]isDeleteBoth=true/)
    })

    it('keeps deleteBoth controlled only by the explicit boolean argument', () => {
        const hostileId = 'assistant&isDeleteBoth=true'
        assistantsApi.deleteAssistant(hostileId, false)
        assistantsApi.deleteAssistant(hostileId, true)

        expect(client.delete).toHaveBeenNthCalledWith(1, '/assistants/assistant%26isDeleteBoth%3Dtrue', expect.any(Object))
        expect(client.delete).toHaveBeenNthCalledWith(
            2,
            '/assistants/assistant%26isDeleteBoth%3Dtrue?isDeleteBoth=true',
            expect.any(Object)
        )
    })

    it('uses one encoded POST seam for snapshot-bound custom assistant deletion', () => {
        const body = { expectedAssistant: { type: 'CUSTOM' }, expectedChatflow: { type: 'ASSISTANT' } }

        assistantsApi.deleteCustomAssistant('../assistant', body)

        expect(client.post).toHaveBeenCalledWith('/assistants/..%2Fassistant/custom-delete', body, expect.any(Object))
    })
})
