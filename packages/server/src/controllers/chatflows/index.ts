import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { QueryRunner } from 'typeorm'
import { ChatFlow, EnumChatflowType } from '../../database/entities/ChatFlow'
import { WorkspaceUserErrorMessage, WorkspaceUserService } from '../../enterprise/services/workspace-user.service'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { ChatflowType } from '../../Interface'
import { ScheduleBeat } from '../../schedule/ScheduleBeat'
import apiKeyService from '../../services/apikey'
import chatflowsService from '../../services/chatflows'
import scheduleService from '../../services/schedule'
import { GeneralErrorMessage } from '../../utils/constants'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { getPageAndLimitParams } from '../../utils/pagination'
import { checkUsageLimit } from '../../utils/quotaUsage'
import { RateLimiterManager } from '../../utils/rateLimit'
import { sanitizeFlowDataForPublicEndpoint } from '../../utils/sanitizeFlowData'
import { stripProtectedFields } from '../../utils/stripProtectedFields'
import {
    ChatflowPermissionAction,
    GenericChatflowType,
    getPermittedChatflowTypes,
    requireGenericChatflowType,
    requirePermittedChatflowType
} from '../../services/chatflows/accessControl'

const getRequestPermittedTypes = (req: Request, action: ChatflowPermissionAction): GenericChatflowType[] =>
    getPermittedChatflowTypes(req.user?.permissions, req.user?.isOrganizationAdmin, action)

const requireActiveWorkspaceId = (req: Request): string => {
    const workspaceId = typeof req.user?.activeWorkspaceId === 'string' ? req.user.activeWorkspaceId.trim() : ''
    if (!workspaceId) throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Workspace ID is required')
    return workspaceId
}

const assertFlowAccess = async (
    req: Request,
    chatflowId: string,
    action: ChatflowPermissionAction
): Promise<{ workspaceId: string; permittedTypes: GenericChatflowType[] }> => {
    const workspaceId = requireActiveWorkspaceId(req)
    const permittedTypes = getRequestPermittedTypes(req, action)
    await chatflowsService.assertChatflowInWorkspaceAndTypes(chatflowId, workspaceId, permittedTypes)
    return { workspaceId, permittedTypes }
}

const checkIfChatflowIsValidForStreaming = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: chatflowsController.checkIfChatflowIsValidForStreaming - id not provided!`
            )
        }
        const apiResponse = await chatflowsService.checkIfChatflowIsValidForStreaming(req.params.id)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const checkIfChatflowIsValidForUploads = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: chatflowsController.checkIfChatflowIsValidForUploads - id not provided!`
            )
        }
        const apiResponse = await chatflowsService.checkIfChatflowIsValidForUploads(req.params.id)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const deleteChatflow = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new InternalFlowiseError(StatusCodes.PRECONDITION_FAILED, `Error: chatflowsController.deleteChatflow - id not provided!`)
        }
        const orgId = req.user?.activeOrganizationId
        if (!orgId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: chatflowsController.deleteChatflow - organization ${orgId} not found!`
            )
        }
        const workspaceId = requireActiveWorkspaceId(req)
        const userPermittedTypes: EnumChatflowType[] = []
        const permissions = req.user!.permissions
        if (req.user?.isOrganizationAdmin) {
            userPermittedTypes.push(EnumChatflowType.CHATFLOW)
            userPermittedTypes.push(EnumChatflowType.AGENTFLOW)
            userPermittedTypes.push(EnumChatflowType.MULTIAGENT)
            userPermittedTypes.push(EnumChatflowType.ASSISTANT)
        } else {
            if (permissions.includes(`chatflows:delete`)) userPermittedTypes.push(EnumChatflowType.CHATFLOW)
            if (permissions.includes(`agentflows:delete`)) userPermittedTypes.push(EnumChatflowType.AGENTFLOW)
            if (permissions.includes(`agentflows:delete`)) userPermittedTypes.push(EnumChatflowType.MULTIAGENT)
            if (permissions.includes(`assistants:delete`)) userPermittedTypes.push(EnumChatflowType.ASSISTANT)
            if (userPermittedTypes.length === 0)
                throw new InternalFlowiseError(StatusCodes.FORBIDDEN, `You do not have permission to delete any chatflow types`)
        }
        const apiResponse = await chatflowsService.deleteChatflow(req.params.id, orgId, workspaceId, userPermittedTypes)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const getAllChatflows = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const workspaceId = requireActiveWorkspaceId(req)
        let permittedTypes = getRequestPermittedTypes(req, 'view')
        const requestedType = req.query?.type
        if (requestedType !== undefined) {
            const permittedType = requirePermittedChatflowType(requestedType, permittedTypes)
            permittedTypes = [permittedType]
        }
        const { page, limit } = getPageAndLimitParams(req)
        const search = typeof req.query?.search === 'string' ? req.query.search.trim() : undefined
        const orderBy =
            typeof req.query?.orderBy === 'string' && ['name', 'updatedDate'].includes(req.query.orderBy)
                ? (req.query.orderBy as 'name' | 'updatedDate')
                : undefined
        const order =
            typeof req.query?.order === 'string' && ['asc', 'desc'].includes(req.query.order)
                ? (req.query.order as 'asc' | 'desc')
                : undefined

        const apiResponse = await chatflowsService.getAllChatflows(
            requestedType as ChatflowType,
            workspaceId,
            page,
            limit,
            search,
            orderBy,
            order,
            permittedTypes
        )
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

// Get specific chatflow via api key
const getChatflowByApiKey = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.apikey) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: chatflowsController.getChatflowByApiKey - apikey not provided!`
            )
        }
        const apikey = await apiKeyService.getApiKey(req.params.apikey)
        if (!apikey) {
            return res.status(401).send('Unauthorized')
        }
        const apiResponse = await chatflowsService.getChatflowByApiKey(apikey.id, apikey.workspaceId, req.query.keyonly)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const getChatflowById = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new InternalFlowiseError(StatusCodes.PRECONDITION_FAILED, `Error: chatflowsController.getChatflowById - id not provided!`)
        }
        const workspaceId = requireActiveWorkspaceId(req)
        const permittedTypes = getRequestPermittedTypes(req, 'view')
        const apiResponse = await chatflowsService.getChatflowByIdForWorkspaceAndTypes(req.params.id, workspaceId, permittedTypes)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const saveChatflow = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.body) {
            throw new InternalFlowiseError(StatusCodes.PRECONDITION_FAILED, `Error: chatflowsController.saveChatflow - body not provided!`)
        }
        const orgId = req.user?.activeOrganizationId
        if (!orgId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: chatflowsController.saveChatflow - organization ${orgId} not found!`
            )
        }
        const workspaceId = requireActiveWorkspaceId(req)
        const subscriptionId = req.user?.activeOrganizationSubscriptionId || ''
        const body = req.body
        const requestedType = requireGenericChatflowType(body.type)
        requirePermittedChatflowType(requestedType, getRequestPermittedTypes(req, 'create'))

        const existingChatflowCount = await chatflowsService.getAllChatflowsCountByOrganization(requestedType, orgId)
        const newChatflowCount = 1
        await checkUsageLimit('flows', subscriptionId, getRunningExpressApp().usageCacheManager, existingChatflowCount + newChatflowCount)

        const newChatFlow = new ChatFlow()
        Object.assign(newChatFlow, stripProtectedFields(body))

        newChatFlow.workspaceId = workspaceId
        const apiResponse = await chatflowsService.saveChatflow(
            newChatFlow,
            orgId,
            workspaceId,
            subscriptionId,
            getRunningExpressApp().usageCacheManager
        )

        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const updateChatflow = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new InternalFlowiseError(StatusCodes.PRECONDITION_FAILED, `Error: chatflowsController.updateChatflow - id not provided!`)
        }
        const workspaceId = requireActiveWorkspaceId(req)
        const permittedTypes = getRequestPermittedTypes(req, 'update')
        const chatflow = await chatflowsService.getChatflowByIdForWorkspaceAndTypes(req.params.id, workspaceId, permittedTypes)
        if (!chatflow) {
            return res.status(404).send('Chatflow not found')
        }
        const orgId = req.user?.activeOrganizationId
        if (!orgId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: chatflowsController.saveChatflow - organization ${orgId} not found!`
            )
        }
        const subscriptionId = req.user?.activeOrganizationSubscriptionId || ''
        const body = req.body
        if (body?.type !== undefined && body.type !== chatflow.type) {
            throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Changing a flow type through the generic endpoint is not allowed')
        }
        const updateChatFlow = new ChatFlow()
        Object.assign(updateChatFlow, stripProtectedFields(body))

        updateChatFlow.id = chatflow.id
        const apiResponse = await chatflowsService.updateChatflow(chatflow, updateChatFlow, orgId, workspaceId, subscriptionId)
        const rateLimiterManager = RateLimiterManager.getInstance()
        await rateLimiterManager.updateRateLimiter(apiResponse)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const getSinglePublicChatflow = async (req: Request, res: Response, next: NextFunction) => {
    let queryRunner: QueryRunner | undefined
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: chatflowsController.getSinglePublicChatflow - id not provided!`
            )
        }
        const chatflow = await chatflowsService.getChatflowById(req.params.id)
        if (!chatflow) return res.status(StatusCodes.NOT_FOUND).json({ message: 'Chatflow not found' })
        if (chatflow.type === EnumChatflowType.ASSISTANT) {
            return res.status(StatusCodes.NOT_FOUND).json({ message: 'Chatflow not found' })
        }
        if (chatflow.isPublic)
            return res.status(StatusCodes.OK).json({ ...chatflow, flowData: sanitizeFlowDataForPublicEndpoint(chatflow.flowData) })
        if (!req.user) return res.status(StatusCodes.UNAUTHORIZED).json({ message: GeneralErrorMessage.UNAUTHORIZED })
        queryRunner = getRunningExpressApp().AppDataSource.createQueryRunner()
        const workspaceUserService = new WorkspaceUserService()
        const workspaceUser = await workspaceUserService.readWorkspaceUserByUserId(req.user.id, queryRunner)
        if (workspaceUser.length === 0)
            return res.status(StatusCodes.NOT_FOUND).json({ message: WorkspaceUserErrorMessage.WORKSPACE_USER_NOT_FOUND })
        const workspaceIds = workspaceUser.map((user) => user.workspaceId)
        if (!workspaceIds.includes(chatflow.workspaceId))
            return res.status(StatusCodes.BAD_REQUEST).json({ message: 'You are not in the workspace that owns this chatflow' })
        requirePermittedChatflowType(chatflow.type, getRequestPermittedTypes(req, 'view'))
        return res.status(StatusCodes.OK).json(chatflow)
    } catch (error) {
        next(error)
    } finally {
        if (queryRunner) await queryRunner.release()
    }
}

const getSinglePublicChatbotConfig = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: chatflowsController.getSinglePublicChatbotConfig - id not provided!`
            )
        }
        const apiResponse = await chatflowsService.getSinglePublicChatbotConfig(req.params.id)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const checkIfChatflowHasChanged = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: chatflowsController.checkIfChatflowHasChanged - id not provided!`
            )
        }
        if (!req.params.lastUpdatedDateTime) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: chatflowsController.checkIfChatflowHasChanged - lastUpdatedDateTime not provided!`
            )
        }
        const { workspaceId } = await assertFlowAccess(req, req.params.id, 'update')
        const apiResponse = await chatflowsService.checkIfChatflowHasChanged(req.params.id, req.params.lastUpdatedDateTime, workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const setWebhookSecret = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: chatflowsController.setWebhookSecret - id not provided!`
            )
        }
        const { workspaceId, permittedTypes } = await assertFlowAccess(req, req.params.id, 'update')
        const apiResponse = await chatflowsService.setWebhookSecret(req.params.id, workspaceId, permittedTypes)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const clearWebhookSecret = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: chatflowsController.clearWebhookSecret - id not provided!`
            )
        }
        const { workspaceId, permittedTypes } = await assertFlowAccess(req, req.params.id, 'update')
        await chatflowsService.clearWebhookSecret(req.params.id, workspaceId, permittedTypes)
        return res.sendStatus(StatusCodes.NO_CONTENT)
    } catch (error) {
        next(error)
    }
}

const getScheduleStatus = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.params?.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                'Error: chatflowsController.getScheduleStatus - id not provided!'
            )
        }
        const { workspaceId } = await assertFlowAccess(req, req.params.id, 'view')
        const status = await scheduleService.getScheduleStatus(req.params.id, workspaceId)
        return res.json({
            enabled: status.record?.enabled ?? false,
            canEnable: status.canEnable,
            reason: status.reason,
            record: status.record
        })
    } catch (error) {
        next(error)
    }
}

const getScheduleTriggerLogs = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.params?.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                'Error: chatflowsController.getScheduleTriggerLogs - id not provided!'
            )
        }
        const { workspaceId } = await assertFlowAccess(req, req.params.id, 'view')
        const page = req.query.page ? parseInt(String(req.query.page), 10) : undefined
        const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined
        const statusRaw = req.query.status
        const status = Array.isArray(statusRaw) ? (statusRaw as any) : statusRaw ? (String(statusRaw) as any) : undefined
        const result = await scheduleService.getTriggerLogs(req.params.id, workspaceId, { page, limit, status })
        return res.json(result)
    } catch (error) {
        next(error)
    }
}

const deleteScheduleTriggerLogs = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.params?.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                'Error: chatflowsController.deleteScheduleTriggerLogs - id not provided!'
            )
        }
        const { workspaceId } = await assertFlowAccess(req, req.params.id, 'update')
        if (!req.user?.isOrganizationAdmin && !req.user?.permissions?.includes('executions:delete')) {
            throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Execution delete permission is required')
        }
        const logIds: unknown = req.body?.logIds
        if (!Array.isArray(logIds) || logIds.some((x) => typeof x !== 'string')) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'logIds must be a string[]')
        }
        const result = await scheduleService.deleteTriggerLogs(req.params.id, workspaceId, logIds as string[])
        return res.json(result)
    } catch (error) {
        next(error)
    }
}

const toggleScheduleEnabled = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.params?.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                'Error: chatflowsController.toggleScheduleEnabled - id not provided!'
            )
        }
        const { workspaceId } = await assertFlowAccess(req, req.params.id, 'update')
        const { enabled } = req.body
        if (typeof enabled !== 'boolean') {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, '"enabled" must be a boolean')
        }
        const record = await scheduleService.toggleScheduleEnabled(req.params.id, workspaceId, enabled)
        await ScheduleBeat.getInstance().onScheduleChanged(record.id, enabled ? 'upsert' : 'delete')
        return res.json(record)
    } catch (error) {
        next(error)
    }
}

export default {
    checkIfChatflowIsValidForStreaming,
    checkIfChatflowIsValidForUploads,
    deleteChatflow,
    getAllChatflows,
    getChatflowByApiKey,
    getChatflowById,
    saveChatflow,
    updateChatflow,
    getSinglePublicChatflow,
    getSinglePublicChatbotConfig,
    checkIfChatflowHasChanged,
    setWebhookSecret,
    clearWebhookSecret,
    getScheduleStatus,
    getScheduleTriggerLogs,
    deleteScheduleTriggerLogs,
    toggleScheduleEnabled
}
