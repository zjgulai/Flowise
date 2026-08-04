import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'

export interface WorkspaceExportInput {
    agentflow: boolean
    agentflowv2: boolean
    assistantCustom: boolean
    assistantOpenAI: boolean
    assistantAzure: boolean
    chatflow: boolean
    chat_message: boolean
    chat_feedback: boolean
    custom_template: boolean
    document_store: boolean
    execution: boolean
    tool: boolean
    variable: boolean
}

const EXPORT_INPUT_KEYS = [
    'agentflow',
    'agentflowv2',
    'assistantCustom',
    'assistantOpenAI',
    'assistantAzure',
    'chatflow',
    'chat_message',
    'chat_feedback',
    'custom_template',
    'document_store',
    'execution',
    'tool',
    'variable'
] as const

export const normalizeWorkspaceExportInput = (value: unknown): WorkspaceExportInput => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid workspace export request')
    }
    const source = value as Record<string, unknown>
    if (Object.keys(source).some((key) => !EXPORT_INPUT_KEYS.includes(key as (typeof EXPORT_INPUT_KEYS)[number]))) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid workspace export request')
    }
    for (const key of EXPORT_INPUT_KEYS) {
        if (source[key] !== undefined && typeof source[key] !== 'boolean') {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid workspace export request')
        }
    }
    if (source.assistantOpenAI === true || source.assistantAzure === true) {
        throw new InternalFlowiseError(StatusCodes.GONE, '旧版 OpenAI 和 Azure 助手仅供归档，不能加入可恢复的工作区备份')
    }
    const normalized = Object.fromEntries(EXPORT_INPUT_KEYS.map((key) => [key, source[key] === true])) as unknown as WorkspaceExportInput
    if (!EXPORT_INPUT_KEYS.some((key) => normalized[key])) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid workspace export request')
    }

    return normalized
}
