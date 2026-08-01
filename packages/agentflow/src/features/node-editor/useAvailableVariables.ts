import { useMemo } from 'react'

import type { VariableItem } from '@/atoms/VariablePicker'
import { getAgentflowIcon } from '@/core/node-config'
import { getDefinedStateKeys, getUpstreamNodes, resolveInstanceDisplayLabel } from '@/core/utils'
import { useAgentflowContext } from '@/infrastructure/store'

// ── Static global variables (matches original suggestionOption.js) ───────────

const GLOBAL_VARIABLES: VariableItem[] = [
    { label: 'question', description: '用户在聊天框中输入的问题', category: '对话上下文', value: '{{question}}' },
    {
        label: 'chat_history',
        description: '用户与 AI 之间的历史对话',
        category: '对话上下文',
        value: '{{chat_history}}'
    },
    {
        label: 'current_date_time',
        description: '当前日期和时间',
        category: '对话上下文',
        value: '{{current_date_time}}'
    },
    {
        label: 'runtime_messages_length',
        description: '大模型与智能体之间的消息总数',
        category: '对话上下文',
        value: '{{runtime_messages_length}}'
    },
    {
        label: 'loop_count',
        description: '当前循环次数',
        category: '对话上下文',
        value: '{{loop_count}}'
    },
    {
        label: 'file_attachment',
        description: '通过聊天上传的文件',
        category: '对话上下文',
        value: '{{file_attachment}}'
    },
    { label: '$flow.sessionId', description: '当前会话 ID', category: '流程变量', value: '{{$flow.sessionId}}' },
    { label: '$flow.chatId', description: '当前聊天 ID', category: '流程变量', value: '{{$flow.chatId}}' },
    {
        label: '$flow.chatflowId',
        description: '当前对话流程 ID',
        category: '流程变量',
        value: '{{$flow.chatflowId}}'
    }
]

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Returns the list of variable items available for a given node.
 *
 * Matches the original suggestionOption.js behaviour:
 * - Chat context: question, chat_history, current_date_time, runtime_messages_length, loop_count, file_attachment
 * - Flow variables: $flow.sessionId, $flow.chatId, $flow.chatflowId
 * - Upstream node outputs (from edges)
 * - Flow state variables (from startAgentflow node's startState)
 *
 * Lives in the features layer so it can read from AgentflowContext.
 * The returned items are passed to the VariablePicker atom via props.
 */
export function useAvailableVariables(nodeId: string): VariableItem[] {
    const { state } = useAgentflowContext()
    const { nodes, edges, componentNodes } = state

    return useMemo(() => {
        const items: VariableItem[] = [...GLOBAL_VARIABLES]

        // Nodes inside an iteration group (extent === 'parent') get access to $iteration
        const currentNode = nodes.find((n) => n.id === nodeId)
        if (currentNode?.extent === 'parent') {
            items.unshift({
                label: '$iteration',
                description: '当前迭代项。JSON 数据请使用点号访问，例如 $iteration.name',
                category: '迭代',
                value: '{{$iteration}}'
            })
        }

        // ── Upstream node outputs ────────────────────────────────────────
        const upstreamNodes = getUpstreamNodes(nodeId, nodes, edges)
        for (const node of upstreamNodes) {
            if (node.data.name === 'startAgentflow') continue
            const displayName =
                (node.data.inputs?.chainName as string) ??
                (node.data.inputs?.functionName as string) ??
                (node.data.inputs?.variableName as string) ??
                node.data.id

            const agentflowIcon = getAgentflowIcon(node.data.name)
            const component = componentNodes.find((candidate) => candidate.name === node.data.name)
            const nodeDisplayLabel = resolveInstanceDisplayLabel(node.data, component) || node.data.name
            items.push({
                label: displayName,
                description: `来自${nodeDisplayLabel}的输出`,
                category: '节点输出',
                value: `{{${node.id}}}`,
                icon: agentflowIcon?.icon,
                iconColor: agentflowIcon?.color
            })
        }

        // ── Flow state variables from all nodes ─────────────────────────
        const stateKeys = getDefinedStateKeys(nodes)
        for (const key of stateKeys) {
            items.push({
                label: `$flow.state.${key}`,
                description: '指定键对应的流程状态当前值',
                category: '流程状态',
                value: `{{$flow.state.${key}}}`
            })
        }

        return items
    }, [nodeId, nodes, edges, componentNodes])
}
