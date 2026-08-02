import type { FlowData, FlowDataCallback, NodeData, NodeDataSchema } from '../types'

const DISPLAY_FIELD_BY_RAW = {
    label: 'displayLabel',
    category: 'displayCategory',
    description: 'displayDescription',
    warning: 'displayWarning',
    placeholder: 'displayPlaceholder',
    badge: 'displayBadge',
    deprecateMessage: 'displayDeprecateMessage',
    headerName: 'displayHeaderName',
    hint: 'displayHint'
} as const

const PERSISTED_NODE_METADATA_CONTAINERS = new Set(['inputParams', 'inputAnchors', 'outputAnchors'])
const METADATA_CONTAINERS = new Set([
    'inputs',
    'output',
    'outputs',
    'options',
    'valueOptions',
    'tabs',
    'array',
    'datagrid',
    'credential',
    'hint',
    ...PERSISTED_NODE_METADATA_CONTAINERS
])
const DISPLAY_METADATA_FIELDS = new Set<string>([...Object.values(DISPLAY_FIELD_BY_RAW), 'displayLocale', 'displayValueOptions'])

type DisplaySource = object | null | undefined
type DisplayField = keyof typeof DISPLAY_FIELD_BY_RAW
type RawDisplayMetadata = Partial<Record<DisplayField, string>>

export interface MetadataDisplayValueOption {
    value: string
    label: string
}

type DisplayValueOptions<T> = T extends readonly string[] ? MetadataDisplayView<T> | MetadataDisplayValueOption[] : MetadataDisplayView<T>

export type MetadataDisplayView<T> = T extends readonly unknown[]
    ? { [K in keyof T]: MetadataDisplayView<T[K]> }
    : T extends object
    ? { [K in keyof T]: K extends 'valueOptions' ? DisplayValueOptions<T[K]> : MetadataDisplayView<T[K]> }
    : T

// Render-only display views need both localized text and the original English text for
// bilingual search. A WeakMap keeps that original text outside enumeration and JSON.
const RAW_DISPLAY_METADATA = new WeakMap<object, RawDisplayMetadata>()

function setOwnEnumerable(target: Record<string, unknown>, key: string, value: unknown): void {
    Object.defineProperty(target, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true
    })
}

function projectPrimitiveValueOptions(rawOptions: string[], displayOptions: unknown[]): MetadataDisplayValueOption[] {
    return rawOptions.map((rawValue) => {
        const matches = displayOptions.filter(
            (candidate): candidate is Record<string, unknown> =>
                !!candidate && typeof candidate === 'object' && (candidate as Record<string, unknown>).value === rawValue
        )
        const candidateLabel = matches.length === 1 ? matches[0].label : undefined
        return { value: rawValue, label: typeof candidateLabel === 'string' && candidateLabel ? candidateLabel : rawValue }
    })
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Return the localized display field without changing its raw machine field. */
export function getMetadataDisplayText(source: DisplaySource, field: DisplayField, fallback = ''): string {
    if (!source) return fallback
    const record = source as Record<string, unknown>
    const displayValue = record[DISPLAY_FIELD_BY_RAW[field]]
    if (typeof displayValue === 'string' && displayValue) return displayValue
    const rawValue = record[field]
    return typeof rawValue === 'string' && rawValue ? rawValue : fallback
}

/** Build a bilingual search string while preserving the machine option name. */
export function getMetadataOptionSearchText(option: unknown): string {
    if (typeof option === 'string') return option
    if (!option || typeof option !== 'object') return ''
    const record = option as Record<string, unknown>
    const rawMetadata = RAW_DISPLAY_METADATA.get(option)
    return [
        record.name,
        rawMetadata?.label,
        record.label,
        record.displayLabel,
        rawMetadata?.description,
        record.description,
        record.displayDescription
    ]
        .filter((value): value is string => typeof value === 'string' && !!value)
        .filter((value, index, values) => values.indexOf(value) === index)
        .join(' ')
}

/** Resolve the current component definition for a saved canvas node. */
export function resolveCurrentComponent(componentNodes: NodeDataSchema[], nodeData: Pick<NodeData, 'name'>): NodeDataSchema | undefined {
    return componentNodes.find((component) => component.name === nodeData.name)
}

/**
 * Localize only system-generated instance labels. User-authored labels remain byte-for-byte unchanged.
 * Agentflow default labels use either the raw label itself or a numeric suffix.
 */
export function resolveInstanceDisplayLabel(savedNodeData: Pick<NodeData, 'label'>, component?: NodeDataSchema): string {
    const savedLabel = savedNodeData.label
    const rawLabel = component?.label
    const displayLabel = getMetadataDisplayText(component, 'label', rawLabel)
    if (!savedLabel || !rawLabel || !displayLabel || displayLabel === rawLabel) return savedLabel
    if (savedLabel === rawLabel) return displayLabel

    const defaultLabel = new RegExp(`^${escapeRegExp(rawLabel)}(\\s+\\d+)$`)
    const match = savedLabel.match(defaultLabel)
    if (match) return `${displayLabel}${match[1]}`

    const duplicatedDefaultLabel = new RegExp(`^${escapeRegExp(rawLabel)}(\\s+\\d+)?(\\s+\\(\\d+\\))$`)
    const duplicatedMatch = savedLabel.match(duplicatedDefaultLabel)
    return duplicatedMatch ? `${displayLabel}${duplicatedMatch[1] ?? ''}${duplicatedMatch[2]}` : savedLabel
}

/** Build an ephemeral render-only view whose human fields use their display counterparts. */
export function createMetadataDisplayView<T>(value: T): MetadataDisplayView<T> {
    if (Array.isArray(value)) return value.map((item) => createMetadataDisplayView(item)) as MetadataDisplayView<T>
    if (!value || typeof value !== 'object') return value as MetadataDisplayView<T>

    const inheritedRawMetadata = RAW_DISPLAY_METADATA.get(value)
    const sourceRecord = value as Record<string, unknown>
    const view: Record<string, unknown> = {}
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        if (
            key === 'valueOptions' &&
            Array.isArray(nestedValue) &&
            nestedValue.every((option): option is string => typeof option === 'string') &&
            Array.isArray(sourceRecord.displayValueOptions)
        ) {
            setOwnEnumerable(view, key, projectPrimitiveValueOptions(nestedValue, sourceRecord.displayValueOptions))
            continue
        }
        const isMetadataContainer = METADATA_CONTAINERS.has(key) && (key !== 'outputs' || Array.isArray(nestedValue))
        setOwnEnumerable(view, key, isMetadataContainer ? createMetadataDisplayView(nestedValue) : clonePreservingRuntimeData(nestedValue))
    }
    const rawMetadata: RawDisplayMetadata = {}
    for (const [rawField, displayField] of Object.entries(DISPLAY_FIELD_BY_RAW) as [DisplayField, string][]) {
        const displayValue = view[displayField]
        if (typeof displayValue === 'string' && displayValue) {
            const rawValue = inheritedRawMetadata?.[rawField] ?? view[rawField]
            if (typeof rawValue === 'string' && rawValue) setOwnEnumerable(rawMetadata, rawField, rawValue)
            setOwnEnumerable(view, rawField, displayValue)
        }
    }
    if (Object.keys(rawMetadata).length > 0) RAW_DISPLAY_METADATA.set(view, rawMetadata)
    return view as MetadataDisplayView<T>
}

function clonePreservingRuntimeData<T>(value: T): T {
    if (Array.isArray(value)) return value.map((item) => clonePreservingRuntimeData(item)) as T
    if (!value || typeof value !== 'object') return value

    const cloned: Record<string, unknown> = {}
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        setOwnEnumerable(cloned, key, clonePreservingRuntimeData(nestedValue))
    }
    return cloned as T
}

function stripMetadataObject<T>(value: T): T {
    if (Array.isArray(value)) return value.map((item) => stripMetadataObject(item)) as T
    if (!value || typeof value !== 'object') return value

    const sanitized: Record<string, unknown> = {}
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
        if (DISPLAY_METADATA_FIELDS.has(key)) continue
        const isMetadataContainer = METADATA_CONTAINERS.has(key) && (key !== 'outputs' || Array.isArray(nestedValue))
        setOwnEnumerable(sanitized, key, isMetadataContainer ? stripMetadataObject(nestedValue) : clonePreservingRuntimeData(nestedValue))
    }
    return sanitized as T
}

/** Remove localization fields from a component metadata schema without touching defaults or runtime payloads. */
export function stripDisplayMetadata<T>(value: T): T {
    return stripMetadataObject(value)
}

function sanitizePersistedNodeData<T>(nodeData: T): T {
    if (!nodeData || typeof nodeData !== 'object') return nodeData

    const sanitized: Record<string, unknown> = {}
    for (const [key, nestedValue] of Object.entries(nodeData as Record<string, unknown>)) {
        if (DISPLAY_METADATA_FIELDS.has(key)) continue
        const isPersistedMetadata = PERSISTED_NODE_METADATA_CONTAINERS.has(key) || (key === 'outputs' && Array.isArray(nestedValue))
        setOwnEnumerable(sanitized, key, isPersistedMetadata ? stripMetadataObject(nestedValue) : clonePreservingRuntimeData(nestedValue))
    }
    return sanitized as T
}

/** Remove render-only fields only from known FlowData metadata positions, preserving user payloads with identical key names. */
export function sanitizeFlowDisplayMetadata<T>(flowData: T): T {
    const sanitized = clonePreservingRuntimeData(flowData) as Record<string, unknown>
    if (!sanitized || typeof sanitized !== 'object' || !Array.isArray(sanitized.nodes)) return sanitized as T

    sanitized.nodes = sanitized.nodes.map((node) => {
        if (!node || typeof node !== 'object') return node
        const nodeRecord = node as Record<string, unknown>
        return { ...nodeRecord, data: sanitizePersistedNodeData(nodeRecord.data) }
    })
    return sanitized as T
}

/** Emit a persistence-facing flow snapshot after removing render-only metadata from known schema positions. */
export function emitSanitizedFlowChange(callback: FlowDataCallback | undefined, flowData: FlowData): void {
    callback?.(sanitizeFlowDisplayMetadata(flowData))
}
