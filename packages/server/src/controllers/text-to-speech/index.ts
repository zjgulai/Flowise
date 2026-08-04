import { NextFunction, Request, Response } from 'express'
import { convertTextToSpeechStream } from 'flowise-components'
import { StatusCodes } from 'http-status-codes'
import { ChatMessage } from '../../database/entities/ChatMessage'
import { EnumChatflowType } from '../../database/entities/ChatFlow'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import chatflowsService from '../../services/chatflows'
import textToSpeechService from '../../services/text-to-speech'
import { databaseEntities } from '../../utils'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { RateLimiterManager } from '../../utils/rateLimit'
import { validateFlowAPIKey } from '../../utils/validateKey'

const ALLOWED_TTS_PROVIDERS = new Set(['openai', 'elevenlabs'])
const SAFE_TTS_GENERATION_ERROR = 'Text-to-speech generation failed'
const SAFE_TTS_ABORT_ERROR = 'Failed to abort TTS stream'
const MAX_TTS_TEXT_LENGTH = 4096
const MAX_TTS_ID_LENGTH = 256
const MAX_TTS_CONFIG_VALUE_LENGTH = 256
const activeTTSRequests = new Set<string>()

const isRecord = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value)

const requireBoundedString = (value: unknown, field: string, maxLength: number, trim = true): string => {
    if (typeof value !== 'string') {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, `Invalid ${field}`)
    }
    const normalized = trim ? value.trim() : value
    if (!normalized.trim() || normalized.length > maxLength) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, `Invalid ${field}`)
    }
    return normalized
}

export const createTTSAbortId = (chatflowId: string, chatId: string, chatMessageId: string): string =>
    `tts:${JSON.stringify([chatflowId, chatId, chatMessageId])}`

const resolveChatflowForTTS = async (req: Request, chatflowId: string) => {
    if (req.user) {
        const workspaceId = req.user.activeWorkspaceId
        if (!workspaceId) throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'TTS request is not authorized')
        const chatflow = await chatflowsService.getChatflowByIdForWorkspace(chatflowId, workspaceId)
        assertTTSFlowPermission(req, chatflow.type)
        return { chatflow, workspaceId }
    }

    const chatflow = await chatflowsService.getChatflowById(chatflowId)
    if (!(await validateFlowAPIKey(req, chatflow))) {
        throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, 'TTS request is not authorized')
    }
    if (!chatflow.workspaceId) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'TTS workspace was not found')
    return { chatflow, workspaceId: chatflow.workspaceId as string }
}

const assertTTSFlowPermission = (req: Request, type: unknown): void => {
    if (req.user?.isOrganizationAdmin) return
    const permission =
        type === EnumChatflowType.CHATFLOW
            ? 'chatflows:view'
            : type === EnumChatflowType.AGENTFLOW || type === EnumChatflowType.MULTIAGENT
            ? 'agentflows:view'
            : type === EnumChatflowType.ASSISTANT
            ? 'assistants:view'
            : undefined
    if (!permission || !req.user?.permissions?.includes(permission)) {
        throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'TTS request is not authorized')
    }
}

const resolveScopedChatMessage = async (chatflowId: string, chatId: string, chatMessageId: string): Promise<ChatMessage> => {
    const appServer = getRunningExpressApp()
    const message = await appServer.AppDataSource.getRepository(ChatMessage).findOneBy({
        id: chatMessageId,
        chatflowid: chatflowId,
        chatId
    })
    if (!message) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'TTS message was not found')
    if (message.role !== 'apiMessage') {
        throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'TTS message is not eligible for playback')
    }
    return message
}

const getPersistedTTSConfig = (textToSpeech: unknown) => {
    if (typeof textToSpeech !== 'string' || !textToSpeech) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'TTS is not configured for this chatflow')
    }

    let parsed: unknown
    try {
        parsed = JSON.parse(textToSpeech)
    } catch {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'TTS configuration is invalid')
    }
    if (!isRecord(parsed)) throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'TTS configuration is invalid')

    const activeProvider = Object.entries(parsed).find(([, config]) => isRecord(config) && config.status === true)
    if (!activeProvider || !ALLOWED_TTS_PROVIDERS.has(activeProvider[0]) || !isRecord(activeProvider[1])) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'No supported TTS provider is enabled')
    }

    return {
        provider: activeProvider[0],
        credentialId: requireBoundedString(activeProvider[1].credentialId, 'credentialId', MAX_TTS_CONFIG_VALUE_LENGTH),
        voice:
            activeProvider[1].voice === undefined
                ? undefined
                : requireBoundedString(activeProvider[1].voice, 'voice', MAX_TTS_CONFIG_VALUE_LENGTH),
        model:
            activeProvider[1].model === undefined
                ? undefined
                : requireBoundedString(activeProvider[1].model, 'model', MAX_TTS_CONFIG_VALUE_LENGTH)
    }
}

const getRateLimiterMiddleware = (req: Request, res: Response, next: NextFunction) => {
    try {
        const chatflowId = req.body?.chatflowId
        if (typeof chatflowId !== 'string' || !chatflowId.trim() || chatflowId.trim().length > MAX_TTS_ID_LENGTH) return next()
        return RateLimiterManager.getInstance().getRateLimiterById(chatflowId.trim())(req, res, next)
    } catch {
        next(new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, SAFE_TTS_GENERATION_ERROR))
    }
}

const generateTextToSpeech = async (req: Request, res: Response) => {
    let clientDisconnected = Boolean(req.aborted || res.destroyed)
    try {
        const {
            chatId,
            chatflowId,
            chatMessageId,
            text,
            provider: bodyProvider,
            credentialId: bodyCredentialId,
            voice: bodyVoice,
            model: bodyModel
        } = req.body

        const requestedText = requireBoundedString(text, 'text', MAX_TTS_TEXT_LENGTH, false)

        let provider: string
        let credentialId: string
        let voice: string | undefined
        let model: string | undefined
        let workspaceId: string
        let resolvedChatflowId: string | undefined
        let resolvedChatId: string | undefined
        let resolvedChatMessageId: string | undefined
        let textForProvider = requestedText

        if (chatflowId !== undefined && chatflowId !== null) {
            resolvedChatflowId = requireBoundedString(chatflowId, 'chatflowId', MAX_TTS_ID_LENGTH)
            resolvedChatId = requireBoundedString(chatId, 'chatId', MAX_TTS_ID_LENGTH)
            resolvedChatMessageId = requireBoundedString(chatMessageId, 'chatMessageId', MAX_TTS_ID_LENGTH)
            const resolved = await resolveChatflowForTTS(req, resolvedChatflowId)
            workspaceId = resolved.workspaceId
            const persistedMessage = await resolveScopedChatMessage(resolvedChatflowId, resolvedChatId, resolvedChatMessageId)
            const persistedText = requireBoundedString(persistedMessage.content, 'message content', MAX_TTS_TEXT_LENGTH, false)
            if (requestedText !== persistedText) {
                throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'TTS message content does not match')
            }
            textForProvider = persistedText
            const persistedConfig = getPersistedTTSConfig(resolved.chatflow.textToSpeech)
            provider = persistedConfig.provider
            credentialId = persistedConfig.credentialId
            voice = persistedConfig.voice
            model = persistedConfig.model
        } else {
            if (!req.user?.isOrganizationAdmin || !req.user.activeWorkspaceId) {
                throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Direct TTS tests require an authenticated administrator')
            }
            workspaceId = req.user.activeWorkspaceId
            provider = requireBoundedString(bodyProvider, 'provider', MAX_TTS_CONFIG_VALUE_LENGTH)
            if (!ALLOWED_TTS_PROVIDERS.has(provider)) {
                throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Unsupported TTS provider')
            }
            credentialId = requireBoundedString(bodyCredentialId, 'credentialId', MAX_TTS_CONFIG_VALUE_LENGTH)
            voice = bodyVoice === undefined ? undefined : requireBoundedString(bodyVoice, 'voice', MAX_TTS_CONFIG_VALUE_LENGTH)
            model = bodyModel === undefined ? undefined : requireBoundedString(bodyModel, 'model', MAX_TTS_CONFIG_VALUE_LENGTH)
        }

        res.setHeader('Content-Type', 'text/event-stream')
        res.setHeader('Cache-Control', 'no-cache')
        res.setHeader('Connection', 'keep-alive')

        const appServer = getRunningExpressApp()
        const options = {
            orgId: '',
            chatflowid: resolvedChatflowId ?? '',
            chatId: resolvedChatId ?? '',
            workspaceId,
            appDataSource: appServer.AppDataSource,
            databaseEntities: databaseEntities
        }

        const textToSpeechConfig = {
            name: provider,
            credentialId: credentialId,
            voice: voice,
            model: model
        }

        // Create and store AbortController
        const abortController = new AbortController()
        const ttsAbortId =
            resolvedChatflowId && resolvedChatId && resolvedChatMessageId
                ? createTTSAbortId(resolvedChatflowId, resolvedChatId, resolvedChatMessageId)
                : undefined
        if (ttsAbortId) {
            if (activeTTSRequests.has(ttsAbortId)) {
                throw new InternalFlowiseError(StatusCodes.CONFLICT, 'TTS generation is already active')
            }
            activeTTSRequests.add(ttsAbortId)
            try {
                appServer.abortControllerPool.add(ttsAbortId, abortController)
            } catch (error) {
                activeTTSRequests.delete(ttsAbortId)
                throw error
            }
        }

        let released = false
        const releaseTTSRequest = () => {
            if (released) return
            released = true
            if (ttsAbortId) {
                try {
                    appServer.abortControllerPool.remove(ttsAbortId)
                } finally {
                    activeTTSRequests.delete(ttsAbortId)
                }
            }
        }

        const abortOnRequestDisconnect = () => {
            clientDisconnected = true
            abortController.abort()
            releaseTTSRequest()
        }
        const abortOnResponseClose = () => {
            if (!res.writableEnded) {
                clientDisconnected = true
                abortController.abort()
                releaseTTSRequest()
            }
        }
        if (typeof req.once === 'function') req.once('aborted', abortOnRequestDisconnect)
        if (typeof res.once === 'function') res.once('close', abortOnResponseClose)
        if (req.aborted || res.destroyed) clientDisconnected = true
        if (clientDisconnected) {
            abortController.abort()
            releaseTTSRequest()
        }

        const responseIsClosed = () => clientDisconnected || Boolean(req.aborted || res.destroyed || res.writableEnded)

        const removeDisconnectListeners = () => {
            if (typeof req.off === 'function') req.off('aborted', abortOnRequestDisconnect)
            if (typeof res.off === 'function') res.off('close', abortOnResponseClose)
        }

        try {
            await convertTextToSpeechStream(
                textForProvider,
                textToSpeechConfig,
                options,
                abortController,
                (format: string) => {
                    if (responseIsClosed()) return
                    const startResponse = {
                        event: 'tts_start',
                        data: { chatMessageId: resolvedChatMessageId, format }
                    }
                    res.write('event: tts_start\n')
                    res.write(`data: ${JSON.stringify(startResponse)}\n\n`)
                },
                (chunk: Buffer) => {
                    if (responseIsClosed()) return
                    const audioBase64 = chunk.toString('base64')
                    const clientResponse = {
                        event: 'tts_data',
                        data: { chatMessageId: resolvedChatMessageId, audioChunk: audioBase64 }
                    }
                    res.write('event: tts_data\n')
                    res.write(`data: ${JSON.stringify(clientResponse)}\n\n`)
                },
                async () => {
                    if (responseIsClosed()) {
                        releaseTTSRequest()
                        return
                    }
                    const endResponse = {
                        event: 'tts_end',
                        data: { chatMessageId: resolvedChatMessageId }
                    }
                    res.write('event: tts_end\n')
                    res.write(`data: ${JSON.stringify(endResponse)}\n\n`)
                    res.end()
                    releaseTTSRequest()
                }
            )
        } finally {
            removeDisconnectListeners()
            releaseTTSRequest()
        }
    } catch (error) {
        if (clientDisconnected || req.aborted || res.destroyed || res.writableEnded) return
        if (!res.headersSent) {
            res.status(error instanceof InternalFlowiseError ? error.statusCode : StatusCodes.INTERNAL_SERVER_ERROR)
            res.setHeader('Content-Type', 'text/event-stream')
            res.setHeader('Cache-Control', 'no-cache')
            res.setHeader('Connection', 'keep-alive')
        }

        const errorResponse = {
            event: 'tts_error',
            data: { error: SAFE_TTS_GENERATION_ERROR }
        }
        res.write('event: tts_error\n')
        res.write(`data: ${JSON.stringify(errorResponse)}\n\n`)
        res.end()
    }
}

const abortTextToSpeech = async (req: Request, res: Response) => {
    try {
        const { chatId, chatMessageId, chatflowId } = req.body
        const resolvedChatId = requireBoundedString(chatId, 'chatId', MAX_TTS_ID_LENGTH)
        const resolvedChatMessageId = requireBoundedString(chatMessageId, 'chatMessageId', MAX_TTS_ID_LENGTH)
        const resolvedChatflowId = requireBoundedString(chatflowId, 'chatflowId', MAX_TTS_ID_LENGTH)

        await resolveChatflowForTTS(req, resolvedChatflowId)
        await resolveScopedChatMessage(resolvedChatflowId, resolvedChatId, resolvedChatMessageId)

        const appServer = getRunningExpressApp()

        const ttsAbortId = createTTSAbortId(resolvedChatflowId, resolvedChatId, resolvedChatMessageId)
        const hasTTSController = Boolean(appServer.abortControllerPool.get(ttsAbortId))
        if (hasTTSController) appServer.abortControllerPool.abort(ttsAbortId)

        // Also abort the main chat flow AbortController for auto-TTS
        const chatFlowAbortId = `${resolvedChatflowId}_${resolvedChatId}`
        const hasChatFlowController = Boolean(appServer.abortControllerPool.get(chatFlowAbortId))
        if (hasChatFlowController) {
            appServer.abortControllerPool.abort(chatFlowAbortId)
            appServer.sseStreamer.streamMetadataEvent(resolvedChatId, {
                chatId: resolvedChatId,
                chatMessageId: resolvedChatMessageId
            })
        }

        const aborted = hasTTSController || hasChatFlowController
        if (aborted) appServer.sseStreamer.streamTTSAbortEvent(resolvedChatId, resolvedChatMessageId)

        res.json({ message: 'TTS abort request processed', chatId: resolvedChatId, chatMessageId: resolvedChatMessageId, aborted })
    } catch (error) {
        res.status(error instanceof InternalFlowiseError ? error.statusCode : StatusCodes.INTERNAL_SERVER_ERROR).json({
            error: SAFE_TTS_ABORT_ERROR
        })
    }
}

const getVoices = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { provider, credentialId } = req.query
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'TTS request is not authorized')

        const voices = await textToSpeechService.getVoices(
            requireBoundedString(provider, 'provider', MAX_TTS_CONFIG_VALUE_LENGTH),
            requireBoundedString(credentialId, 'credentialId', MAX_TTS_CONFIG_VALUE_LENGTH),
            workspaceId
        )

        return res.json(voices)
    } catch (error) {
        next(error)
    }
}

export default {
    getRateLimiterMiddleware,
    generateTextToSpeech,
    abortTextToSpeech,
    getVoices
}
