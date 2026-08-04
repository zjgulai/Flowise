import { Request, Response } from 'express'
import { EventEmitter } from 'events'
import { convertTextToSpeechStream } from 'flowise-components'
import chatflowsService from '../../services/chatflows'
import textToSpeechService from '../../services/text-to-speech'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { validateFlowAPIKey } from '../../utils/validateKey'

jest.mock('flowise-components', () => ({
    convertTextToSpeechStream: jest.fn()
}))

jest.mock('../../services/chatflows', () => ({
    __esModule: true,
    default: { getChatflowById: jest.fn(), getChatflowByIdForWorkspace: jest.fn() }
}))

jest.mock('../../services/text-to-speech', () => ({
    __esModule: true,
    default: { getVoices: jest.fn() }
}))

jest.mock('../../utils', () => ({ databaseEntities: {} }))

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: jest.fn()
}))

jest.mock('../../utils/validateKey', () => ({
    validateFlowAPIKey: jest.fn()
}))

const mockFlowRateLimiter = jest.fn((_req, _res, next) => next())
const mockGetRateLimiterById = jest.fn(() => mockFlowRateLimiter)
jest.mock('../../utils/rateLimit', () => ({
    RateLimiterManager: { getInstance: () => ({ getRateLimiterById: mockGetRateLimiterById }) }
}))

import textToSpeechController, { createTTSAbortId } from '.'

const mockConvertTextToSpeechStream = convertTextToSpeechStream as jest.Mock
const mockGetChatflowById = chatflowsService.getChatflowById as jest.Mock
const mockGetChatflowByIdForWorkspace = chatflowsService.getChatflowByIdForWorkspace as jest.Mock
const mockGetVoices = textToSpeechService.getVoices as jest.Mock
const mockGetRunningExpressApp = getRunningExpressApp as jest.Mock
const mockValidateFlowAPIKey = validateFlowAPIKey as jest.Mock

const abortControllerPool = {
    add: jest.fn(),
    remove: jest.fn(),
    abort: jest.fn(),
    get: jest.fn()
}

const sseStreamer = {
    streamMetadataEvent: jest.fn(),
    streamTTSAbortEvent: jest.fn()
}

const chatMessageRepository = {
    findOneBy: jest.fn()
}

const createResponse = () => {
    const res = Object.assign(new EventEmitter(), {
        headersSent: false,
        writableEnded: false,
        destroyed: false,
        status: jest.fn(),
        setHeader: jest.fn(),
        write: jest.fn(),
        end: jest.fn(),
        json: jest.fn()
    })
    res.status.mockReturnValue(res)
    res.json.mockReturnValue(res)
    res.end.mockImplementation(() => {
        res.writableEnded = true
        return res
    })
    return res as unknown as Response
}

const publicFlow = {
    id: 'flow-1',
    workspaceId: 'workspace-owner',
    type: 'CHATFLOW',
    isPublic: true,
    apikeyid: null,
    textToSpeech: JSON.stringify({
        openai: { status: true, credentialId: 'persisted-credential', voice: 'alloy', model: 'tts-1' },
        elevenlabs: { status: false, credentialId: 'other-credential' }
    })
}

describe('text-to-speech controller security boundaries', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockGetRunningExpressApp.mockReturnValue({
            AppDataSource: { getRepository: jest.fn(() => chatMessageRepository) },
            abortControllerPool,
            sseStreamer
        })
        mockGetChatflowById.mockResolvedValue(publicFlow)
        mockGetChatflowByIdForWorkspace.mockResolvedValue(publicFlow)
        chatMessageRepository.findOneBy.mockResolvedValue({
            id: 'message-1',
            chatflowid: 'flow-1',
            chatId: 'chat-1',
            content: 'hello',
            role: 'apiMessage'
        })
        mockValidateFlowAPIKey.mockResolvedValue(true)
        mockConvertTextToSpeechStream.mockImplementation(async (_text, _config, _options, _controller, onStart, _onData, onEnd) => {
            onStart('mp3')
            await onEnd()
        })
    })

    it('rejects an anonymous direct request before using a caller-supplied credential', async () => {
        const req = {
            body: { text: 'hello', provider: 'openai', credentialId: 'attacker-selected-credential' }
        } as unknown as Request
        const res = createResponse()

        await textToSpeechController.generateTextToSpeech(req, res)

        expect(res.status).toHaveBeenCalledWith(403)
        expect(mockConvertTextToSpeechStream).not.toHaveBeenCalled()
        expect(JSON.stringify((res.write as jest.Mock).mock.calls)).not.toContain('attacker-selected-credential')
    })

    it('uses only the persisted flow configuration and owning workspace for an anonymous flow request', async () => {
        const req = {
            body: {
                chatflowId: 'flow-1',
                chatId: 'chat-1',
                chatMessageId: 'message-1',
                text: 'hello',
                provider: 'elevenlabs',
                credentialId: 'attacker-selected-credential'
            },
            headers: {}
        } as unknown as Request
        const res = createResponse()

        await textToSpeechController.generateTextToSpeech(req, res)

        expect(mockGetChatflowById).toHaveBeenCalledWith('flow-1')
        expect(mockValidateFlowAPIKey).toHaveBeenCalledWith(req, publicFlow)
        expect(chatMessageRepository.findOneBy).toHaveBeenCalledWith({
            id: 'message-1',
            chatflowid: 'flow-1',
            chatId: 'chat-1'
        })
        expect(mockConvertTextToSpeechStream).toHaveBeenCalledWith(
            'hello',
            {
                name: 'openai',
                credentialId: 'persisted-credential',
                voice: 'alloy',
                model: 'tts-1'
            },
            expect.objectContaining({ workspaceId: 'workspace-owner', chatflowid: 'flow-1', chatId: 'chat-1' }),
            expect.any(AbortController),
            expect.any(Function),
            expect.any(Function),
            expect.any(Function)
        )
        expect(abortControllerPool.add).toHaveBeenCalledWith(createTTSAbortId('flow-1', 'chat-1', 'message-1'), expect.any(AbortController))
    })

    it('uses normalized scoped identifiers for lookup, runtime options, locking, and SSE events', async () => {
        mockConvertTextToSpeechStream.mockImplementationOnce(async (_text, _config, _options, _controller, onStart, onData, onEnd) => {
            onStart('mp3')
            onData(Buffer.from('audio'))
            await onEnd()
        })
        const req = {
            body: { chatflowId: ' flow-1 ', chatId: ' chat-1 ', chatMessageId: ' message-1 ', text: 'hello' },
            headers: {}
        } as unknown as Request
        const res = createResponse()

        await textToSpeechController.generateTextToSpeech(req, res)

        expect(chatMessageRepository.findOneBy).toHaveBeenCalledWith({ id: 'message-1', chatflowid: 'flow-1', chatId: 'chat-1' })
        expect(mockConvertTextToSpeechStream).toHaveBeenCalledWith(
            'hello',
            expect.any(Object),
            expect.objectContaining({ chatflowid: 'flow-1', chatId: 'chat-1' }),
            expect.any(AbortController),
            expect.any(Function),
            expect.any(Function),
            expect.any(Function)
        )
        const normalizedAbortId = createTTSAbortId('flow-1', 'chat-1', 'message-1')
        expect(abortControllerPool.add).toHaveBeenCalledWith(normalizedAbortId, expect.any(AbortController))
        expect(abortControllerPool.remove).toHaveBeenCalledWith(normalizedAbortId)
        const emittedEvents = JSON.stringify((res.write as jest.Mock).mock.calls)
        expect(emittedEvents).toContain('message-1')
        expect(emittedEvents).not.toContain(' message-1 ')
    })

    it('accepts a direct authenticated administrator test in the active workspace', async () => {
        const req = {
            body: { text: 'hello', provider: 'openai', credentialId: 'credential-1' },
            user: { isOrganizationAdmin: true, activeWorkspaceId: 'workspace-active' }
        } as unknown as Request
        const res = createResponse()

        await textToSpeechController.generateTextToSpeech(req, res)

        expect(mockConvertTextToSpeechStream).toHaveBeenCalledWith(
            'hello',
            expect.objectContaining({ name: 'openai', credentialId: 'credential-1' }),
            expect.objectContaining({ workspaceId: 'workspace-active' }),
            expect.any(AbortController),
            expect.any(Function),
            expect.any(Function),
            expect.any(Function)
        )
        expect(abortControllerPool.add).not.toHaveBeenCalled()
    })

    it('rejects a direct authenticated non-admin test', async () => {
        const req = {
            body: { text: 'hello', provider: 'openai', credentialId: 'credential-1' },
            user: { isOrganizationAdmin: false, activeWorkspaceId: 'workspace-active' }
        } as unknown as Request
        const res = createResponse()

        await textToSpeechController.generateTextToSpeech(req, res)

        expect(res.status).toHaveBeenCalledWith(403)
        expect(mockConvertTextToSpeechStream).not.toHaveBeenCalled()
    })

    it('rejects an anonymous protected flow when its API key is invalid', async () => {
        mockValidateFlowAPIKey.mockResolvedValue(false)
        const req = {
            body: { chatflowId: 'flow-1', chatId: 'chat-1', chatMessageId: 'message-1', text: 'hello' },
            headers: {}
        } as unknown as Request
        const res = createResponse()

        await textToSpeechController.generateTextToSpeech(req, res)

        expect(res.status).toHaveBeenCalledWith(401)
        expect(mockConvertTextToSpeechStream).not.toHaveBeenCalled()
        expect(chatMessageRepository.findOneBy).not.toHaveBeenCalled()
    })

    it('rejects anonymous caller text that does not exactly match the scoped persisted message', async () => {
        const req = {
            body: { chatflowId: 'flow-1', chatId: 'chat-1', chatMessageId: 'message-1', text: 'attacker chosen text' },
            headers: {}
        } as unknown as Request
        const res = createResponse()

        await textToSpeechController.generateTextToSpeech(req, res)

        expect(res.status).toHaveBeenCalledWith(400)
        expect(mockConvertTextToSpeechStream).not.toHaveBeenCalled()
        expect(JSON.stringify((res.write as jest.Mock).mock.calls)).not.toContain('attacker chosen text')
    })

    it('rejects a message id that belongs to another flow or chat before provider use', async () => {
        chatMessageRepository.findOneBy.mockResolvedValue(null)
        const req = {
            body: { chatflowId: 'flow-1', chatId: 'chat-1', chatMessageId: 'message-other', text: 'hello' },
            headers: {}
        } as unknown as Request
        const res = createResponse()

        await textToSpeechController.generateTextToSpeech(req, res)

        expect(res.status).toHaveBeenCalledWith(404)
        expect(chatMessageRepository.findOneBy).toHaveBeenCalledWith({
            id: 'message-other',
            chatflowid: 'flow-1',
            chatId: 'chat-1'
        })
        expect(mockConvertTextToSpeechStream).not.toHaveBeenCalled()
    })

    it('rejects a scoped user message before provider use', async () => {
        chatMessageRepository.findOneBy.mockResolvedValue({
            id: 'message-1',
            chatflowid: 'flow-1',
            chatId: 'chat-1',
            content: 'hello',
            role: 'userMessage'
        })
        const req = {
            body: { chatflowId: 'flow-1', chatId: 'chat-1', chatMessageId: 'message-1', text: 'hello' },
            headers: {}
        } as unknown as Request
        const res = createResponse()

        await textToSpeechController.generateTextToSpeech(req, res)

        expect(res.status).toHaveBeenCalledWith(403)
        expect(mockConvertTextToSpeechStream).not.toHaveBeenCalled()
    })

    it.each([
        ['CHATFLOW', 'chatflows:view'],
        ['AGENTFLOW', 'agentflows:view'],
        ['MULTIAGENT', 'agentflows:view'],
        ['ASSISTANT', 'assistants:view']
    ])('requires the persisted %s type permission for authenticated flow TTS', async (type, permission) => {
        mockGetChatflowByIdForWorkspace.mockResolvedValue({ ...publicFlow, type, workspaceId: 'workspace-active' })
        const req = {
            body: { chatflowId: 'flow-1', chatId: 'chat-1', chatMessageId: 'message-1', text: 'hello' },
            user: { activeWorkspaceId: 'workspace-active', permissions: [permission] }
        } as unknown as Request
        const res = createResponse()

        await textToSpeechController.generateTextToSpeech(req, res)

        expect(mockGetChatflowByIdForWorkspace).toHaveBeenCalledWith('flow-1', 'workspace-active')
        expect(mockConvertTextToSpeechStream).toHaveBeenCalledTimes(1)
    })

    it('rejects an authenticated low-scope user before message or provider access', async () => {
        const req = {
            body: { chatflowId: 'flow-1', chatId: 'chat-1', chatMessageId: 'message-1', text: 'hello' },
            user: { activeWorkspaceId: 'workspace-owner', permissions: ['chatflows:update'] }
        } as unknown as Request
        const res = createResponse()

        await textToSpeechController.generateTextToSpeech(req, res)

        expect(res.status).toHaveBeenCalledWith(403)
        expect(chatMessageRepository.findOneBy).not.toHaveBeenCalled()
        expect(mockConvertTextToSpeechStream).not.toHaveBeenCalled()
    })

    it('fails a cross-workspace authenticated flow lookup before message or provider access', async () => {
        mockGetChatflowByIdForWorkspace.mockRejectedValue(Object.assign(new Error('not found'), { statusCode: 404 }))
        const req = {
            body: { chatflowId: 'flow-1', chatId: 'chat-1', chatMessageId: 'message-1', text: 'hello' },
            user: { activeWorkspaceId: 'workspace-other', permissions: ['chatflows:view'] }
        } as unknown as Request
        const res = createResponse()

        await textToSpeechController.generateTextToSpeech(req, res)

        expect(res.status).toHaveBeenCalledWith(500)
        expect(chatMessageRepository.findOneBy).not.toHaveBeenCalled()
        expect(mockConvertTextToSpeechStream).not.toHaveBeenCalled()
    })

    it('rejects oversized text before any flow, message, credential, or provider access', async () => {
        const req = {
            body: { chatflowId: 'flow-1', chatId: 'chat-1', chatMessageId: 'message-1', text: 'x'.repeat(4097) },
            headers: {}
        } as unknown as Request
        const res = createResponse()

        await textToSpeechController.generateTextToSpeech(req, res)

        expect(res.status).toHaveBeenCalledWith(400)
        expect(mockGetChatflowById).not.toHaveBeenCalled()
        expect(chatMessageRepository.findOneBy).not.toHaveBeenCalled()
        expect(mockConvertTextToSpeechStream).not.toHaveBeenCalled()
    })

    it('reuses the configured per-flow rate limiter for generation', () => {
        const req = { body: { chatflowId: ' flow-1 ' } } as unknown as Request
        const res = createResponse()
        const next = jest.fn()

        textToSpeechController.getRateLimiterMiddleware(req, res, next)

        expect(mockGetRateLimiterById).toHaveBeenCalledWith('flow-1')
        expect(mockFlowRateLimiter).toHaveBeenCalledWith(req, res, next)
    })

    it('rejects a concurrent generation for the same scoped message without replacing the active controller', async () => {
        let finishFirst: (() => Promise<void>) | undefined
        mockConvertTextToSpeechStream.mockImplementationOnce(
            async (_text, _config, _options, _controller, _onStart, _onData, onEnd) =>
                await new Promise<void>((resolve) => {
                    finishFirst = async () => {
                        await onEnd()
                        resolve()
                    }
                })
        )
        const request = {
            body: { chatflowId: 'flow-1', chatId: 'chat-1', chatMessageId: 'message-1', text: 'hello' },
            headers: {}
        } as unknown as Request
        const firstResponse = createResponse()
        const first = textToSpeechController.generateTextToSpeech(request, firstResponse)
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()

        const whitespaceVariant = {
            body: { chatflowId: ' flow-1 ', chatId: ' chat-1 ', chatMessageId: ' message-1 ', text: 'hello' },
            headers: {}
        } as unknown as Request
        const secondResponse = createResponse()
        await textToSpeechController.generateTextToSpeech(whitespaceVariant, secondResponse)

        expect(secondResponse.status).toHaveBeenCalledWith(409)
        expect(mockConvertTextToSpeechStream).toHaveBeenCalledTimes(1)
        expect(abortControllerPool.add).toHaveBeenCalledTimes(1)

        await finishFirst?.()
        await first

        const thirdResponse = createResponse()
        await textToSpeechController.generateTextToSpeech(request, thirdResponse)
        expect(mockConvertTextToSpeechStream).toHaveBeenCalledTimes(2)
    })

    it('aborts a direct administrator provider request when the response closes before completion', async () => {
        let providerController: AbortController | undefined
        mockConvertTextToSpeechStream.mockImplementationOnce(
            async (_text, _config, _options, controller: AbortController) =>
                await new Promise<void>((resolve) => {
                    providerController = controller
                    controller.signal.addEventListener('abort', () => resolve(), { once: true })
                })
        )
        const req = Object.assign(new EventEmitter(), {
            body: { text: 'hello', provider: 'openai', credentialId: 'credential-1' },
            user: { isOrganizationAdmin: true, activeWorkspaceId: 'workspace-active' },
            aborted: false
        }) as unknown as Request
        const res = createResponse()

        const generation = textToSpeechController.generateTextToSpeech(req, res)
        await Promise.resolve()
        await Promise.resolve()
        await Promise.resolve()
        ;(res as unknown as EventEmitter).emit('close')
        await generation

        expect(providerController?.signal.aborted).toBe(true)
        expect(abortControllerPool.add).not.toHaveBeenCalled()
        expect(req.listenerCount('aborted')).toBe(0)
        expect((res as unknown as EventEmitter).listenerCount('close')).toBe(0)
    })

    it('passes an already-aborted request to the provider with an aborted signal and releases the scoped lock', async () => {
        let providerController: AbortController | undefined
        mockConvertTextToSpeechStream.mockImplementationOnce(async (_text, _config, _options, controller: AbortController) => {
            providerController = controller
        })
        const req = Object.assign(new EventEmitter(), {
            body: { chatflowId: 'flow-1', chatId: 'chat-1', chatMessageId: 'message-1', text: 'hello' },
            headers: {},
            aborted: true
        }) as unknown as Request
        const res = createResponse()

        await textToSpeechController.generateTextToSpeech(req, res)

        expect(providerController?.signal.aborted).toBe(true)
        expect(abortControllerPool.remove).toHaveBeenCalledWith(createTTSAbortId('flow-1', 'chat-1', 'message-1'))
        expect(req.listenerCount('aborted')).toBe(0)
        expect((res as unknown as EventEmitter).listenerCount('close')).toBe(0)
    })

    it('aborts a running scoped provider when the request emits aborted', async () => {
        let providerController: AbortController | undefined
        mockConvertTextToSpeechStream.mockImplementationOnce(
            async (_text, _config, _options, controller: AbortController) =>
                await new Promise<void>((resolve) => {
                    providerController = controller
                    controller.signal.addEventListener('abort', () => resolve(), { once: true })
                })
        )
        const req = Object.assign(new EventEmitter(), {
            body: { chatflowId: 'flow-1', chatId: 'chat-1', chatMessageId: 'message-1', text: 'hello' },
            headers: {},
            aborted: false
        }) as unknown as Request
        const res = createResponse()

        const generation = textToSpeechController.generateTextToSpeech(req, res)
        for (let attempt = 0; attempt < 10 && !providerController; attempt += 1) {
            await new Promise((resolve) => setImmediate(resolve))
        }
        expect(providerController).toBeDefined()
        req.aborted = true
        req.emit('aborted')
        await generation

        expect(providerController?.signal.aborted).toBe(true)
        expect(abortControllerPool.remove).toHaveBeenCalledWith(createTTSAbortId('flow-1', 'chat-1', 'message-1'))
        expect(req.listenerCount('aborted')).toBe(0)
        expect((res as unknown as EventEmitter).listenerCount('close')).toBe(0)
    })

    it('ignores late start, data, and end callbacks after close and releases the scoped request once', async () => {
        const req = Object.assign(new EventEmitter(), {
            body: { chatflowId: 'flow-1', chatId: 'chat-1', chatMessageId: 'message-1', text: 'hello' },
            headers: {},
            aborted: false
        }) as unknown as Request
        const res = createResponse()
        mockConvertTextToSpeechStream.mockImplementationOnce(async (_text, _config, _options, _controller, onStart, onData, onEnd) => {
            ;(res as unknown as { destroyed: boolean }).destroyed = true
            ;(res as unknown as EventEmitter).emit('close')
            onStart('mp3')
            onData(Buffer.from('late audio'))
            await onEnd()
        })

        await textToSpeechController.generateTextToSpeech(req, res)

        expect(res.write).not.toHaveBeenCalled()
        expect(res.end).not.toHaveBeenCalled()
        expect(abortControllerPool.remove).toHaveBeenCalledTimes(1)
        expect(abortControllerPool.remove).toHaveBeenCalledWith(createTTSAbortId('flow-1', 'chat-1', 'message-1'))
        expect(req.listenerCount('aborted')).toBe(0)
        expect((res as unknown as EventEmitter).listenerCount('close')).toBe(0)
    })

    it('does not abort on a normal response close after writable end', async () => {
        let providerController: AbortController | undefined
        const res = createResponse()
        mockConvertTextToSpeechStream.mockImplementationOnce(async (_text, _config, _options, controller: AbortController) => {
            providerController = controller
            ;(res as unknown as { writableEnded: boolean }).writableEnded = true
            ;(res as unknown as EventEmitter).emit('close')
        })
        const req = Object.assign(new EventEmitter(), {
            body: { text: 'hello', provider: 'openai', credentialId: 'credential-1' },
            user: { isOrganizationAdmin: true, activeWorkspaceId: 'workspace-active' },
            aborted: false
        }) as unknown as Request

        await textToSpeechController.generateTextToSpeech(req, res)

        expect(providerController?.signal.aborted).toBe(false)
        expect(req.listenerCount('aborted')).toBe(0)
        expect((res as unknown as EventEmitter).listenerCount('close')).toBe(0)
    })

    it('passes a response that closed before listener installation to the provider with an aborted signal', async () => {
        let providerController: AbortController | undefined
        mockConvertTextToSpeechStream.mockImplementationOnce(async (_text, _config, _options, controller: AbortController) => {
            providerController = controller
        })
        const req = Object.assign(new EventEmitter(), {
            body: { text: 'hello', provider: 'openai', credentialId: 'credential-1' },
            user: { isOrganizationAdmin: true, activeWorkspaceId: 'workspace-active' },
            aborted: false
        }) as unknown as Request
        const res = createResponse()
        ;(res as unknown as { destroyed: boolean }).destroyed = true

        await textToSpeechController.generateTextToSpeech(req, res)

        expect(providerController?.signal.aborted).toBe(true)
        expect(res.write).not.toHaveBeenCalled()
        expect(req.listenerCount('aborted')).toBe(0)
        expect((res as unknown as EventEmitter).listenerCount('close')).toBe(0)
    })

    it('removes disconnect listeners when provider execution rejects', async () => {
        mockConvertTextToSpeechStream.mockRejectedValueOnce(new Error('provider failed'))
        const req = Object.assign(new EventEmitter(), {
            body: { text: 'hello', provider: 'openai', credentialId: 'credential-1' },
            user: { isOrganizationAdmin: true, activeWorkspaceId: 'workspace-active' },
            aborted: false
        }) as unknown as Request
        const res = createResponse()

        await textToSpeechController.generateTextToSpeech(req, res)

        expect(req.listenerCount('aborted')).toBe(0)
        expect((res as unknown as EventEmitter).listenerCount('close')).toBe(0)
        expect(res.end).toHaveBeenCalledTimes(1)
    })

    it('scopes abort controller IDs to all three identifiers without delimiter collisions', () => {
        expect(createTTSAbortId('flow_a', 'b', 'c')).not.toBe(createTTSAbortId('flow', 'a_b', 'c'))
        expect(createTTSAbortId('flow', 'a', 'b_c')).not.toBe(createTTSAbortId('flow', 'a_b', 'c'))
    })

    it('does not abort or signal another flow that reuses the same chat identifiers', async () => {
        abortControllerPool.get.mockImplementation((id: string) => id === createTTSAbortId('flow-2', 'chat-1', 'message-1'))
        const req = {
            body: { chatflowId: 'flow-1', chatId: 'chat-1', chatMessageId: 'message-1' },
            headers: {}
        } as unknown as Request
        const res = createResponse()

        await textToSpeechController.abortTextToSpeech(req, res)

        expect(abortControllerPool.abort).not.toHaveBeenCalled()
        expect(sseStreamer.streamTTSAbortEvent).not.toHaveBeenCalled()
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ aborted: false }))
    })

    it('does not abort when the message identity is not scoped to the requested flow and chat', async () => {
        chatMessageRepository.findOneBy.mockResolvedValue(null)
        abortControllerPool.get.mockReturnValue(true)
        const req = {
            body: { chatflowId: 'flow-1', chatId: 'chat-1', chatMessageId: 'message-other' },
            headers: {}
        } as unknown as Request
        const res = createResponse()

        await textToSpeechController.abortTextToSpeech(req, res)

        expect(res.status).toHaveBeenCalledWith(404)
        expect(abortControllerPool.get).not.toHaveBeenCalled()
        expect(abortControllerPool.abort).not.toHaveBeenCalled()
        expect(sseStreamer.streamTTSAbortEvent).not.toHaveBeenCalled()
    })

    it('aborts and signals only the matching flow-scoped controller', async () => {
        const matchingId = createTTSAbortId('flow-1', 'chat-1', 'message-1')
        abortControllerPool.get.mockImplementation((id: string) => id === matchingId)
        const req = {
            body: { chatflowId: ' flow-1 ', chatId: ' chat-1 ', chatMessageId: ' message-1 ' },
            headers: {}
        } as unknown as Request
        const res = createResponse()

        await textToSpeechController.abortTextToSpeech(req, res)

        expect(chatMessageRepository.findOneBy).toHaveBeenCalledWith({ id: 'message-1', chatflowid: 'flow-1', chatId: 'chat-1' })
        expect(abortControllerPool.abort).toHaveBeenCalledWith(matchingId)
        expect(sseStreamer.streamTTSAbortEvent).toHaveBeenCalledWith('chat-1', 'message-1')
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ aborted: true }))
    })

    it('passes the active workspace to the voice service', async () => {
        mockGetVoices.mockResolvedValue([{ id: 'alloy' }])
        const req = {
            query: { provider: 'openai', credentialId: 'credential-1' },
            user: { activeWorkspaceId: 'workspace-active' }
        } as unknown as Request
        const res = createResponse()
        const next = jest.fn()

        await textToSpeechController.getVoices(req, res, next)

        expect(mockGetVoices).toHaveBeenCalledWith('openai', 'credential-1', 'workspace-active')
        expect(res.json).toHaveBeenCalledWith([{ id: 'alloy' }])
        expect(next).not.toHaveBeenCalled()
    })
})
