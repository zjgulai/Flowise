export const deleteAssistantFileSearchFile = async ({
    fileId,
    toolResources,
    credential,
    assistantScope,
    vectorStoreGeneration,
    requestConfig,
    isAssistantScopeCurrent,
    isVectorStoreGenerationCurrent,
    deleteFiles,
    getCurrentToolResources,
    commitToolResources
}) => {
    const vectorStoreId = toolResources.file_search?.vector_store_ids?.length ? toolResources.file_search.vector_store_ids[0] : ''
    const hasLocalFile = (toolResources.file_search?.files ?? []).some((file) => file?.id === fileId)

    if (
        !fileId ||
        !vectorStoreId ||
        !hasLocalFile ||
        !isAssistantScopeCurrent(assistantScope) ||
        !isVectorStoreGenerationCurrent(vectorStoreGeneration)
    ) {
        return false
    }

    const deleteResponse = await deleteFiles(vectorStoreId, credential, { file_ids: [fileId] }, requestConfig)
    const deletedFileIds = deleteResponse?.data?.deletedFileIds
    if (!Array.isArray(deletedFileIds) || deletedFileIds.length !== 1 || deletedFileIds[0] !== fileId || deleteResponse.data.count !== 1) {
        return false
    }
    if (!isAssistantScopeCurrent(assistantScope) || !isVectorStoreGenerationCurrent(vectorStoreGeneration)) return false

    const currentToolResources = getCurrentToolResources()
    if (
        currentToolResources.file_search?.vector_store_ids?.[0] !== vectorStoreId ||
        !(currentToolResources.file_search?.files ?? []).some((file) => file?.id === fileId)
    ) {
        return false
    }

    commitToolResources({
        ...currentToolResources,
        file_search: {
            ...currentToolResources.file_search,
            files: (currentToolResources.file_search?.files ?? []).filter((file) => file.id !== fileId)
        }
    })

    return true
}
