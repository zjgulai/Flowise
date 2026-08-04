import { removeFolderFromStorage } from 'flowise-components'
import { StatusCodes } from 'http-status-codes'
import { DataSource, EntityManager } from 'typeorm'
import { Assistant } from '../../database/entities/Assistant'
import { ChatFlow, EnumChatflowType } from '../../database/entities/ChatFlow'
import { ChatMessage } from '../../database/entities/ChatMessage'
import { ChatMessageFeedback } from '../../database/entities/ChatMessageFeedback'
import { DocumentStore } from '../../database/entities/DocumentStore'
import { Evaluation } from '../../database/entities/Evaluation'
import { Execution } from '../../database/entities/Execution'
import { Lead } from '../../database/entities/Lead'
import { UpsertHistory } from '../../database/entities/UpsertHistory'
import { Workspace } from '../../enterprise/database/entities/workspace.entity'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { UsageCacheManager } from '../../UsageCacheManager'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import logger from '../../utils/logger'
import { updateStorageUsage } from '../../utils/quotaUsage'
import { updateExistingDocumentStore } from '../documentstore/documentStoreRevision'
import {
    assertAssistantSnapshot,
    assertChatflowSnapshot,
    assertExpectedFlowTarget,
    assertUuid,
    extractPersistedFlowId,
    validateCustomAssistantSnapshotRequest
} from './customAssistantSave'

interface RepositoryProvider {
    getRepository: EntityManager['getRepository']
}

interface CleanupLogger {
    error: (message: string, metadata?: Record<string, unknown>) => unknown
}

export interface CustomAssistantDeleteResult {
    assistantId: string
    chatflowId: string | null
    deleted: true
}

export interface CustomAssistantDeleteDependencies {
    dataSource: DataSource
    usageCacheManager: UsageCacheManager
    removeFolderFromStorageFn?: typeof removeFolderFromStorage
    updateStorageUsageFn?: typeof updateStorageUsage
    cleanupLogger?: CleanupLogger
}

const badRequest = (message: string) => new InternalFlowiseError(StatusCodes.BAD_REQUEST, message)
const conflict = (message: string) => new InternalFlowiseError(StatusCodes.CONFLICT, message)

const listCustomAssistantFlowReferences = async (
    repositoryProvider: RepositoryProvider,
    workspaceId: string
): Promise<Array<{ assistantId: string; flowId: string | null }>> => {
    const assistants = await repositoryProvider.getRepository(Assistant).findBy({ workspaceId, type: 'CUSTOM' })
    const references: Array<{ assistantId: string; flowId: string | null }> = []
    for (const assistant of assistants) {
        let flowId: string | null
        try {
            flowId = extractPersistedFlowId(assistant.details)
        } catch {
            throw conflict('Unable to verify custom assistant flow ownership')
        }
        references.push({ assistantId: assistant.id, flowId })
    }
    return references
}

export const assertChatflowNotLinkedToCustomAssistant = async (
    repositoryProvider: RepositoryProvider,
    chatflowId: string,
    workspaceId: string
): Promise<void> => {
    const references = await listCustomAssistantFlowReferences(repositoryProvider, workspaceId)
    if (references.some((reference) => reference.flowId === chatflowId)) {
        throw conflict('Linked custom assistant flow must be deleted through the custom assistant endpoint')
    }
}

const assertOnlyCustomAssistantReference = async (manager: EntityManager, assistantId: string, flowId: string, workspaceId: string) => {
    const references = await listCustomAssistantFlowReferences(manager, workspaceId)
    if (references.some((reference) => reference.assistantId !== assistantId && reference.flowId === flowId)) {
        throw conflict('Linked flow is referenced by another custom assistant')
    }
}

const EVALUATION_CHATFLOW_TYPES = new Set(['Agentflow v2', 'Chatflow', 'Custom Assistant'])

const assertNoEvaluationReference = async (manager: EntityManager, assistantId: string, workspaceId: string) => {
    const evaluations = await manager.getRepository(Evaluation).findBy({ workspaceId })
    for (const evaluation of evaluations) {
        let chatflowIds: unknown
        let additionalConfig: unknown
        try {
            chatflowIds = JSON.parse(evaluation.chatflowId)
            additionalConfig = JSON.parse(evaluation.additionalConfig)
        } catch {
            throw conflict('Unable to verify custom assistant evaluation references')
        }
        if (
            !Array.isArray(chatflowIds) ||
            chatflowIds.some((id) => typeof id !== 'string' || id.trim().length === 0) ||
            !additionalConfig ||
            typeof additionalConfig !== 'object' ||
            Array.isArray(additionalConfig)
        ) {
            throw conflict('Unable to verify custom assistant evaluation references')
        }
        const chatflowTypes = (additionalConfig as Record<string, unknown>).chatflowTypes
        if (
            !Array.isArray(chatflowTypes) ||
            chatflowTypes.length !== chatflowIds.length ||
            chatflowTypes.some((type) => typeof type !== 'string' || !EVALUATION_CHATFLOW_TYPES.has(type))
        ) {
            throw conflict('Unable to verify custom assistant evaluation references')
        }
        if (chatflowIds.some((id, index) => id === assistantId && chatflowTypes[index] === 'Custom Assistant')) {
            throw conflict('Custom assistant is referenced by an evaluation')
        }
    }
}

const removeDocumentStoreUsage = async (manager: EntityManager, flowId: string, workspaceId: string) => {
    const documentStoreRepository = manager.getRepository(DocumentStore)
    const documentStores = await documentStoreRepository.findBy({ workspaceId })
    for (const documentStore of documentStores) {
        if (!documentStore.whereUsed) continue
        let whereUsed: unknown
        try {
            whereUsed = JSON.parse(documentStore.whereUsed)
        } catch {
            throw conflict('Document store usage is invalid')
        }
        if (!Array.isArray(whereUsed) || whereUsed.some((entry) => typeof entry !== 'string')) {
            throw conflict('Document store usage is invalid')
        }
        const nextWhereUsed = whereUsed.filter((entry) => entry !== flowId)
        if (nextWhereUsed.length === whereUsed.length) continue
        await updateExistingDocumentStore(
            documentStoreRepository,
            documentStore,
            { whereUsed: JSON.stringify(nextWhereUsed) },
            'Document store usage changed concurrently'
        )
    }
}

export const deleteCustomAssistantWithDependencies = async (
    assistantId: string,
    requestBody: unknown,
    organizationId: string,
    workspaceId: string,
    dependencies: CustomAssistantDeleteDependencies
): Promise<CustomAssistantDeleteResult> => {
    assertUuid(assistantId, 'assistantId')
    if (!organizationId || !workspaceId) throw badRequest('Organization and workspace are required')
    const request = validateCustomAssistantSnapshotRequest(requestBody)

    const result = await dependencies.dataSource.transaction(async (manager) => {
        const workspace = await manager.getRepository(Workspace).findOneBy({ id: workspaceId, organizationId })
        if (!workspace) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Workspace ${workspaceId} not found in organization ${organizationId}`)
        }

        const assistantRepository = manager.getRepository(Assistant)
        const assistant = await assistantRepository.findOneBy({ id: assistantId, workspaceId })
        if (!assistant) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Assistant ${assistantId} not found`)
        if (assistant.type !== 'CUSTOM') throw badRequest(`Assistant ${assistantId} is not a custom assistant`)
        assertAssistantSnapshot(assistant, request.expectedAssistant)

        const flowId = extractPersistedFlowId(assistant.details)
        assertExpectedFlowTarget(flowId, request.expectedChatflow)
        await assertNoEvaluationReference(manager, assistant.id, workspaceId)

        if (!flowId) {
            const assistantDelete = await assistantRepository.delete({
                id: assistant.id,
                workspaceId,
                type: 'CUSTOM',
                updatedDate: assistant.updatedDate,
                details: assistant.details
            })
            if (assistantDelete.affected !== 1) throw conflict('Assistant was modified concurrently')
            return { assistantId, chatflowId: null, deleted: true as const }
        }

        const chatflowRepository = manager.getRepository(ChatFlow)
        const chatflow = await chatflowRepository.findOneBy({ id: flowId, workspaceId, type: EnumChatflowType.ASSISTANT })
        if (!chatflow || !request.expectedChatflow) {
            throw conflict('Linked assistant flow is missing or outside the active workspace')
        }
        assertChatflowSnapshot(chatflow, request.expectedChatflow)
        await assertOnlyCustomAssistantReference(manager, assistant.id, flowId, workspaceId)

        await manager.getRepository(ChatMessageFeedback).delete({ chatflowid: flowId })
        await manager.getRepository(ChatMessage).delete({ chatflowid: flowId })
        await manager.getRepository(Execution).delete({ agentflowId: flowId, workspaceId })
        await manager.getRepository(Lead).delete({ chatflowid: flowId })
        await manager.getRepository(UpsertHistory).delete({ chatflowid: flowId })
        await removeDocumentStoreUsage(manager, flowId, workspaceId)

        const chatflowDelete = await chatflowRepository.delete({
            id: chatflow.id,
            workspaceId,
            type: EnumChatflowType.ASSISTANT,
            updatedDate: chatflow.updatedDate,
            name: chatflow.name,
            flowData: chatflow.flowData
        })
        if (chatflowDelete.affected !== 1) throw conflict('Linked assistant flow was modified concurrently')

        const assistantDelete = await assistantRepository.delete({
            id: assistant.id,
            workspaceId,
            type: 'CUSTOM',
            updatedDate: assistant.updatedDate,
            details: assistant.details
        })
        if (assistantDelete.affected !== 1) throw conflict('Assistant was modified concurrently')

        return { assistantId, chatflowId: flowId, deleted: true as const }
    })

    if (result.chatflowId) {
        const cleanupLogger = dependencies.cleanupLogger ?? logger
        let totalSize: number
        try {
            const cleanup = await (dependencies.removeFolderFromStorageFn ?? removeFolderFromStorage)(organizationId, result.chatflowId)
            totalSize = cleanup.totalSize
        } catch {
            cleanupLogger.error('[server]: Custom assistant post-commit storage cleanup failed', { failedCount: 1 })
            return result
        }
        try {
            await (dependencies.updateStorageUsageFn ?? updateStorageUsage)(
                organizationId,
                workspaceId,
                totalSize,
                dependencies.usageCacheManager
            )
        } catch {
            cleanupLogger.error('[server]: Custom assistant post-commit usage update failed', { failedCount: 1 })
        }
    }
    return result
}

export const deleteCustomAssistant = async (
    assistantId: string,
    requestBody: unknown,
    organizationId: string,
    workspaceId: string
): Promise<CustomAssistantDeleteResult> => {
    try {
        const appServer = getRunningExpressApp()
        return await deleteCustomAssistantWithDependencies(assistantId, requestBody, organizationId, workspaceId, {
            dataSource: appServer.AppDataSource,
            usageCacheManager: appServer.usageCacheManager
        })
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Unable to delete custom assistant')
    }
}
