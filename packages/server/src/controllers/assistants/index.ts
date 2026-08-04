import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { AssistantType } from '../../Interface'
import assistantsService from '../../services/assistants'
import { assertAssistantCreationAllowed } from '../../services/assistants/legacyPolicy'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { checkUsageLimit } from '../../utils/quotaUsage'

const parseDeleteBoth = (value: unknown): boolean => {
    if (value === undefined || value === false || value === 'false') return false
    if (value === true || value === 'true') return true
    throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'isDeleteBoth must be true or false')
}

const createAssistant = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.body) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: assistantsController.createAssistant - body not provided!`
            )
        }
        const body = req.body
        assertAssistantCreationAllowed(body.type)
        const orgId = req.user?.activeOrganizationId
        if (!orgId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: assistantsController.createAssistant - organization ${orgId} not found!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: assistantsController.createAssistant - workspace ${workspaceId} not found!`
            )
        }
        const subscriptionId = req.user?.activeOrganizationSubscriptionId || ''

        const existingAssistantCount = await assistantsService.getAssistantsCountByOrganization(body.type, orgId)
        const newAssistantCount = 1
        await checkUsageLimit('flows', subscriptionId, getRunningExpressApp().usageCacheManager, existingAssistantCount + newAssistantCount)

        const apiResponse = await assistantsService.createAssistant(body, orgId, workspaceId)

        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const deleteAssistant = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: assistantsController.deleteAssistant - id not provided!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: assistantsController.deleteAssistant - workspace ${workspaceId} not found!`
            )
        }
        const apiResponse = await assistantsService.deleteAssistant(req.params.id, parseDeleteBoth(req.query.isDeleteBoth), workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const deleteCustomAssistant = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.params?.id) {
            throw new InternalFlowiseError(StatusCodes.PRECONDITION_FAILED, 'Custom assistant id is required')
        }
        if (!req.body) {
            throw new InternalFlowiseError(StatusCodes.PRECONDITION_FAILED, 'Custom assistant delete snapshot is required')
        }
        const orgId = req.user?.activeOrganizationId
        if (!orgId) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Active organization not found')
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Active workspace not found')
        }
        const apiResponse = await assistantsService.deleteCustomAssistant(req.params.id, req.body, orgId, workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const getAllAssistants = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const type = req.query.type as AssistantType
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: assistantsController.getAllAssistants - workspace ${workspaceId} not found!`
            )
        }
        const apiResponse = await assistantsService.getAllAssistants(workspaceId, type)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const getAssistantById = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: assistantsController.getAssistantById - id not provided!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: assistantsController.getAssistantById - workspace ${workspaceId} not found!`
            )
        }
        const apiResponse = await assistantsService.getAssistantById(req.params.id, workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const updateAssistant = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: assistantsController.updateAssistant - id not provided!`
            )
        }
        if (!req.body) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: assistantsController.updateAssistant - body not provided!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: assistantsController.updateAssistant - workspace ${workspaceId} not found!`
            )
        }
        const apiResponse = await assistantsService.updateAssistant(req.params.id, req.body, workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const getCustomAssistantFlow = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: assistantsController.getCustomAssistantFlow - id not provided!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: assistantsController.getCustomAssistantFlow - workspace ${workspaceId} not found!`
            )
        }
        const apiResponse = await assistantsService.getCustomAssistantFlow(req.params.id, workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const saveCustomAssistant = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (typeof req.params === 'undefined' || !req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: assistantsController.saveCustomAssistant - id not provided!`
            )
        }
        if (!req.body) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: assistantsController.saveCustomAssistant - body not provided!`
            )
        }
        const orgId = req.user?.activeOrganizationId
        if (!orgId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: assistantsController.saveCustomAssistant - organization ${orgId} not found!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: assistantsController.saveCustomAssistant - workspace ${workspaceId} not found!`
            )
        }
        const subscriptionId = req.user?.activeOrganizationSubscriptionId || ''
        const apiResponse = await assistantsService.saveCustomAssistant(req.params.id, req.body, orgId, workspaceId, subscriptionId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const getChatModels = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const apiResponse = await assistantsService.getChatModels()
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const getDocumentStores = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: assistantsController.getDocumentStores - workspace ${workspaceId} not found!`
            )
        }
        const apiResponse = await assistantsService.getDocumentStores(workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const getTools = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const apiResponse = await assistantsService.getTools()
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const generateAssistantInstruction = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.body) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                `Error: assistantsController.generateAssistantInstruction - body not provided!`
            )
        }
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) {
            throw new InternalFlowiseError(
                StatusCodes.NOT_FOUND,
                `Error: assistantsController.generateAssistantInstruction - workspace not found!`
            )
        }
        const apiResponse = await assistantsService.generateAssistantInstruction(req.body.task, req.body.selectedChatModel, workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

export default {
    createAssistant,
    deleteAssistant,
    deleteCustomAssistant,
    getAllAssistants,
    getAssistantById,
    updateAssistant,
    getCustomAssistantFlow,
    saveCustomAssistant,
    getChatModels,
    getDocumentStores,
    getTools,
    generateAssistantInstruction
}
