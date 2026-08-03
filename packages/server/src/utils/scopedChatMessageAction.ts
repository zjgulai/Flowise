import { FindOptionsWhere, Repository } from 'typeorm'
import { ChatMessage } from '../database/entities/ChatMessage'

type ChatMessageActionRepository = Pick<Repository<ChatMessage>, 'find' | 'update'>

export interface ClearScopedChatMessageActionOptions {
    chatflowId: string
    chatId: string
    sessionId?: string
    executionId?: string
    actionId?: unknown
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

const actionMatches = (serializedAction: string, expectedActionId: unknown): boolean => {
    if (expectedActionId === undefined) return true
    if (!isNonEmptyString(expectedActionId)) return false

    try {
        const action = JSON.parse(serializedAction) as { id?: unknown }
        return action?.id === expectedActionId
    } catch {
        return false
    }
}

/**
 * Clears one pending HITL action without allowing caller-controlled chat/session
 * identifiers to escape the current flow (and V2 execution when supplied).
 */
export const clearScopedChatMessageAction = async (
    repository: ChatMessageActionRepository,
    options: ClearScopedChatMessageActionOptions
): Promise<boolean> => {
    const { chatflowId, chatId, sessionId, executionId, actionId } = options
    if (!isNonEmptyString(chatflowId) || !isNonEmptyString(chatId)) return false
    if (executionId !== undefined && !isNonEmptyString(executionId)) return false

    const scope = {
        chatflowid: chatflowId,
        ...(executionId ? { executionId } : {})
    }
    const where: FindOptionsWhere<ChatMessage>[] = [{ ...scope, chatId }]
    if (isNonEmptyString(sessionId)) where.push({ ...scope, sessionId })

    const candidates = await repository.find({
        where,
        order: { createdDate: 'DESC' },
        take: 100
    })

    for (const candidate of candidates) {
        if (!candidate.action || !actionMatches(candidate.action, actionId)) continue

        const result = await repository.update(
            {
                id: candidate.id,
                chatflowid: chatflowId,
                ...(executionId ? { executionId } : {}),
                action: candidate.action
            },
            { action: null }
        )
        if (result.affected === 1) return true
    }

    return false
}
