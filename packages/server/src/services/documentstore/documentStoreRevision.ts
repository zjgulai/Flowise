import { StatusCodes } from 'http-status-codes'
import type { Repository } from 'typeorm'
import { DocumentStore } from '../../database/entities/DocumentStore'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'

export interface DocumentStoreRevisionIdentity {
    id: string
    workspaceId: string
    generationId: string
    revision: number
}

/**
 * Builds a cross-database optimistic-lock predicate. Use it only with an
 * explicit update/delete whose affected-row count is verified; a TypeORM save
 * does not include the prior revision in its update predicate. The integer
 * revision avoids date precision and text-collation differences between the
 * supported databases.
 */
export const createDocumentStoreRevisionPredicate = (entity: DocumentStoreRevisionIdentity): DocumentStoreRevisionIdentity => ({
    id: entity.id,
    workspaceId: entity.workspaceId,
    generationId: entity.generationId,
    revision: entity.revision
})

export type DocumentStoreMutablePatch = Partial<
    Pick<
        DocumentStore,
        'name' | 'description' | 'loaders' | 'whereUsed' | 'status' | 'vectorStoreConfig' | 'embeddingConfig' | 'recordManagerConfig'
    >
>

const DOCUMENT_STORE_MUTABLE_FIELDS = [
    'name',
    'description',
    'loaders',
    'whereUsed',
    'status',
    'vectorStoreConfig',
    'embeddingConfig',
    'recordManagerConfig'
] as const

export const getDocumentStoreMutablePatch = (source: DocumentStoreMutablePatch): DocumentStoreMutablePatch => {
    const patch: DocumentStoreMutablePatch = {}
    for (const field of DOCUMENT_STORE_MUTABLE_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(source, field) && source[field] !== undefined) {
            Object.assign(patch, { [field]: source[field] })
        }
    }
    return patch
}

/**
 * Updates an existing DocumentStore with a workspace-scoped optimistic lock.
 * TypeORM advances the VersionColumn for Repository.update, while the exact
 * revision predicate prevents stale saves, ABA restoration, and revision
 * regression. Callers can use a transaction-scoped repository to commit child
 * mutations and the parent CAS atomically.
 */
export const updateExistingDocumentStore = async (
    repository: Repository<DocumentStore>,
    entity: DocumentStore,
    changes: DocumentStoreMutablePatch,
    conflictMessage = 'Document store changed concurrently'
): Promise<DocumentStore> => {
    const patch = getDocumentStoreMutablePatch(changes)
    if (Object.keys(patch).length === 0) return entity
    if (!entity.id || !entity.workspaceId || !entity.generationId || !Number.isInteger(entity.revision) || entity.revision < 1) {
        throw new InternalFlowiseError(StatusCodes.CONFLICT, conflictMessage)
    }

    const expectedRevision = entity.revision
    const result = await repository.update(createDocumentStoreRevisionPredicate(entity), patch)
    if (result.affected !== 1) {
        throw new InternalFlowiseError(StatusCodes.CONFLICT, conflictMessage)
    }

    Object.assign(entity, patch, { revision: expectedRevision + 1 })
    return entity
}
