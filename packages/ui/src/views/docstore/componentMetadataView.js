import {
    createMetadataDisplayView,
    getMetadataDisplayText,
    getNodeMetadataSearchTexts,
    resolveCurrentMetadataItem
} from '@/utils/componentMetadataDisplay'

export const getDocStoreComponentDisplayLabel = (component, fallback = '') => getMetadataDisplayText(component, 'label', fallback)

export const getDocStoreComponentDisplayDescription = (component, fallback = '') =>
    getMetadataDisplayText(component, 'description', fallback)

export const matchesDocStoreComponentSearch = (component, searchValue) => {
    const query = searchValue.trim().toLocaleLowerCase()
    if (!query) return true
    return getNodeMetadataSearchTexts(component).some((value) => value.toLocaleLowerCase().includes(query))
}

export const createDocStoreInputView = (inputParam, componentMetadata) => {
    if (!inputParam) return inputParam
    const currentInput = resolveCurrentMetadataItem(componentMetadata, inputParam) ?? inputParam
    return createMetadataDisplayView(inputParam, currentInput)
}
