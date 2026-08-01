const DISPLAY_FIELD_BY_RAW = Object.freeze({
    label: 'displayLabel',
    category: 'displayCategory',
    description: 'displayDescription',
    warning: 'displayWarning',
    placeholder: 'displayPlaceholder',
    badge: 'displayBadge',
    deprecateMessage: 'displayDeprecateMessage',
    headerName: 'displayHeaderName',
    hint: 'displayHint'
})

const PERSISTED_NODE_METADATA_CONTAINERS = ['inputParams', 'inputAnchors', 'outputAnchors']
const METADATA_CONTAINERS = [
    'inputs',
    'output',
    'outputs',
    'options',
    'tabs',
    'array',
    'datagrid',
    'credential',
    'hint',
    ...PERSISTED_NODE_METADATA_CONTAINERS
]
const DISPLAY_METADATA_FIELDS = new Set([...Object.values(DISPLAY_FIELD_BY_RAW), 'displayLocale'])
const rawOptionSearchTextByView = new WeakMap()

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const getMetadataDisplayText = (metadata, field, fallback = '') => {
    const safeFallback = typeof fallback === 'string' ? fallback : ''
    if (!metadata || typeof metadata !== 'object') return safeFallback
    const displayField = DISPLAY_FIELD_BY_RAW[field]
    const displayValue = displayField ? metadata[displayField] : undefined
    if (typeof displayValue === 'string' && displayValue) return displayValue
    const rawValue = metadata[field]
    return typeof rawValue === 'string' && rawValue ? rawValue : safeFallback
}

const candidateMatches = (candidate, target) => {
    if (!candidate || !target || typeof candidate !== 'object' || typeof target !== 'object') return false
    if (target.name !== undefined && candidate.name !== target.name) return false
    if (target.field !== undefined && candidate.field !== target.field) return false
    if (target.type !== undefined && candidate.type !== target.type) return false
    return target.name !== undefined || target.field !== undefined
}

const findMetadataItem = (root, target) => {
    if (!root || !target || typeof root !== 'object') return undefined
    if (candidateMatches(root, target)) return root

    if (root.credential) {
        const credentialMatch = findMetadataItem(root.credential, target)
        if (credentialMatch) return credentialMatch
    }

    for (const container of METADATA_CONTAINERS) {
        const values = root[container]
        if (!Array.isArray(values)) continue
        for (const value of values) {
            const match = findMetadataItem(value, target)
            if (match) return match
        }
    }
    return undefined
}

export const resolveCurrentMetadataItem = (componentMetadata, savedMetadata, parentMetadata) => {
    if (!savedMetadata) return savedMetadata
    const sanitizedSavedMetadata = stripDisplayMetadata(savedMetadata)
    if (!componentMetadata) return sanitizedSavedMetadata

    if (parentMetadata) {
        const currentParent = findMetadataItem(componentMetadata, parentMetadata)
        const nestedMatch = findMetadataItem(currentParent, savedMetadata)
        if (nestedMatch) return nestedMatch
    }
    return findMetadataItem(componentMetadata, savedMetadata) ?? sanitizedSavedMetadata
}

export const localizeOptionViews = (rawOptions = [], currentOptions = []) =>
    rawOptions.map((option) => {
        if (typeof option === 'string') return option
        if (!option || typeof option !== 'object') return option
        const current =
            currentOptions.find(
                (candidate) => candidate && typeof candidate === 'object' && candidate.name !== undefined && candidate.name === option.name
            ) ?? option
        const description =
            typeof current.displayDescription === 'string' && current.displayDescription
                ? current.displayDescription
                : typeof current.description === 'string' && current.description
                ? current.description
                : typeof option.description === 'string'
                ? option.description
                : undefined
        const localizedOption = {
            ...option,
            label: getMetadataDisplayText(current, 'label', option.label),
            description
        }
        rawOptionSearchTextByView.set(
            localizedOption,
            [option.name, option.label, option.description].filter((value) => typeof value === 'string' && value).join(' ')
        )
        return localizedOption
    })

export const resolveInstanceDisplayLabel = (savedNodeData, componentMetadata) => {
    const savedLabel = savedNodeData?.label
    const rawLabel = componentMetadata?.label
    const displayLabel = getMetadataDisplayText(componentMetadata, 'label', rawLabel)
    if (!savedLabel || !rawLabel || !displayLabel || displayLabel === rawLabel) return savedLabel
    if (savedLabel === rawLabel) return displayLabel

    const defaultAgentflowLabel = new RegExp(`^${escapeRegExp(rawLabel)}(\\s+\\d+)$`)
    const match = savedLabel.match(defaultAgentflowLabel)
    if (match) return `${displayLabel}${match[1]}`

    const duplicatedDefaultLabel = new RegExp(`^${escapeRegExp(rawLabel)}(\\s+\\d+)?(\\s+\\(\\d+\\))$`)
    const duplicatedMatch = savedLabel.match(duplicatedDefaultLabel)
    return duplicatedMatch ? `${displayLabel}${duplicatedMatch[1] ?? ''}${duplicatedMatch[2]}` : savedLabel
}

export const getNodeMetadataSearchTexts = (node) =>
    [
        node?.name,
        node?.label,
        node?.displayLabel,
        node?.category,
        node?.displayCategory,
        node?.description,
        node?.displayDescription
    ].filter((value) => typeof value === 'string' && value)

export const getMetadataOptionSearchText = (option) => {
    if (typeof option === 'string') return option
    return [
        option?.name,
        option?.label,
        option?.displayLabel,
        option?.description,
        option?.displayDescription,
        option && typeof option === 'object' ? rawOptionSearchTextByView.get(option) : undefined
    ]
        .filter((value) => typeof value === 'string' && value)
        .join(' ')
}

const clonePreservingRuntimeData = (value) => {
    if (Array.isArray(value)) return value.map(clonePreservingRuntimeData)
    if (!value || typeof value !== 'object') return value

    const cloned = {}
    for (const [key, nestedValue] of Object.entries(value)) {
        cloned[key] = clonePreservingRuntimeData(nestedValue)
    }
    return cloned
}

const stripMetadataObject = (value) => {
    if (Array.isArray(value)) return value.map(stripMetadataObject)
    if (!value || typeof value !== 'object') return value

    const sanitized = {}
    for (const [key, nestedValue] of Object.entries(value)) {
        if (DISPLAY_METADATA_FIELDS.has(key)) continue
        const isMetadataContainer = METADATA_CONTAINERS.includes(key) && (key !== 'outputs' || Array.isArray(nestedValue))
        sanitized[key] = isMetadataContainer ? stripMetadataObject(nestedValue) : clonePreservingRuntimeData(nestedValue)
    }
    return sanitized
}

/** Strip localization fields from a component metadata schema without touching defaults or runtime payloads. */
export const stripDisplayMetadata = (value) => stripMetadataObject(value)

const findCurrentContainerItem = (currentMetadata, container, rawItem, index) => {
    const currentValues = currentMetadata?.[container]
    if (!Array.isArray(currentValues)) return undefined
    return currentValues.find((candidate) => candidateMatches(candidate, rawItem)) ?? currentValues[index]
}

const buildMetadataDisplayView = (rawMetadata, currentMetadata = rawMetadata) => {
    if (Array.isArray(rawMetadata)) {
        return rawMetadata.map((item, index) => buildMetadataDisplayView(item, currentMetadata?.[index] ?? item))
    }
    if (!rawMetadata || typeof rawMetadata !== 'object') return rawMetadata

    const view = {}
    for (const [key, nestedValue] of Object.entries(rawMetadata)) {
        if (!METADATA_CONTAINERS.includes(key) || (key === 'outputs' && !Array.isArray(nestedValue))) {
            view[key] = clonePreservingRuntimeData(nestedValue)
            continue
        }

        if (Array.isArray(nestedValue)) {
            view[key] = nestedValue.map((item, index) =>
                buildMetadataDisplayView(item, findCurrentContainerItem(currentMetadata, key, item, index) ?? item)
            )
        } else {
            view[key] = buildMetadataDisplayView(nestedValue, currentMetadata?.[key] ?? nestedValue)
        }
    }

    for (const rawField of Object.keys(DISPLAY_FIELD_BY_RAW)) {
        if (rawMetadata[rawField] !== undefined || currentMetadata?.[DISPLAY_FIELD_BY_RAW[rawField]] !== undefined) {
            view[rawField] = getMetadataDisplayText(currentMetadata, rawField, rawMetadata[rawField])
        }
    }
    return view
}

/** Build an ephemeral localized view while preserving machine names, values, defaults and visibility contracts. */
export const createMetadataDisplayView = (rawMetadata, currentMetadata = rawMetadata) =>
    buildMetadataDisplayView(stripDisplayMetadata(rawMetadata), currentMetadata)

const sanitizePersistedNodeData = (nodeData) => {
    if (!nodeData || typeof nodeData !== 'object') return nodeData

    const sanitized = {}
    for (const [key, nestedValue] of Object.entries(nodeData)) {
        if (DISPLAY_METADATA_FIELDS.has(key)) continue
        const isPersistedMetadata = PERSISTED_NODE_METADATA_CONTAINERS.includes(key) || (key === 'outputs' && Array.isArray(nestedValue))
        sanitized[key] = isPersistedMetadata ? stripMetadataObject(nestedValue) : clonePreservingRuntimeData(nestedValue)
    }
    return sanitized
}

/** Remove render-only metadata from known FlowData schema positions while preserving user payload keys byte-for-byte. */
export const sanitizeFlowDisplayMetadata = (flowData) => {
    const sanitized = clonePreservingRuntimeData(flowData)
    if (!sanitized || typeof sanitized !== 'object' || !Array.isArray(sanitized.nodes)) return sanitized

    sanitized.nodes = sanitized.nodes.map((node) => ({
        ...node,
        data: sanitizePersistedNodeData(node?.data)
    }))
    return sanitized
}

export const parseFlowDataForCanvas = (serializedFlowData) => sanitizeFlowDisplayMetadata(JSON.parse(serializedFlowData))
