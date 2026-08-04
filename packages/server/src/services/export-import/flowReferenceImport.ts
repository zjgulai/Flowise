import { StatusCodes } from 'http-status-codes'
import { normalizeFlowiseBaseUrl } from 'flowise-components'
import { validate as isUuid } from 'uuid'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'

type JsonRecord = Record<string, unknown>

export interface TypedFlowReference {
    targetId: string
    expectedType?: 'AGENTFLOW'
}

const FLOW_REFERENCE_INPUTS: Readonly<Record<string, { inputName: string; baseUrlInputName: string; expectedType?: 'AGENTFLOW' }>> = {
    agentAsTool: { inputName: 'selectedAgentflow', baseUrlInputName: 'baseURL', expectedType: 'AGENTFLOW' },
    ChatflowTool: { inputName: 'selectedChatflow', baseUrlInputName: 'baseURL' },
    executeFlowAgentflow: { inputName: 'executeFlowSelectedFlow', baseUrlInputName: 'executeFlowBaseURL' },
    seqExecuteFlow: { inputName: 'selectedFlow', baseUrlInputName: 'baseURL' }
}

const DYNAMIC_COMPONENT_CONFIGS: Readonly<Record<string, readonly { selectionKey: string; configKey: string }[]>> = {
    agentAgentflow: [{ selectionKey: 'agentModel', configKey: 'agentModelConfig' }],
    llmAgentflow: [{ selectionKey: 'llmModel', configKey: 'llmModelConfig' }],
    conditionAgentAgentflow: [{ selectionKey: 'conditionAgentModel', configKey: 'conditionAgentModelConfig' }],
    humanInputAgentflow: [{ selectionKey: 'humanInputModel', configKey: 'humanInputModelConfig' }]
}

const invalidWorkspaceImport = (): never => {
    throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid workspace import')
}

const isPlainRecord = (value: unknown): value is JsonRecord => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
}

const parseFlowData = (flowData: unknown): JsonRecord | undefined => {
    const serialized = typeof flowData === 'string' ? flowData : invalidWorkspaceImport()
    let parsed: unknown
    try {
        parsed = JSON.parse(serialized)
    } catch {
        return invalidWorkspaceImport()
    }
    const record = isPlainRecord(parsed) ? parsed : invalidWorkspaceImport()
    if (record.nodes === undefined) return record
    if (!Array.isArray(record.nodes)) invalidWorkspaceImport()
    return record
}

const readReference = (value: unknown): string | undefined => {
    if (value === undefined || value === null || value === '') return undefined
    if (typeof value !== 'string' || value !== value.trim() || value.length > 256 || value.includes('\0') || !isUuid(value)) {
        invalidWorkspaceImport()
    }
    return value as string
}

const normalizeConfiguredFlowBaseUrl = (value: string): string => {
    try {
        return normalizeFlowiseBaseUrl(value)
    } catch {
        return invalidWorkspaceImport()
    }
}

const isSameOriginTarget = (value: string, canonicalOrigin: string | undefined): boolean => {
    if (!canonicalOrigin) return false
    return normalizeConfiguredFlowBaseUrl(value) === normalizeConfiguredFlowBaseUrl(canonicalOrigin)
}

const isExplicitExternalTarget = (inputs: JsonRecord, baseUrlInputName: string, canonicalOrigin?: string): boolean => {
    const value = inputs[baseUrlInputName]
    if (value === undefined || value === null || value === '') return false
    const baseUrl = typeof value === 'string' ? value : invalidWorkspaceImport()
    const trimmed = baseUrl.trim()
    if (!trimmed) return false
    normalizeConfiguredFlowBaseUrl(trimmed)
    return !isSameOriginTarget(trimmed, canonicalOrigin)
}

export interface FlowComponentDescriptorForImport {
    name: string
    inputs: JsonRecord
}

export type FlowComponentInputTransform = (descriptor: FlowComponentDescriptorForImport) => JsonRecord | undefined

const visitFlowComponents = (parsed: JsonRecord, transform: FlowComponentInputTransform): boolean => {
    if (parsed.nodes === undefined) return false
    const nodes: unknown[] = Array.isArray(parsed.nodes) ? parsed.nodes : invalidWorkspaceImport()
    let changed = false

    const applyTransform = (name: unknown, inputs: unknown, setInputs: (value: JsonRecord) => void): FlowComponentDescriptorForImport => {
        const componentName = typeof name === 'string' && name ? name : invalidWorkspaceImport()
        const componentInputs = isPlainRecord(inputs) ? inputs : invalidWorkspaceImport()
        const descriptor: FlowComponentDescriptorForImport = { name: componentName, inputs: componentInputs }
        const replacement = transform(descriptor)
        if (replacement !== undefined) {
            if (!isPlainRecord(replacement)) invalidWorkspaceImport()
            setInputs(replacement)
            descriptor.inputs = replacement
            changed = true
        }
        return descriptor
    }

    const applySelectedChildConfig = (container: JsonRecord, selectionKey: string, configKey: string): void => {
        const selection = container[selectionKey]
        if (selection === undefined || selection === null || selection === '') {
            if (Object.prototype.hasOwnProperty.call(container, configKey)) {
                Reflect.deleteProperty(container, configKey)
                changed = true
            }
            return
        }
        applyTransform(selection, container[configKey] ?? {}, (inputs) => {
            container[configKey] = inputs
        })
    }

    for (const node of nodes) {
        const nodeRecord = isPlainRecord(node) ? node : invalidWorkspaceImport()
        const data = isPlainRecord(nodeRecord.data) ? nodeRecord.data : invalidWorkspaceImport()
        const descriptor = applyTransform(data.name, data.inputs, (inputs) => {
            data.inputs = inputs
        })

        for (const config of DYNAMIC_COMPONENT_CONFIGS[descriptor.name] ?? []) {
            applySelectedChildConfig(descriptor.inputs, config.selectionKey, config.configKey)
        }

        if (descriptor.name === 'agentAgentflow') {
            const agentTools = descriptor.inputs.agentTools
            if (agentTools !== undefined && agentTools !== null && agentTools !== '') {
                const tools: unknown[] = Array.isArray(agentTools) ? agentTools : invalidWorkspaceImport()
                for (const tool of tools) {
                    const toolRecord = isPlainRecord(tool) ? tool : invalidWorkspaceImport()
                    const toolName = toolRecord.agentSelectedTool
                    if (toolName === undefined || toolName === null || toolName === '') {
                        if (Object.prototype.hasOwnProperty.call(toolRecord, 'agentSelectedToolConfig')) {
                            Reflect.deleteProperty(toolRecord, 'agentSelectedToolConfig')
                            changed = true
                        }
                        continue
                    }
                    applyTransform(toolName, toolRecord.agentSelectedToolConfig, (inputs) => {
                        toolRecord.agentSelectedToolConfig = inputs
                    })
                }
            }

            const knowledgeConfigs = descriptor.inputs.agentKnowledgeVSEmbeddings
            if (knowledgeConfigs !== undefined && knowledgeConfigs !== null && knowledgeConfigs !== '') {
                const knowledgeItems: unknown[] = Array.isArray(knowledgeConfigs) ? knowledgeConfigs : invalidWorkspaceImport()
                for (const knowledge of knowledgeItems) {
                    const knowledgeRecord = isPlainRecord(knowledge) ? knowledge : invalidWorkspaceImport()
                    for (const [selectionKey, configKey] of [
                        ['embeddingModel', 'embeddingModelConfig'],
                        ['vectorStore', 'vectorStoreConfig']
                    ] as const) {
                        applySelectedChildConfig(knowledgeRecord, selectionKey, configKey)
                    }
                }
            }
        }

        if (descriptor.name === 'toolAgentflow') {
            const usesPrimaryName = !!descriptor.inputs.selectedTool
            const selectedTool = descriptor.inputs.selectedTool || descriptor.inputs.toolAgentflowSelectedTool
            if (selectedTool === undefined || selectedTool === null || selectedTool === '') {
                for (const key of ['selectedToolConfig', 'toolAgentflowSelectedToolConfig']) {
                    if (!Object.prototype.hasOwnProperty.call(descriptor.inputs, key)) continue
                    Reflect.deleteProperty(descriptor.inputs, key)
                    changed = true
                }
                continue
            }
            const selectedConfig = descriptor.inputs.selectedToolConfig || descriptor.inputs.toolAgentflowSelectedToolConfig || {}
            const targetConfigKey = usesPrimaryName ? 'selectedToolConfig' : 'toolAgentflowSelectedToolConfig'
            applyTransform(selectedTool, selectedConfig, (inputs) => {
                descriptor.inputs[targetConfigKey] = inputs
            })
            const inactiveNameKey = usesPrimaryName ? 'toolAgentflowSelectedTool' : 'selectedTool'
            const inactiveConfigKey = usesPrimaryName ? 'toolAgentflowSelectedToolConfig' : 'selectedToolConfig'
            for (const key of [inactiveNameKey, inactiveConfigKey]) {
                if (!Object.prototype.hasOwnProperty.call(descriptor.inputs, key)) continue
                Reflect.deleteProperty(descriptor.inputs, key)
                changed = true
            }
        }
    }
    return changed
}

export const extractFlowComponentsForImport = (flowData: unknown): FlowComponentDescriptorForImport[] => {
    const parsed = parseFlowData(flowData)
    if (!parsed) return []
    const components: FlowComponentDescriptorForImport[] = []
    visitFlowComponents(parsed, (descriptor) => {
        components.push(descriptor)
        return undefined
    })
    return components
}

export const transformFlowComponentInputsForImport = (flowData: unknown, transform: FlowComponentInputTransform): string => {
    const parsed = parseFlowData(flowData)
    if (!parsed) return flowData as string
    const changed = visitFlowComponents(parsed, transform)
    return changed ? JSON.stringify(parsed) : (flowData as string)
}

const wrapComponentListAsFlowData = (value: unknown): string => {
    if (!Array.isArray(value)) invalidWorkspaceImport()
    const components: unknown[] = Array.isArray(value) ? value : invalidWorkspaceImport()
    return JSON.stringify({ nodes: components.map((data) => ({ data })), edges: [] })
}

const unwrapComponentListFromFlowData = (flowData: string): JsonRecord[] => {
    const parsed = parseFlowData(flowData)
    const nodes = parsed?.nodes
    if (!Array.isArray(nodes)) invalidWorkspaceImport()
    const componentNodes: unknown[] = Array.isArray(nodes) ? nodes : invalidWorkspaceImport()
    return componentNodes.map((node) => {
        const nodeRecord = isPlainRecord(node) ? node : invalidWorkspaceImport()
        return isPlainRecord(nodeRecord.data) ? nodeRecord.data : invalidWorkspaceImport()
    })
}

export const extractFlowComponentsFromListForImport = (value: unknown): FlowComponentDescriptorForImport[] =>
    extractFlowComponentsForImport(wrapComponentListAsFlowData(value))

export const transformComponentListInputsForImport = (value: unknown, transform: FlowComponentInputTransform): JsonRecord[] =>
    unwrapComponentListFromFlowData(transformFlowComponentInputsForImport(wrapComponentListAsFlowData(value), transform))

const extractTypedReferencesFromComponents = (
    components: FlowComponentDescriptorForImport[],
    canonicalOrigin?: string
): TypedFlowReference[] => {
    const references: TypedFlowReference[] = []
    for (const component of components) {
        const spec = FLOW_REFERENCE_INPUTS[component.name]
        if (!spec) continue
        const targetId = readReference(component.inputs[spec.inputName])
        if (isExplicitExternalTarget(component.inputs, spec.baseUrlInputName, canonicalOrigin)) continue
        if (targetId) references.push({ targetId, ...(spec.expectedType ? { expectedType: spec.expectedType } : {}) })
    }
    return references
}

export const extractTypedFlowReferencesForImport = (flowData: unknown, canonicalOrigin?: string): TypedFlowReference[] => {
    return extractTypedReferencesFromComponents(extractFlowComponentsForImport(flowData), canonicalOrigin)
}

export const extractTypedFlowReferencesFromComponentListForImport = (value: unknown, canonicalOrigin?: string): TypedFlowReference[] =>
    extractTypedReferencesFromComponents(extractFlowComponentsFromListForImport(value), canonicalOrigin)

const canonicalizeSameOriginComponentInputs = (
    component: FlowComponentDescriptorForImport,
    canonicalOrigin: string
): JsonRecord | undefined => {
    const spec = FLOW_REFERENCE_INPUTS[component.name]
    if (!spec) return undefined
    const value = component.inputs[spec.baseUrlInputName]
    if (typeof value !== 'string' || !value.trim() || !isSameOriginTarget(value.trim(), canonicalOrigin)) return undefined
    return { ...component.inputs, [spec.baseUrlInputName]: '' }
}

export const canonicalizeSameOriginFlowReferencesForExport = (flowData: unknown, canonicalOrigin: string): string =>
    transformFlowComponentInputsForImport(flowData, (component) => canonicalizeSameOriginComponentInputs(component, canonicalOrigin))

export const canonicalizeSameOriginFlowReferencesInComponentListForExport = (value: unknown, canonicalOrigin: string): JsonRecord[] =>
    transformComponentListInputsForImport(value, (component) => canonicalizeSameOriginComponentInputs(component, canonicalOrigin))

const remapComponentFlowReference = (
    component: FlowComponentDescriptorForImport,
    idMap: ReadonlyMap<string, string>
): JsonRecord | undefined => {
    const spec = FLOW_REFERENCE_INPUTS[component.name]
    if (!spec) return undefined
    const targetId = readReference(component.inputs[spec.inputName])
    if (isExplicitExternalTarget(component.inputs, spec.baseUrlInputName)) return undefined
    if (!targetId) return undefined
    const replacement = idMap.get(targetId)
    return replacement ? { ...component.inputs, [spec.inputName]: replacement } : undefined
}

export const remapFlowReferencesForImport = (flowData: unknown, idMap: ReadonlyMap<string, string>): string => {
    return transformFlowComponentInputsForImport(flowData, (component) => remapComponentFlowReference(component, idMap))
}

export const remapFlowReferencesInComponentListForImport = (value: unknown, idMap: ReadonlyMap<string, string>): JsonRecord[] =>
    transformComponentListInputsForImport(value, (component) => remapComponentFlowReference(component, idMap))
