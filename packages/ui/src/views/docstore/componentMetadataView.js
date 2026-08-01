import { getMetadataDisplayText, getNodeMetadataSearchTexts, resolveCurrentMetadataItem } from '@/utils/componentMetadataDisplay'

const METADATA_CONTAINERS = ['inputs', 'output', 'options', 'tabs', 'array', 'datagrid']
const DISPLAY_FIELDS = ['label', 'description', 'warning', 'placeholder', 'badge', 'headerName']

const matchesMetadataItem = (candidate, target) => {
    if (!candidate || !target || typeof candidate !== 'object' || typeof target !== 'object') return false
    if (target.name !== undefined && candidate.name !== target.name) return false
    if (target.field !== undefined && candidate.field !== target.field) return false
    if (target.type !== undefined && candidate.type !== target.type) return false
    return target.name !== undefined || target.field !== undefined
}

const findCurrentChild = (currentParent, container, rawChild) => {
    const candidates = currentParent?.[container]
    if (!Array.isArray(candidates)) return undefined
    return candidates.find((candidate) => matchesMetadataItem(candidate, rawChild))
}

const buildDisplayView = (rawMetadata, currentMetadata = rawMetadata) => {
    if (Array.isArray(rawMetadata)) return rawMetadata.map((item) => buildDisplayView(item, item))
    if (!rawMetadata || typeof rawMetadata !== 'object') return rawMetadata

    const view = { ...rawMetadata }
    for (const field of DISPLAY_FIELDS) {
        if (rawMetadata[field] !== undefined || currentMetadata?.[`display${field[0].toUpperCase()}${field.slice(1)}`] !== undefined) {
            view[field] = getMetadataDisplayText(currentMetadata, field, rawMetadata[field])
        }
    }

    for (const container of METADATA_CONTAINERS) {
        if (!Array.isArray(rawMetadata[container])) continue
        view[container] = rawMetadata[container].map((rawChild) =>
            buildDisplayView(rawChild, findCurrentChild(currentMetadata, container, rawChild) ?? rawChild)
        )
    }

    return view
}

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
    return buildDisplayView(inputParam, currentInput)
}
