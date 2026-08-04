import { StatusCodes } from 'http-status-codes'
import { ChatFlow, EnumChatflowType } from '../../database/entities/ChatFlow'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'

export type GenericChatflowType = EnumChatflowType.CHATFLOW | EnumChatflowType.AGENTFLOW | EnumChatflowType.MULTIAGENT

export type ChatflowPermissionAction = 'view' | 'create' | 'update' | 'config'

export const GENERIC_CHATFLOW_TYPES: readonly GenericChatflowType[] = [
    EnumChatflowType.CHATFLOW,
    EnumChatflowType.AGENTFLOW,
    EnumChatflowType.MULTIAGENT
]

const permissionResourceForType = (type: GenericChatflowType): 'chatflows' | 'agentflows' =>
    type === EnumChatflowType.CHATFLOW ? 'chatflows' : 'agentflows'

export const requireGenericChatflowType = (type: unknown): GenericChatflowType => {
    if (!Object.values(EnumChatflowType).includes(type as EnumChatflowType)) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid Chatflow Type')
    }
    if (type === EnumChatflowType.ASSISTANT) {
        throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Assistant flows must use the assistant API')
    }
    return type as GenericChatflowType
}

export const getPermittedChatflowTypes = (
    permissions: readonly string[] | undefined,
    isOrganizationAdmin: boolean | undefined,
    action: ChatflowPermissionAction
): GenericChatflowType[] => {
    if (isOrganizationAdmin) return [...GENERIC_CHATFLOW_TYPES]
    const permissionSet = new Set(permissions ?? [])
    return GENERIC_CHATFLOW_TYPES.filter((type) => permissionSet.has(`${permissionResourceForType(type)}:${action}`))
}

export const requirePermittedChatflowType = (type: unknown, permittedTypes: readonly GenericChatflowType[]): GenericChatflowType => {
    const genericType = requireGenericChatflowType(type)
    if (!permittedTypes.includes(genericType)) {
        throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'You do not have permission for this flow type')
    }
    return genericType
}

export const stripGenericChatflowServerState = <T extends ChatFlow>(chatflow: T): T => {
    Reflect.deleteProperty(chatflow, 'mcpServerConfig')
    Reflect.deleteProperty(chatflow, 'webhookSecret')
    Reflect.deleteProperty(chatflow, 'webhookSecretConfigured')
    return chatflow
}
