import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import mcpServerService from '../../services/mcp-server'
import { getPermittedChatflowTypes } from '../../services/chatflows/accessControl'

const getConfigPermittedTypes = (req: Request) => {
    const permittedTypes = getPermittedChatflowTypes(req.user?.permissions, req.user?.isOrganizationAdmin, 'config')
    if (permittedTypes.length === 0) {
        throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'You do not have permission to configure any flow types')
    }
    return permittedTypes
}

const requireActiveWorkspaceId = (req: Request): string => {
    const workspaceId = typeof req.user?.activeWorkspaceId === 'string' ? req.user.activeWorkspaceId.trim() : ''
    if (!workspaceId) throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Workspace ID is required')
    return workspaceId
}

const preventMcpTokenCaching = (res: Response): void => {
    res.set('Cache-Control', 'no-store')
    res.set('Pragma', 'no-cache')
}

const getMcpServerConfig = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                'Error: mcpServerController.getMcpServerConfig - id not provided!'
            )
        }
        const workspaceId = requireActiveWorkspaceId(req)
        const apiResponse = await mcpServerService.getMcpServerConfig(req.params.id, workspaceId, getConfigPermittedTypes(req))
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const createMcpServerConfig = async (req: Request, res: Response, next: NextFunction) => {
    try {
        preventMcpTokenCaching(res)
        if (!req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                'Error: mcpServerController.createMcpServerConfig - id not provided!'
            )
        }
        const workspaceId = requireActiveWorkspaceId(req)
        const apiResponse = await mcpServerService.createMcpServerConfig(
            req.params.id,
            workspaceId,
            req.body || {},
            getConfigPermittedTypes(req)
        )
        return res.status(StatusCodes.CREATED).json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const updateMcpServerConfig = async (req: Request, res: Response, next: NextFunction) => {
    try {
        preventMcpTokenCaching(res)
        if (!req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                'Error: mcpServerController.updateMcpServerConfig - id not provided!'
            )
        }
        const workspaceId = requireActiveWorkspaceId(req)
        const apiResponse = await mcpServerService.updateMcpServerConfig(
            req.params.id,
            workspaceId,
            req.body || {},
            getConfigPermittedTypes(req)
        )
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

const deleteMcpServerConfig = async (req: Request, res: Response, next: NextFunction) => {
    try {
        if (!req.params.id) {
            throw new InternalFlowiseError(
                StatusCodes.PRECONDITION_FAILED,
                'Error: mcpServerController.deleteMcpServerConfig - id not provided!'
            )
        }
        const workspaceId = requireActiveWorkspaceId(req)
        await mcpServerService.deleteMcpServerConfig(req.params.id, workspaceId, getConfigPermittedTypes(req))
        return res.json({ message: 'MCP server config disabled' })
    } catch (error) {
        next(error)
    }
}

const refreshMcpToken = async (req: Request, res: Response, next: NextFunction) => {
    try {
        preventMcpTokenCaching(res)
        if (!req.params.id) {
            throw new InternalFlowiseError(StatusCodes.PRECONDITION_FAILED, 'Error: mcpServerController.refreshMcpToken - id not provided!')
        }
        const workspaceId = requireActiveWorkspaceId(req)
        const apiResponse = await mcpServerService.refreshMcpToken(req.params.id, workspaceId, getConfigPermittedTypes(req))
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

export default {
    getMcpServerConfig,
    createMcpServerConfig,
    updateMcpServerConfig,
    deleteMcpServerConfig,
    refreshMcpToken
}
