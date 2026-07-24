import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { QueryRunner } from 'typeorm'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { GeneralErrorMessage } from '../../utils/constants'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { Workspace } from '../database/entities/workspace.entity'
import { assertWorkspaceIdAccessibleToUser, getLoggedInUser } from '../utils/tenantRequestGuards'

const forbidden = () => new InternalFlowiseError(StatusCodes.FORBIDDEN, GeneralErrorMessage.FORBIDDEN)

export function bindOrganizationMembershipMutationRequest(req: Request): void {
    const user = getLoggedInUser(req)
    const requestedOrganizationId = req.method === 'DELETE' ? req.query.organizationId : req.body?.organizationId
    if (typeof requestedOrganizationId !== 'string' || requestedOrganizationId !== user.activeOrganizationId) throw forbidden()

    if (req.method === 'POST') {
        req.body = {
            organizationId: user.activeOrganizationId,
            userId: req.body?.userId,
            roleId: req.body?.roleId,
            status: req.body?.status,
            createdBy: user.id
        }
    }
    if (req.method === 'PUT') {
        req.body = {
            organizationId: user.activeOrganizationId,
            userId: req.body?.userId,
            roleId: req.body?.roleId,
            status: req.body?.status,
            updatedBy: user.id
        }
    }
}

export async function bindWorkspaceMembershipMutationRequest(req: Request, queryRunner: QueryRunner): Promise<void> {
    const user = getLoggedInUser(req)
    const requestedWorkspaceId = req.method === 'DELETE' ? req.query.workspaceId : req.body?.workspaceId
    if (typeof requestedWorkspaceId !== 'string' || !requestedWorkspaceId) throw forbidden()

    const workspace = await queryRunner.manager.findOneBy(Workspace, { id: requestedWorkspaceId })
    if (!workspace || workspace.organizationId !== user.activeOrganizationId) throw forbidden()
    await assertWorkspaceIdAccessibleToUser(user, requestedWorkspaceId, queryRunner)

    if (req.method === 'POST') {
        req.body = {
            workspaceId: requestedWorkspaceId,
            userId: req.body?.userId,
            roleId: req.body?.roleId,
            status: req.body?.status,
            createdBy: user.id
        }
    }
    if (req.method === 'PUT') {
        req.body = {
            workspaceId: requestedWorkspaceId,
            userId: req.body?.userId,
            roleId: req.body?.roleId,
            status: req.body?.status,
            updatedBy: user.id
        }
    }
}

export function bindOrganizationMembershipMutation(req: Request, _res: Response, next: NextFunction) {
    try {
        bindOrganizationMembershipMutationRequest(req)
        next()
    } catch (error) {
        next(error)
    }
}

export async function bindWorkspaceMembershipMutation(req: Request, _res: Response, next: NextFunction) {
    const queryRunner = getRunningExpressApp().AppDataSource.createQueryRunner()
    try {
        await queryRunner.connect()
        await bindWorkspaceMembershipMutationRequest(req, queryRunner)
        next()
    } catch (error) {
        next(error)
    } finally {
        if (!queryRunner.isReleased) await queryRunner.release()
    }
}
