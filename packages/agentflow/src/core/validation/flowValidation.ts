import type { FlowEdge, FlowNode, NodeDataSchema, ValidationError, ValidationResult } from '../types'
import { evaluateParamVisibility } from '../utils/fieldVisibility'
import { getMetadataDisplayText } from '../utils/metadataDisplay'

/** Check if a value is empty (null, undefined, empty string, or empty rich text) */
function isEmptyValue(value: unknown): boolean {
    return value == null || value === '' || value === '<p></p>'
}

/**
 * Validate the flow structure
 */
export function validateFlow(nodes: FlowNode[], edges: FlowEdge[], availableNodes?: NodeDataSchema[]): ValidationResult {
    const errors: ValidationError[] = []

    // Check for empty flow
    if (nodes.length === 0) {
        errors.push({
            message: '流程为空，请至少添加一个节点',
            type: 'error'
        })
        return { valid: false, errors }
    }

    // Check for start node
    const startNode = nodes.find((n) => n.data.name === 'startAgentflow')
    if (!startNode) {
        errors.push({
            message: '流程必须包含一个开始节点',
            type: 'error'
        })
    }

    // Check for multiple start nodes
    const startNodes = nodes.filter((n) => n.data.name === 'startAgentflow')
    if (startNodes.length > 1) {
        errors.push({
            message: '流程只能包含一个开始节点',
            type: 'error'
        })
    }

    // Check for disconnected nodes (matching server-side pattern)
    const connectedNodes = new Set<string>()
    edges.forEach((edge) => {
        connectedNodes.add(edge.source)
        connectedNodes.add(edge.target)
    })

    const nonStickyNodes = nodes.filter((n) => n.data.name !== 'stickyNoteAgentflow')
    nonStickyNodes.forEach((node) => {
        if (!connectedNodes.has(node.id)) {
            errors.push({
                nodeId: node.id,
                message: '此节点尚未连接到任何节点',
                type: 'warning'
            })
        }
    })

    // Check for cycles (should be handled during connection, but double-check)
    const hasCycle = detectCycle(nodes, edges)
    if (hasCycle) {
        errors.push({
            message: '流程中存在循环，可能导致无限执行',
            type: 'error'
        })
    }

    // Validate each node's inputs
    nonStickyNodes.forEach((node) => {
        const nodeErrors = validateNode(node, availableNodes)
        errors.push(...nodeErrors)
    })

    // Check for hanging edges
    const hangingEdgeErrors = detectHangingEdges(nodes, edges)
    errors.push(...hangingEdgeErrors)

    return {
        valid: errors.filter((e) => e.type === 'error').length === 0,
        errors
    }
}

/**
 * Detect if there's a cycle in the graph
 */
function detectCycle(nodes: FlowNode[], edges: FlowEdge[]): boolean {
    // Build adjacency list
    const graph: Record<string, string[]> = {}
    nodes.forEach((node) => {
        graph[node.id] = []
    })
    edges.forEach((edge) => {
        if (graph[edge.source]) {
            graph[edge.source].push(edge.target)
        }
    })

    // DFS with colors: 0 = white (unvisited), 1 = gray (in progress), 2 = black (done)
    const colors: Record<string, number> = {}
    nodes.forEach((node) => {
        colors[node.id] = 0
    })

    function dfs(nodeId: string): boolean {
        colors[nodeId] = 1 // Mark as in progress

        for (const neighbor of graph[nodeId] || []) {
            if (colors[neighbor] === 1) {
                // Back edge found - cycle detected
                return true
            }
            if (colors[neighbor] === 0 && dfs(neighbor)) {
                return true
            }
        }

        colors[nodeId] = 2 // Mark as done
        return false
    }

    // Run DFS from all unvisited nodes
    for (const node of nodes) {
        if (colors[node.id] === 0 && dfs(node.id)) {
            return true
        }
    }

    return false
}

/**
 * Detect hanging edges where source or target node no longer exists
 */
function detectHangingEdges(nodes: FlowNode[], edges: FlowEdge[]): ValidationError[] {
    const errors: ValidationError[] = []

    for (const edge of edges) {
        const sourceExists = nodes.some((node) => node.id === edge.source)
        const targetExists = nodes.some((node) => node.id === edge.target)

        if (!sourceExists || !targetExists) {
            if (!sourceExists && targetExists) {
                errors.push({
                    nodeId: edge.target,
                    message: `连接到了不存在的源节点 ${edge.source}`,
                    type: 'warning'
                })
            } else if (sourceExists && !targetExists) {
                errors.push({
                    nodeId: edge.source,
                    message: `连接到了不存在的目标节点 ${edge.target}`,
                    type: 'warning'
                })
            } else {
                errors.push({
                    edgeId: edge.id,
                    message: '连接已断开：源节点和目标节点均不存在',
                    type: 'warning'
                })
            }
        }
    }

    return errors
}

/**
 * Check if a specific node is valid.
 *
 * @param availableNodes Component definitions (not flow node instances) used to look up
 *   nested config schemas via `availableNodes.find(n => n.name === componentName)`.
 */
export function validateNode(node: FlowNode, availableNodes?: NodeDataSchema[]): ValidationError[] {
    const errors: ValidationError[] = []

    // Check required fields
    if (!node.data.name) {
        errors.push({
            nodeId: node.id,
            message: '节点缺少名称',
            type: 'error'
        })
    }

    const schemaFromAvailable = availableNodes?.find((n) => n.name === node.data.name)
    const inputParams = schemaFromAvailable?.inputs || node.data.inputParams || []
    const inputValues = node.data.inputs || {}

    for (const param of inputParams) {
        const paramLabel = getMetadataDisplayText(param, 'label', param.name)
        // Credential validation (skip general check to avoid duplicate errors)
        if (param.name === 'credential') {
            if (!param.optional && !inputValues[param.name]) {
                errors.push({
                    nodeId: node.id,
                    message: `${paramLabel}为必填项`,
                    type: 'warning'
                })
            }
            continue
        }

        // Check required inputs, skipping hidden params.
        // asyncOptions and asyncMultiOptions values are stored in inputValues just like options;
        // evaluateParamVisibility correctly uses those values to resolve show/hide conditions on
        // dependent fields, so async-driven visibility is handled automatically here.
        if (!param.optional && evaluateParamVisibility(param, inputValues) && isEmptyValue(inputValues[param.name] ?? param.default)) {
            errors.push({
                nodeId: node.id,
                message: `${paramLabel}为必填项`,
                type: 'warning'
            })
        }

        // Array item sub-field validation
        if (param.type === 'array' && Array.isArray(inputValues[param.name]) && param.array) {
            const arrayItems = inputValues[param.name] as Record<string, unknown>[]

            if (arrayItems.length > 0) {
                arrayItems.forEach((item, index) => {
                    for (const arrayParam of param.array!) {
                        // Evaluate visibility with array index for $index-based conditions
                        const shouldValidate = evaluateParamVisibility(arrayParam, item as Record<string, unknown>, index)

                        if (shouldValidate && !arrayParam.optional) {
                            const value = item[arrayParam.name]
                            if (isEmptyValue(value)) {
                                const arrayParamLabel = getMetadataDisplayText(arrayParam, 'label', arrayParam.name)
                                errors.push({
                                    nodeId: node.id,
                                    message: `${paramLabel}第 ${index + 1} 项：${arrayParamLabel}为必填项`,
                                    type: 'warning'
                                })
                            }
                        }
                    }
                })
            }
        }

        // Nested component config validation
        const configKey = `${param.name}Config`
        if (inputValues[configKey] && inputValues[param.name] && availableNodes) {
            const componentName = inputValues[param.name] as string
            const configValue = inputValues[configKey] as Record<string, unknown>

            const componentDef = availableNodes.find((n) => n.name === componentName)
            if (componentDef?.inputs) {
                for (const componentParam of componentDef.inputs) {
                    // NodeDataSchema.inputs is InputParam[]
                    if (!evaluateParamVisibility(componentParam, configValue)) continue

                    if (!componentParam.optional) {
                        const nestedValue = configValue[componentParam.name]
                        if (isEmptyValue(nestedValue)) {
                            const componentParamLabel = getMetadataDisplayText(componentParam, 'label', componentParam.name)
                            errors.push({
                                nodeId: node.id,
                                message: `${paramLabel}配置：${componentParamLabel}为必填项`,
                                type: 'warning'
                            })
                        }
                    }
                }
            }
        }
    }

    return errors
}

/**
 * Group validation errors by nodeId into a map of nodeId -> error messages.
 * Useful for pushing validationErrors to node data for border highlighting.
 */
export function groupValidationErrorsByNodeId(errors: ValidationError[]): Map<string, string[]> {
    const errorsByNodeId = new Map<string, string[]>()
    for (const error of errors) {
        if (error.nodeId) {
            if (!errorsByNodeId.has(error.nodeId)) {
                errorsByNodeId.set(error.nodeId, [])
            }
            errorsByNodeId.get(error.nodeId)!.push(error.message)
        }
    }
    return errorsByNodeId
}

/**
 * Apply validation errors to node data for border highlighting.
 * Returns the updated nodes array (new references only for nodes whose errors changed).
 */
export function applyValidationErrorsToNodes(nodes: FlowNode[], errors: ValidationError[]): FlowNode[] {
    const errorsByNodeId = groupValidationErrorsByNodeId(errors)
    return nodes.map((node) => {
        const nodeErrors = errorsByNodeId.get(node.id)
        const hadErrors = (node.data.validationErrors?.length ?? 0) > 0
        if (nodeErrors || hadErrors) {
            return { ...node, data: { ...node.data, validationErrors: nodeErrors } }
        }
        return node
    })
}
