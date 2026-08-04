// Node factory - Node ID generation, labeling, and initialization
export { getUniqueNodeId, getUniqueNodeLabel, initNode, resolveNodeType } from './nodeFactory'

// Flow export utilities
export { generateExportFlowData } from './flowExport'

// Field visibility engine
export { applyVisibleFieldDefaults, evaluateFieldVisibility, evaluateParamVisibility, stripHiddenFieldValues } from './fieldVisibility'

// Dynamic output anchor utilities
export { buildDynamicOutputAnchors, parseOutputHandleIndex } from './dynamicOutputAnchors'

// Variable utilities
export { getDefinedStateKeys, getUpstreamNodes } from './variableUtils'

// Node version detection and upgrade utilities
export { getNodeVersionWarning, isNodeOutdated, upgradeNodeData } from './nodeVersionUtils'

// Additive localized display metadata. Raw machine fields remain authoritative.
export type { MetadataDisplayValueOption, MetadataDisplayView } from './metadataDisplay'
export {
    createMetadataDisplayView,
    emitSanitizedFlowChange,
    getMetadataDisplayText,
    getMetadataOptionSearchText,
    resolveCurrentComponent,
    resolveInstanceDisplayLabel,
    sanitizeFlowDisplayMetadata,
    stripDisplayMetadata
} from './metadataDisplay'
