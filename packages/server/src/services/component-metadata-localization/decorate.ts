import { cloneDeep } from 'lodash'
import { ZH_CN_BADGES, ZH_CN_CATEGORIES, ZH_CN_DYNAMIC_POLICIES, ZH_CN_METADATA_TRANSLATIONS } from './catalog'
import type { DynamicMetadataPolicy } from './catalog'
import { escapeMetadataPathSegment, metadataTranslationKey } from './key'

type MetadataObject = Record<string, any>
type MetadataKind = 'node' | 'credential'

const HUMAN_TEXT_FIELDS: Readonly<Record<string, string>> = Object.freeze({
    label: 'displayLabel',
    description: 'displayDescription',
    warning: 'displayWarning',
    placeholder: 'displayPlaceholder',
    deprecateMessage: 'displayDeprecateMessage',
    headerName: 'displayHeaderName',
    hint: 'displayHint'
})

const IDENTITY_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    inputs: ['name'],
    output: ['name'],
    outputs: ['name'],
    options: ['name'],
    tabs: ['name'],
    array: ['name'],
    datagrid: ['field', 'name', 'headerName']
})

const LOCALIZABLE_CONTAINERS = new Set(['inputs', 'output', 'outputs', 'options', 'tabs', 'array', 'datagrid', 'credential', 'hint'])

const itemIdentity = (container: string, item: MetadataObject, index: number): string => {
    for (const field of IDENTITY_FIELDS[container] ?? []) {
        const value = item?.[field]
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            return escapeMetadataPathSegment(value)
        }
    }
    return `__missing_identity_${index}`
}

const translateField = (kind: MetadataKind, id: string, metadataPath: string, field: string, source: unknown): string | undefined => {
    if (typeof source !== 'string' || !source.trim()) return undefined
    return ZH_CN_METADATA_TRANSLATIONS.get(metadataTranslationKey(kind, id, metadataPath, field, source))
}

const decorateValue = (kind: MetadataKind, id: string, value: unknown, metadataPath: string, container = ''): unknown => {
    if (Array.isArray(value)) {
        return value.map((item, index) =>
            decorateValue(kind, id, item, `${metadataPath}/${itemIdentity(container, item as MetadataObject, index)}`, container)
        )
    }
    if (!value || typeof value !== 'object') return value

    const source = value as MetadataObject
    const decorated: MetadataObject = { ...source }

    for (const [field, displayField] of Object.entries(HUMAN_TEXT_FIELDS)) {
        const translation = translateField(kind, id, metadataPath, field, source[field])
        if (translation) decorated[displayField] = translation
    }

    for (const [field, nestedValue] of Object.entries(source)) {
        if (!LOCALIZABLE_CONTAINERS.has(field) || !nestedValue || typeof nestedValue !== 'object') continue
        if (field === 'outputs' && !Array.isArray(nestedValue)) continue
        decorated[field] = decorateValue(kind, id, nestedValue, `${metadataPath}/${escapeMetadataPathSegment(field)}`, field)
    }

    return decorated
}

export const decorateNodeMetadata = <T extends MetadataObject>(node: T): T => {
    const source = cloneDeep(node)
    const decorated = decorateValue('node', source.name, source, 'root') as MetadataObject
    decorated['displayLocale'] = 'zh-CN'
    if (typeof source.category === 'string') {
        const [category, status] = source.category.split(';')
        const displayCategory = ZH_CN_CATEGORIES[category] ?? category
        decorated['displayCategory'] = status ? `${displayCategory};${status}` : displayCategory
    }
    if (typeof source.badge === 'string' && source.badge) decorated['displayBadge'] = ZH_CN_BADGES[source.badge] ?? source.badge
    return decorated as T
}

export const decorateCredentialMetadata = <T extends MetadataObject>(credential: T): T => {
    const source = cloneDeep(credential)
    const decorated = decorateValue('credential', source.name, source, 'root') as MetadataObject
    decorated['displayLocale'] = 'zh-CN'
    return decorated as T
}

/** Clone and decorate the credential registry for display-only API responses without mutating NodesPool. */
export const decorateComponentCredentials = <T extends Record<string, MetadataObject>>(credentials: T): T =>
    Object.fromEntries(
        Object.entries(credentials).map(([credentialName, credential]) => [credentialName, decorateCredentialMetadata(credential)])
    ) as T

export const getDynamicMetadataPolicy = (nodeName: string, methodName: string): DynamicMetadataPolicy | undefined =>
    ZH_CN_DYNAMIC_POLICIES[`${nodeName}.${methodName}`]

export const decorateDynamicOptions = <T extends MetadataObject>(nodeName: string, methodName: string, options: T[]): T[] => {
    const policy = getDynamicMetadataPolicy(nodeName, methodName)
    const clonedOptions = cloneDeep(options) as MetadataObject[]
    if (!policy || policy === 'provider-passthrough' || policy === 'tenant-passthrough') return clonedOptions as T[]

    return clonedOptions.map((option, index) => {
        if (policy === 'metadata-ref' && typeof option.name === 'string' && typeof option.label === 'string') {
            const referencedLabel = ZH_CN_METADATA_TRANSLATIONS.get(
                metadataTranslationKey('node', option.name, 'root', 'label', option.label)
            )
            if (referencedLabel) option['displayLabel'] = referencedLabel
            return option
        }

        const optionIdentity = escapeMetadataPathSegment(option.name ?? `__missing_identity_${index}`)
        const metadataPath = `root/${escapeMetadataPathSegment(methodName)}/options/${optionIdentity}`
        for (const [field, displayField] of Object.entries(HUMAN_TEXT_FIELDS)) {
            const value = option[field]
            if (typeof value !== 'string' || !value.trim()) continue
            const translation = ZH_CN_METADATA_TRANSLATIONS.get(metadataTranslationKey('dynamic', nodeName, metadataPath, field, value))
            if (translation) option[displayField] = translation
        }
        return option
    }) as T[]
}
