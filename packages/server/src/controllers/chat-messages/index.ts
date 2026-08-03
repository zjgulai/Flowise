import { Request, Response, NextFunction } from 'express'
import { ChatMessageRatingType, ChatType, IReactFlowObject } from '../../Interface'
import { EnumChatflowType } from '../../database/entities/ChatFlow'
import chatflowsService from '../../services/chatflows'
import chatMessagesService from '../../services/chat-messages'
import { clearSessionMemory } from '../../utils'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { DeleteResult } from 'typeorm'
import { ChatMessage } from '../../database/entities/ChatMessage'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { StatusCodes } from 'http-status-codes'
import { utilGetChatMessage } from '../../utils/getChatMessage'
import { getPageAndLimitParams } from '../../utils/pagination'
import logger from '../../utils/logger'
import { validateFlowAPIKey } from '../../utils/validateKey'

const getFeedbackTypeFilters = (_feedbackTypeFilters: ChatMessageRatingType[]): ChatMessageRatingType[] | undefined => {
    try {
        let feedbackTypeFilters
        const feedbackTypeFilterArray = JSON.parse(JSON.stringify(_feedbackTypeFilters))
        if (
            feedbackTypeFilterArray.includes(ChatMessageRatingType.THUMBS_UP) &&
            feedbackTypeFilterArray.includes(ChatMessageRatingType.THUMBS_DOWN)
        ) {
            feedbackTypeFilters = [ChatMessageRatingType.THUMBS_UP, ChatMessageRatingType.THUMBS_DOWN]
        } else if (feedbackTypeFilterArray.includes(ChatMessageRatingType.THUMBS_UP)) {
            feedbackTypeFilters = [ChatMessageRatingType.THUMBS_UP]
        } else if (feedbackTypeFilterArray.includes(ChatMessageRatingType.THUMBS_DOWN)) {
            feedbackTypeFilters = [ChatMessageRatingType.THUMBS_DOWN]
        } else {
            feedbackTypeFilters = undefined
        }
        return feedbackTypeFilters
    } catch (e) {
        return _feedbackTypeFilters
    }
}

type ChatflowPermissionAction = 'view' | 'delete'

const assertChatflowPermission = (req: Request, type: unknown, action: ChatflowPermissionAction): void => {
    if (req.user?.isOrganizationAdmin) return
    const permission =
        type === EnumChatflowType.CHATFLOW
            ? `chatflows:${action}`
            : type === EnumChatflowType.AGENTFLOW || type === EnumChatflowType.MULTIAGENT
            ? `agentflows:${action}`
            : type === EnumChatflowType.ASSISTANT
            ? `assistants:${action}`
            : undefined
    if (!permission || !req.user?.permissions?.includes(permission)) {
        throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Forbidden')
    }
}

const getAuthorizedChatflow = async (req: Request, action: ChatflowPermissionAction, requestedChatflowId?: string) => {
    const chatflowId = requestedChatflowId || req.params?.id
    if (!chatflowId) {
        throw new InternalFlowiseError(StatusCodes.PRECONDITION_FAILED, 'Chatflow id is required')
    }
    const workspaceId = req.user?.activeWorkspaceId
    if (!workspaceId) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Workspace not found')
    }
    const chatflow = await chatflowsService.getChatflowByIdForWorkspace(chatflowId, workspaceId)
    if (!chatflow) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Chatflow not found')
    }
    assertChatflowPermission(req, chatflow.type, action)
    return { chatflow, workspaceId }
}

const parseStrictBooleanQuery = (value: unknown, name: string): boolean => {
    if (value === undefined || value === false || value === 'false') return false
    if (value === true || value === 'true') return true
    throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, `${name} must be true or false`)
}

const groupChatMessagesBySession = (messages: ChatMessage[]): Map<string, ChatMessage[]> => {
    const groups = new Map<string, ChatMessage[]>()
    for (const message of messages) {
        const key = JSON.stringify([message.chatId, message.memoryType ?? null, message.sessionId ?? null])
        const existing = groups.get(key)
        if (existing) existing.push(message)
        else groups.set(key, [message])
    }
    return groups
}

const createChatMessage = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.body) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                'Error: chatMessagesController.createChatMessage - request body not provided!'
            )
        }
        const apiResponse = await chatMessagesService.createChatMessage(req.body)
        return res.json(parseAPIResponse(apiResponse))
    } catch (error) {
        next(error)
    }
}

const getAllChatMessages = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { workspaceId } = await getAuthorizedChatflow(req, 'view')
        const _chatTypes = req.query?.chatType as string | undefined
        let chatTypes: ChatType[] | undefined
        if (_chatTypes) {
            try {
                if (Array.isArray(_chatTypes)) {
                    chatTypes = _chatTypes
                } else {
                    chatTypes = JSON.parse(_chatTypes)
                }
            } catch (e) {
                chatTypes = [_chatTypes as ChatType]
            }
        }
        const sortOrder = req.query?.order as string | undefined
        const chatId = req.query?.chatId as string | undefined
        const memoryType = req.query?.memoryType as string | undefined
        const sessionId = req.query?.sessionId as string | undefined
        const messageId = req.query?.messageId as string | undefined
        const startDate = req.query?.startDate as string | undefined
        const endDate = req.query?.endDate as string | undefined
        const feedback = req.query?.feedback as boolean | undefined

        const { page, limit } = getPageAndLimitParams(req)

        let feedbackTypeFilters = req.query?.feedbackType as ChatMessageRatingType[] | undefined
        if (feedbackTypeFilters) {
            feedbackTypeFilters = getFeedbackTypeFilters(feedbackTypeFilters)
        }
        const apiResponse = await chatMessagesService.getAllChatMessages(
            req.params.id,
            chatTypes,
            sortOrder,
            chatId,
            memoryType,
            sessionId,
            startDate,
            endDate,
            messageId,
            feedback,
            feedbackTypeFilters,
            workspaceId,
            page,
            limit
        )
        return res.json(parseAPIResponse(apiResponse))
    } catch (error) {
        next(error)
    }
}

const getAllInternalChatMessages = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const { workspaceId } = await getAuthorizedChatflow(req, 'view')
        const sortOrder = req.query?.order as string | undefined
        const chatId = req.query?.chatId as string | undefined
        const memoryType = req.query?.memoryType as string | undefined
        const sessionId = req.query?.sessionId as string | undefined
        const messageId = req.query?.messageId as string | undefined
        const startDate = req.query?.startDate as string | undefined
        const endDate = req.query?.endDate as string | undefined
        const feedback = req.query?.feedback as boolean | undefined
        let feedbackTypeFilters = req.query?.feedbackType as ChatMessageRatingType[] | undefined
        if (feedbackTypeFilters) {
            feedbackTypeFilters = getFeedbackTypeFilters(feedbackTypeFilters)
        }
        const apiResponse = await chatMessagesService.getAllInternalChatMessages(
            req.params.id,
            [ChatType.INTERNAL],
            sortOrder,
            chatId,
            memoryType,
            sessionId,
            startDate,
            endDate,
            messageId,
            feedback,
            feedbackTypeFilters,
            workspaceId
        )
        return res.json(parseAPIResponse(apiResponse))
    } catch (error) {
        next(error)
    }
}

const removeAllChatMessages = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const appServer = getRunningExpressApp()
        const orgId = req.user?.activeOrganizationId
        if (!orgId) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Organization not found')
        }
        const { chatflow, workspaceId } = await getAuthorizedChatflow(req, 'delete')
        const chatflowid = req.params.id
        const parsedFlowData: IReactFlowObject = JSON.parse(chatflow.flowData)
        const nodes = parsedFlowData.nodes
        const chatId = req.query?.chatId as string | undefined
        const memoryType = req.query?.memoryType as string | undefined
        const sessionId = req.query?.sessionId as string | undefined
        const _chatTypes = req.query?.chatType as string | undefined
        let chatTypes: ChatType[] | undefined
        if (_chatTypes) {
            try {
                if (Array.isArray(_chatTypes)) {
                    chatTypes = _chatTypes
                } else {
                    chatTypes = JSON.parse(_chatTypes)
                }
            } catch (e) {
                chatTypes = [_chatTypes as ChatType]
            }
        }
        const startDate = req.query?.startDate as string | undefined
        const endDate = req.query?.endDate as string | undefined
        const isClearFromViewMessageDialog = parseStrictBooleanQuery(
            req.query?.isClearFromViewMessageDialog,
            'isClearFromViewMessageDialog'
        )
        const hardDelete = parseStrictBooleanQuery(req.query?.hardDelete, 'hardDelete')
        let feedbackTypeFilters = req.query?.feedbackType as ChatMessageRatingType[] | undefined
        if (feedbackTypeFilters) {
            feedbackTypeFilters = getFeedbackTypeFilters(feedbackTypeFilters)
        }

        const messages = await utilGetChatMessage({
            chatflowid,
            chatTypes,
            chatId,
            memoryType,
            sessionId,
            startDate,
            endDate,
            feedback: feedbackTypeFilters?.length ? true : false,
            feedbackTypes: feedbackTypeFilters,
            activeWorkspaceId: workspaceId
        })
        if (messages.length === 0) {
            const result: DeleteResult = { raw: [], affected: 0 }
            return res.json(result)
        }

        const sessionGroups = groupChatMessagesBySession(messages)
        const shouldClearThirdPartyMemory = Boolean(chatId) || hardDelete
        if (shouldClearThirdPartyMemory) {
            for (const group of sessionGroups.values()) {
                const message = group[0]
                await clearSessionMemory(
                    nodes,
                    appServer.nodesPool.componentNodes,
                    message.chatId,
                    appServer.AppDataSource,
                    orgId,
                    message.sessionId,
                    message.memoryType,
                    isClearFromViewMessageDialog,
                    workspaceId,
                    chatflowid
                )
            }
        }

        const apiResponse = await chatMessagesService.removeChatMessagesByMessageIds(
            chatflowid,
            messages.map((message) => message.id),
            orgId,
            workspaceId,
            appServer.usageCacheManager
        )
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const abortChatMessage = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.chatflowid || !req.params.chatid) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: chatMessagesController.abortChatMessage - chatflowid or chatid not provided!`
            )
        }
        const chatflowId = req.params.chatflowid
        if (req.user) {
            await getAuthorizedChatflow(req, 'view', chatflowId)
        } else {
            const chatflow = await chatflowsService.getChatflowById(chatflowId)
            if (!(await validateFlowAPIKey(req, chatflow))) {
                throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, 'Chat abort is not authorized')
            }
        }
        await chatMessagesService.abortChatMessage(req.params.chatid, chatflowId)
        return res.json({ status: 200, message: 'Chat message aborted' })
    } catch (error) {
        next(error)
    }
}

const parseAPIResponse = (apiResponse: ChatMessage | ChatMessage[]): ChatMessage | ChatMessage[] => {
    const parseResponse = (response: ChatMessage): ChatMessage => {
        const parsedResponse = { ...response }

        try {
            if (parsedResponse.sourceDocuments) {
                parsedResponse.sourceDocuments = JSON.parse(parsedResponse.sourceDocuments)
            }
            if (parsedResponse.usedTools) {
                parsedResponse.usedTools = JSON.parse(parsedResponse.usedTools)
            }
            if (parsedResponse.fileAnnotations) {
                parsedResponse.fileAnnotations = JSON.parse(parsedResponse.fileAnnotations)
            }
            if (parsedResponse.agentReasoning) {
                parsedResponse.agentReasoning = JSON.parse(parsedResponse.agentReasoning)
            }
            if (parsedResponse.reasonContent) {
                parsedResponse.reasonContent = JSON.parse(parsedResponse.reasonContent)
            }
            if (parsedResponse.fileUploads) {
                parsedResponse.fileUploads = JSON.parse(parsedResponse.fileUploads)
            }
            if (parsedResponse.action) {
                parsedResponse.action = JSON.parse(parsedResponse.action)
            }
            if (parsedResponse.artifacts) {
                parsedResponse.artifacts = JSON.parse(parsedResponse.artifacts)
            }
        } catch {
            logger.warn('[server]: Unable to parse chat message metadata')
        }

        return parsedResponse
    }

    if (Array.isArray(apiResponse)) {
        return apiResponse.map(parseResponse)
    } else {
        return parseResponse(apiResponse)
    }
}

export default {
    createChatMessage,
    getAllChatMessages,
    getAllInternalChatMessages,
    removeAllChatMessages,
    abortChatMessage
}
