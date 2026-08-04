import { StatusCodes } from 'http-status-codes'
import type { EntityManager } from 'typeorm'
import { DocumentStore } from '../../database/entities/DocumentStore'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { updateExistingDocumentStore } from './documentStoreRevision'

const normalizeRequestedStoreIds = (storeIds: string | string[] | undefined): Set<string> => {
    const requestedStoreIds = storeIds === undefined ? [] : Array.isArray(storeIds) ? storeIds : [storeIds]
    if (requestedStoreIds.some((storeId) => typeof storeId !== 'string' || !storeId.trim() || storeId.includes('\0'))) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Document store usage request is invalid')
    }
    return new Set(requestedStoreIds)
}

/**
 * Synchronizes one flow's complete DocumentStore reference set using the
 * caller's transaction. Every existing usage index is parsed before the first
 * update, and every mutation is workspace-scoped and revision-guarded.
 */
export const updateDocumentStoreUsageWithManager = async (
    manager: EntityManager,
    chatId: string,
    storeIds: string | string[] | undefined,
    workspaceId: string
): Promise<void> => {
    if (!workspaceId || !chatId || chatId.includes('\0')) {
        throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Document store operation is not authorized')
    }
    const selectedStoreIds = normalizeRequestedStoreIds(storeIds)
    const documentStoreRepository = manager.getRepository(DocumentStore)
    const entities = await documentStoreRepository.findBy({ workspaceId })

    const workspaceStoreIds = new Set(entities.map((entity) => entity.id))
    if ([...selectedStoreIds].some((storeId) => !workspaceStoreIds.has(storeId))) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'One or more document stores were not found in the workspace')
    }

    const usageEntries = entities.map((entity) => {
        let whereUsed: unknown
        try {
            whereUsed = JSON.parse(entity.whereUsed)
        } catch {
            throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Document store usage data is invalid')
        }
        if (!Array.isArray(whereUsed) || whereUsed.some((flowId) => typeof flowId !== 'string')) {
            throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Document store usage data is invalid')
        }
        return { entity, whereUsed }
    })

    for (const { entity, whereUsed } of usageEntries) {
        const nextWhereUsed = [...new Set(whereUsed.filter((flowId) => flowId !== chatId))]
        if (selectedStoreIds.has(entity.id)) nextWhereUsed.push(chatId)
        if (JSON.stringify(nextWhereUsed) === JSON.stringify(whereUsed)) continue

        await updateExistingDocumentStore(
            documentStoreRepository,
            entity,
            { whereUsed: JSON.stringify(nextWhereUsed) },
            'Document store usage changed concurrently'
        )
    }
}
