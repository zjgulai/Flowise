import { StatusCodes } from 'http-status-codes'
import type { EntityManager } from 'typeorm'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { type IComponentNodes, Platform } from '../../Interface'
import { extractDocumentStoreIds } from '../chatflows'
import {
    extractCustomAssistantDocumentStoreUsageForImport,
    mergeDocumentStoreUsageReferencesForImport,
    preflightDocumentStoreReferencesForImport,
    remapDocumentStoreIdsForImport,
    sanitizeDocumentStoresForImport
} from './documentStoreImport'
import { normalizeWorkspaceImportForCreate, preflightWorkspaceImportRelations, type WorkspaceImportData } from './workspaceImportSecurity'
import { sanitizeWorkspaceExportWireData } from './workspaceExportSanitization'

const PORTABILITY_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001'
const EMPTY_TARGET_MANAGER = {
    connection: { options: { type: 'sqlite' } },
    find: async () => []
} as unknown as EntityManager

const portabilityFailure = (): never => {
    throw new InternalFlowiseError(StatusCodes.UNPROCESSABLE_ENTITY, '工作区包含无法安全恢复的数据，导出已中止；请先修复超限或非规范记录')
}

export interface WorkspaceExportManifest {
    formatVersion: 1
    dependencyMode: 'record-closure'
    selectedCategories: string[]
    includedDependencies: {
        flows: number
        tools: number
        documentStores: number
        variables: number
    }
    rebindRequired: [
        'credentials',
        'variable-values',
        'mcp-connections',
        'api-key-and-rate-limit-policy',
        'provider-and-http-options',
        'local-file-and-directory-paths'
    ]
    reviewRequired: ['preserved-provider-and-http-targets']
    restoreScope: 'structure-and-selected-user-content'
    contentWarning: 'contains-user-data-and-custom-code-review-before-sharing'
}

export type WorkspaceExportArtifact = WorkspaceImportData & { ExportManifest: WorkspaceExportManifest }

const toWireData = (value: unknown): unknown => {
    try {
        const serialized = JSON.stringify(value)
        if (!serialized) portabilityFailure()
        return JSON.parse(serialized)
    } catch {
        return portabilityFailure()
    }
}

const stripPublicServerState = (data: WorkspaceImportData): WorkspaceImportData => ({
    ...data,
    AgentFlow: data.AgentFlow.map(({ workspaceId: _workspaceId, deployed: _deployed, isPublic: _isPublic, ...flow }) => flow as never),
    AgentFlowV2: data.AgentFlowV2.map(({ workspaceId: _workspaceId, deployed: _deployed, isPublic: _isPublic, ...flow }) => flow as never),
    AssistantFlow: data.AssistantFlow.map(
        ({ workspaceId: _workspaceId, deployed: _deployed, isPublic: _isPublic, ...flow }) => flow as never
    ),
    ChatFlow: data.ChatFlow.map(({ workspaceId: _workspaceId, deployed: _deployed, isPublic: _isPublic, ...flow }) => flow as never),
    AssistantCustom: data.AssistantCustom.map(({ workspaceId: _workspaceId, credential: _credential, ...assistant }) => assistant as never),
    CustomTemplate: data.CustomTemplate.map(({ workspaceId: _workspaceId, ...template }) => template as never),
    DocumentStore: data.DocumentStore.map(
        ({ workspaceId: _workspaceId, generationId: _generationId, revision: _revision, ...documentStore }) => documentStore as never
    ),
    Execution: data.Execution.map(({ workspaceId: _workspaceId, isPublic: _isPublic, ...execution }) => execution as never),
    Tool: data.Tool.map(({ workspaceId: _workspaceId, ...tool }) => tool as never),
    Variable: data.Variable.map(({ workspaceId: _workspaceId, ...variable }) => ({ ...variable, value: '' } as never))
})

const normalizeAndPreflightFreshTarget = async (wireData: unknown, platform: Platform): Promise<WorkspaceImportData> => {
    let normalized = normalizeWorkspaceImportForCreate(wireData, PORTABILITY_WORKSPACE_ID, platform)
    if (normalized.DocumentStore.length > 0 || normalized.DocumentStoreFileChunk.length > 0) {
        normalized.DocumentStore = sanitizeDocumentStoresForImport(
            normalized.DocumentStore.map((documentStore) => ({ ...documentStore, workspaceId: PORTABILITY_WORKSPACE_ID }))
        )
        normalized = remapDocumentStoreIdsForImport(
            normalized,
            normalized.DocumentStore.map((documentStore) => documentStore.id)
        ).data
    }

    const importedFlows = [...normalized.AgentFlow, ...normalized.AgentFlowV2, ...normalized.AssistantFlow, ...normalized.ChatFlow]
    const usageReferences = mergeDocumentStoreUsageReferencesForImport([
        ...importedFlows.map((flow) => ({ id: flow.id, documentStoreIds: extractDocumentStoreIds(flow.flowData) })),
        ...extractCustomAssistantDocumentStoreUsageForImport(normalized.AssistantCustom)
    ])
    const templateStoreIds = normalized.CustomTemplate.flatMap((template) => extractDocumentStoreIds(template.flowData))

    normalized.DocumentStore = await preflightDocumentStoreReferencesForImport(
        EMPTY_TARGET_MANAGER,
        normalized.DocumentStore,
        usageReferences,
        templateStoreIds,
        PORTABILITY_WORKSPACE_ID
    )
    await preflightWorkspaceImportRelations(EMPTY_TARGET_MANAGER, normalized, PORTABILITY_WORKSPACE_ID)
    return normalized
}

/**
 * A successful workspace export must pass the same bounded normalization and
 * fresh-target relationship checks as its importer. This is validation-only:
 * regenerated IDs and sanitized state are discarded, and the source payload is
 * never mutated.
 */
export const assertWorkspaceExportPortable = async (
    exportData: WorkspaceImportData,
    platform: Platform = Platform.OPEN_SOURCE
): Promise<void> => {
    try {
        await normalizeAndPreflightFreshTarget(toWireData(exportData), platform)
    } catch (error) {
        if (error instanceof InternalFlowiseError) portabilityFailure()
        throw error
    }
}

/**
 * Build the one and only public download object. The exact object returned by
 * this function is sanitized, normalized, fresh-target preflighted, stripped
 * of server lifecycle state, and then preflighted again without transformation.
 */
export const createWorkspaceExportArtifact = async (
    rawData: WorkspaceImportData,
    manifest: WorkspaceExportManifest,
    componentNodes: IComponentNodes,
    canonicalOrigin: string,
    platform: Platform = Platform.OPEN_SOURCE
): Promise<WorkspaceExportArtifact> => {
    try {
        const sanitized = sanitizeWorkspaceExportWireData(rawData, componentNodes, canonicalOrigin)
        const normalized = await normalizeAndPreflightFreshTarget(sanitized, platform)
        const publicData = stripPublicServerState(normalized)
        const artifact = { ...publicData, ExportManifest: manifest }
        await normalizeAndPreflightFreshTarget(toWireData(artifact), platform)
        return artifact
    } catch (error) {
        if (error instanceof InternalFlowiseError) portabilityFailure()
        throw error
    }
}
