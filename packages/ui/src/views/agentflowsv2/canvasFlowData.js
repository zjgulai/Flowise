import { sanitizeFlowDisplayMetadata } from '@/utils/componentMetadataDisplay'
import { getErrorMessage } from '@/utils/getErrorMessage'

const isObjectRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0

export const parseAgentflowCanvasData = (serializedFlowData) => {
    const flowData = JSON.parse(serializedFlowData)

    if (!isObjectRecord(flowData)) throw new Error('Invalid flow data')
    if (!Array.isArray(flowData.nodes)) throw new Error('Invalid flow nodes')
    if (!Array.isArray(flowData.edges)) throw new Error('Invalid flow edges')

    const nodeIds = new Set()
    for (const node of flowData.nodes) {
        if (!isObjectRecord(node) || !isNonEmptyString(node.id) || !isObjectRecord(node.data)) {
            throw new Error('Invalid flow node')
        }
        if (nodeIds.has(node.id)) throw new Error('Duplicate flow node')
        nodeIds.add(node.id)
        if (node.data.inputs !== undefined && !isObjectRecord(node.data.inputs)) throw new Error('Invalid flow node inputs')
        if (node.data.inputParams !== undefined && !Array.isArray(node.data.inputParams)) {
            throw new Error('Invalid flow node input parameters')
        }
        if (node.data.inputParams?.some((inputParam) => !isObjectRecord(inputParam))) {
            throw new Error('Invalid flow node input parameter')
        }
    }

    const edgeIds = new Set()
    for (const edge of flowData.edges) {
        if (
            !isObjectRecord(edge) ||
            !isNonEmptyString(edge.source) ||
            !isNonEmptyString(edge.target) ||
            !nodeIds.has(edge.source) ||
            !nodeIds.has(edge.target)
        ) {
            throw new Error('Invalid flow edge')
        }
        if (edge.id !== undefined) {
            if (!isNonEmptyString(edge.id) || edgeIds.has(edge.id)) throw new Error('Invalid flow edge id')
            edgeIds.add(edge.id)
        }
    }

    return sanitizeFlowDisplayMetadata({
        ...flowData,
        nodes: flowData.nodes.map((node) => ({
            ...node,
            data: {
                ...node.data,
                inputs: node.data.inputs ?? {},
                inputParams: node.data.inputParams ?? []
            }
        }))
    })
}

export const applyParsedAgentflowCanvasData = ({ serializedFlowData, setNodes, setEdges, onParsed, onError }) => {
    let flowData
    try {
        flowData = parseAgentflowCanvasData(serializedFlowData)
    } catch (error) {
        setNodes([])
        setEdges([])
        onError(getErrorMessage(error, '流程数据格式无效，请重新导入或刷新后重试'))
        return false
    }

    onParsed(flowData)
    return true
}

export const applyImportedAgentflowCanvasData = ({ serializedFlowData, setNodes, setEdges, onDirty, onError }) => {
    let flowData
    try {
        flowData = parseAgentflowCanvasData(serializedFlowData)
    } catch (error) {
        onError(getErrorMessage(error, '导入流程失败，请检查文件格式'))
        return false
    }

    setNodes(flowData.nodes)
    setEdges(flowData.edges)
    onDirty()
    return true
}

export const isExpectedAgentflowResource = (expectedFlowId, candidateChatflow) => {
    if (expectedFlowId) {
        return candidateChatflow?.id === expectedFlowId && candidateChatflow?.type === 'AGENTFLOW'
    }

    return candidateChatflow?.id === undefined && candidateChatflow?.type === 'AGENTFLOW'
}

export const isCurrentAgentflowSaveRequest = ({ context, kind, activeRouteId, activeGeneration }) =>
    isObjectRecord(context) && context.kind === kind && context.routeId === activeRouteId && context.routeGeneration === activeGeneration

export const isExpectedAgentflowSaveResponse = ({ context, activeRouteId, activeGeneration, response }) => {
    if (
        !isCurrentAgentflowSaveRequest({
            context,
            kind: context?.kind,
            activeRouteId,
            activeGeneration
        }) ||
        !isObjectRecord(response) ||
        response.type !== 'AGENTFLOW'
    ) {
        return false
    }

    if (context.kind === 'create') {
        return activeRouteId === '' && isNonEmptyString(response.id)
    }

    return context.kind === 'update' && isNonEmptyString(activeRouteId) && response.id === activeRouteId
}
