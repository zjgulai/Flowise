import { StatusCodes } from 'http-status-codes'
import crypto from 'crypto'
import { In, IsNull } from 'typeorm'
import { z } from 'zod/v3'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getErrorMessage } from '../../errors/utils'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { IMcpServerConfig } from '../../Interface'
import {
    GENERIC_CHATFLOW_TYPES,
    GenericChatflowType,
    requireGenericChatflowType,
    requirePermittedChatflowType
} from '../chatflows/accessControl'
import {
    createMcpTokenHash,
    isSupportedMcpToken,
    isSupportedMcpTokenHash,
    parseStoredMcpServerConfig,
    serializeStoredMcpServerConfig,
    StoredMcpServerConfig,
    MAX_MCP_DESCRIPTION_LENGTH,
    verifyMcpTokenHash
} from './mcpTokenSecurity'

const toolNameSchema = z
    .string()
    .min(1, 'toolName is required')
    .max(64, 'toolName must be 64 characters or less')
    .regex(/^[a-zA-Z0-9_-]+$/, 'toolName must contain only alphanumeric characters, underscores, and hyphens')

const createConfigSchema = z.object({
    toolName: toolNameSchema,
    description: z.string().min(1, 'description is required').max(MAX_MCP_DESCRIPTION_LENGTH, 'description is too long')
})

const updateConfigSchema = z.object({
    toolName: toolNameSchema.optional(),
    description: z.string().min(1, 'description cannot be empty').max(MAX_MCP_DESCRIPTION_LENGTH, 'description is too long').optional(),
    enabled: z.boolean().optional()
})

function validateWithZod<T>(schema: z.ZodSchema<T>, data: unknown): T {
    const result = schema.safeParse(data)
    if (!result.success) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, result.error.errors[0].message)
    }
    return result.data
}

/**
 * Generate a 64-char hex token (256 bits of entropy).
 */
function generateToken(): string {
    return crypto.randomBytes(32).toString('hex')
}

/**
 * Parse the mcpServerConfig JSON string from a ChatFlow entity
 */
function parseMcpConfig(chatflow: ChatFlow): StoredMcpServerConfig | null {
    return parseStoredMcpServerConfig(chatflow.mcpServerConfig)
}

const toPublicConfig = (config: StoredMcpServerConfig | null, revealedToken?: string): IMcpServerConfig => ({
    configured: config !== null,
    enabled: config?.enabled === true,
    hasToken: !!config && (isSupportedMcpTokenHash(config.tokenHash) || isSupportedMcpToken(config.token)),
    description: config?.description || '',
    toolName: config?.toolName || '',
    ...(revealedToken ? { token: revealedToken } : {})
})

const hardenStoredConfig = (chatflowId: string, config: StoredMcpServerConfig): StoredMcpServerConfig => {
    const hardened = { ...config }
    if (hardened.description !== undefined) hardened.description = hardened.description.slice(0, MAX_MCP_DESCRIPTION_LENGTH)
    if (hardened.token !== undefined) {
        hardened.enabled = false
        delete hardened.token
        delete hardened.tokenHash
        return hardened
    }
    if (!hardened.enabled) {
        delete hardened.token
        delete hardened.tokenHash
        return hardened
    }
    if (!isSupportedMcpTokenHash(hardened.tokenHash)) {
        throw new InternalFlowiseError(StatusCodes.CONFLICT, 'MCP token rotation is required')
    }
    delete hardened.token
    return hardened
}

const getAuthorizedChatflowWithConfig = async (
    chatflowId: string,
    workspaceId: string,
    permittedTypes: readonly GenericChatflowType[]
): Promise<ChatFlow> => {
    const scopedWorkspaceId = typeof workspaceId === 'string' ? workspaceId.trim() : ''
    if (!scopedWorkspaceId) {
        throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Workspace ID is required')
    }
    if (permittedTypes.length === 0) {
        throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'You do not have permission to configure this flow type')
    }
    for (const permittedType of permittedTypes) requireGenericChatflowType(permittedType)

    const repository = getRunningExpressApp().AppDataSource.getRepository(ChatFlow)
    const chatflow = await repository
        .createQueryBuilder('chatflow')
        .addSelect('chatflow.mcpServerConfig')
        .where('chatflow.id = :chatflowId', { chatflowId })
        .andWhere('chatflow.workspaceId = :workspaceId', { workspaceId: scopedWorkspaceId })
        .andWhere('chatflow.type IN (:...permittedTypes)', { permittedTypes })
        .getOne()
    if (chatflow) return chatflow

    const existing = await repository.findOne({
        where: { id: chatflowId, workspaceId: scopedWorkspaceId },
        select: ['id', 'type']
    })
    if (!existing) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Chatflow ${chatflowId} not found`)
    }
    requirePermittedChatflowType(existing.type, permittedTypes)
    throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Chatflow changed concurrently')
}

const persistMcpConfig = async (
    chatflow: ChatFlow,
    workspaceId: string,
    permittedTypes: readonly GenericChatflowType[],
    config: StoredMcpServerConfig
): Promise<void> => {
    const serializedConfig = serializeStoredMcpServerConfig(config)
    const previousConfig = chatflow.mcpServerConfig
    if (previousConfig === serializedConfig) return

    const result = await getRunningExpressApp()
        .AppDataSource.getRepository(ChatFlow)
        .update(
            {
                id: chatflow.id,
                workspaceId: workspaceId.trim(),
                type: In([...permittedTypes]),
                mcpServerConfig: previousConfig == null ? IsNull() : previousConfig
            },
            { mcpServerConfig: serializedConfig }
        )
    if (result.affected !== 1) {
        throw new InternalFlowiseError(StatusCodes.CONFLICT, 'MCP server config changed concurrently')
    }
    chatflow.mcpServerConfig = serializedConfig
}

/**
 * Get MCP server config for a chatflow
 */
const getMcpServerConfig = async (
    chatflowId: string,
    workspaceId: string,
    permittedTypes: readonly GenericChatflowType[]
): Promise<IMcpServerConfig> => {
    try {
        const chatflow = await getAuthorizedChatflowWithConfig(chatflowId, workspaceId, permittedTypes)
        const existing = parseMcpConfig(chatflow)
        if (!existing) return toPublicConfig(null)
        const hardened = hardenStoredConfig(chatflow.id, existing)
        await persistMcpConfig(chatflow, workspaceId, permittedTypes, hardened)
        return toPublicConfig(hardened)
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: mcpServerService.getMcpServerConfig - ${getErrorMessage(error)}`
        )
    }
}

/**
 * Enable MCP server for a chatflow — generates a token and saves config
 */
const createMcpServerConfig = async (
    chatflowId: string,
    workspaceId: string,
    body: { description: string; toolName: string },
    permittedTypes: readonly GenericChatflowType[]
): Promise<IMcpServerConfig> => {
    try {
        const chatflow = await getAuthorizedChatflowWithConfig(chatflowId, workspaceId, permittedTypes)

        // If already has an MCP config, return it
        const existing = parseMcpConfig(chatflow)
        if (existing && existing.enabled) {
            const hardened = hardenStoredConfig(chatflow.id, existing)
            await persistMcpConfig(chatflow, workspaceId, permittedTypes, hardened)
            return toPublicConfig(hardened)
        }

        validateWithZod(createConfigSchema, body)

        const token = generateToken()
        const config: StoredMcpServerConfig = {
            enabled: true,
            tokenHash: createMcpTokenHash(chatflow.id, token),
            description: body.description,
            toolName: body.toolName
        }

        await persistMcpConfig(chatflow, workspaceId, permittedTypes, config)

        return toPublicConfig(config, token)
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: mcpServerService.createMcpServerConfig - ${getErrorMessage(error)}`
        )
    }
}

/**
 * Update MCP server config (description, toolName, enabled/disabled)
 */
const updateMcpServerConfig = async (
    chatflowId: string,
    workspaceId: string,
    body: { description?: string; toolName?: string; enabled?: boolean },
    permittedTypes: readonly GenericChatflowType[]
): Promise<IMcpServerConfig> => {
    try {
        const chatflow = await getAuthorizedChatflowWithConfig(chatflowId, workspaceId, permittedTypes)

        const parsed = parseMcpConfig(chatflow)
        if (!parsed) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `MCP server config not found for ID: ${chatflowId}`)
        }
        const existing = hardenStoredConfig(chatflow.id, parsed)

        validateWithZod(updateConfigSchema, body)

        if (body.description !== undefined) existing.description = body.description
        if (body.toolName !== undefined) existing.toolName = body.toolName
        let revealedToken: string | undefined
        if (body.enabled === false) {
            existing.enabled = false
            delete existing.token
            delete existing.tokenHash
        } else if (body.enabled === true && !existing.enabled) {
            revealedToken = generateToken()
            existing.enabled = true
            existing.tokenHash = createMcpTokenHash(chatflow.id, revealedToken)
            delete existing.token
        }

        await persistMcpConfig(chatflow, workspaceId, permittedTypes, existing)

        return toPublicConfig(existing, revealedToken)
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: mcpServerService.updateMcpServerConfig - ${getErrorMessage(error)}`
        )
    }
}

/**
 * Disable (soft delete) MCP server config
 */
const deleteMcpServerConfig = async (
    chatflowId: string,
    workspaceId: string,
    permittedTypes: readonly GenericChatflowType[]
): Promise<void> => {
    try {
        const chatflow = await getAuthorizedChatflowWithConfig(chatflowId, workspaceId, permittedTypes)

        const existing = parseMcpConfig(chatflow)
        if (!existing) return

        existing.enabled = false
        delete existing.token
        delete existing.tokenHash
        await persistMcpConfig(chatflow, workspaceId, permittedTypes, existing)
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: mcpServerService.deleteMcpServerConfig - ${getErrorMessage(error)}`
        )
    }
}

/**
 * Rotate (regenerate) the token
 */
const refreshMcpToken = async (
    chatflowId: string,
    workspaceId: string,
    permittedTypes: readonly GenericChatflowType[]
): Promise<IMcpServerConfig> => {
    try {
        const chatflow = await getAuthorizedChatflowWithConfig(chatflowId, workspaceId, permittedTypes)

        const existing = parseMcpConfig(chatflow)
        if (!existing) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `MCP server config not found for ID: ${chatflowId}`)
        }
        if (!existing.enabled) throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Disabled MCP server cannot rotate a token')

        const token = generateToken()
        existing.tokenHash = createMcpTokenHash(chatflow.id, token)
        delete existing.token
        await persistMcpConfig(chatflow, workspaceId, permittedTypes, existing)

        return toPublicConfig(existing, token)
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: mcpServerService.refreshMcpToken - ${getErrorMessage(error)}`
        )
    }
}

/**
 * Look up a chatflow by ID and verify the MCP token (constant-time comparison).
 */
const getChatflowByIdAndVerifyToken = async (chatflowId: string, token: string): Promise<ChatFlow> => {
    try {
        const appServer = getRunningExpressApp()
        const chatflow = await appServer.AppDataSource.getRepository(ChatFlow)
            .createQueryBuilder('chatflow')
            .addSelect('chatflow.mcpServerConfig')
            .where('chatflow.id = :chatflowId', { chatflowId })
            .andWhere('chatflow.type IN (:...genericTypes)', { genericTypes: [...GENERIC_CHATFLOW_TYPES] })
            .getOne()

        if (!chatflow) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'MCP server not found')
        }

        const config = parseMcpConfig(chatflow)
        if (!config || !config.enabled) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'MCP server not found')
        }

        if (isSupportedMcpTokenHash(config.tokenHash)) {
            if (!verifyMcpTokenHash(chatflow.id, token, config.tokenHash)) {
                throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, 'Invalid token')
            }
            return chatflow
        }

        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'MCP server not found')
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: mcpServerService.getChatflowByIdAndVerifyToken - ${getErrorMessage(error)}`
        )
    }
}

export default {
    getMcpServerConfig,
    createMcpServerConfig,
    updateMcpServerConfig,
    deleteMcpServerConfig,
    refreshMcpToken,
    getChatflowByIdAndVerifyToken,
    parseMcpConfig
}
