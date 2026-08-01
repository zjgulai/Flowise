import type { NodeData, NodeDataSchema } from '../types'

import { getMetadataDisplayText } from './metadataDisplay'
import { initNode } from './nodeFactory'

export function isNodeOutdated(nodeData: NodeData, componentNode: NodeDataSchema): boolean {
    if (componentNode.version == null || nodeData.version == null) return false
    return componentNode.version > nodeData.version
}

export function getNodeVersionWarning(nodeData: NodeData, componentNode: NodeDataSchema): string | null {
    if (nodeData.version == null && componentNode.version != null) {
        return `节点版本已过期\n请更新到最新版本 ${componentNode.version}`
    }
    if (nodeData.version != null && componentNode.version != null && componentNode.version > nodeData.version) {
        return `节点版本 ${nodeData.version} 已过期\n请更新到最新版本 ${componentNode.version}`
    }
    if (componentNode.badge === 'DEPRECATING') {
        return getMetadataDisplayText(componentNode, 'deprecateMessage') || '该节点将在下一版本弃用，请改用标记为“新增”的替代节点。'
    }
    if (typeof componentNode.warning === 'string' && componentNode.warning) {
        return getMetadataDisplayText(componentNode, 'warning', componentNode.warning)
    }
    return null
}

/**
 * Re-initialize a node to the latest component schema while preserving user data.
 * Port of updateOutdatedNodeData() from packages/ui/src/utils/genericHelper.js:233-351.
 */
export function upgradeNodeData(componentNode: NodeDataSchema, existingData: NodeData): NodeData {
    const upgraded = initNode(componentNode, existingData.id, true)

    if (existingData.credential) {
        upgraded.credential = existingData.credential
    }

    if (existingData.inputs && upgraded.inputs) {
        // Preserve matching inputs; also carry over *Config keys (loadConfig accordion side-channel
        // values not present in the inputParams schema directly).
        for (const key of Object.keys(existingData.inputs)) {
            if (key in upgraded.inputs || key.endsWith('Config')) {
                upgraded.inputs[key] = existingData.inputs[key]
            }
        }
    }

    upgraded.label = existingData.label

    return upgraded
}
