import { NextFunction, Request, Response } from 'express'
import { StatusCodes } from 'http-status-codes'
import { QueryRunner } from 'typeorm'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { GeneralErrorMessage } from '../../utils/constants'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { OrganizationUserStatus } from '../database/entities/organization-user.entity'
import { GeneralRole } from '../database/entities/role.entity'
import { WorkspaceUserStatus } from '../database/entities/workspace-user.entity'
import { Workspace } from '../database/entities/workspace.entity'
import { IAssignedWorkspace, LoggedInUser } from '../Interface.Enterprise'
import { OrganizationUserErrorMessage, OrganizationUserService } from '../services/organization-user.service'
import { OrganizationErrorMessage, OrganizationService } from '../services/organization.service'
import { RoleErrorMessage, RoleService } from '../services/role.service'
import { UserErrorMessage, UserService } from '../services/user.service'
import { WorkspaceUserErrorMessage, WorkspaceUserService } from '../services/workspace-user.service'
import { WorkspaceErrorMessage, WorkspaceService } from '../services/workspace.service'
import { assertQueryOrganizationMatchesActiveOrg, assertWorkspaceIdAccessibleToUser, getLoggedInUser } from '../utils/tenantRequestGuards'
import { setTokenOrCookies } from '../middleware/passport/tokenResponse'
import {
    assertWorkspaceDeleteRequest,
    bindWorkspaceCreateRequest,
    bindWorkspaceUpdateRequest,
    readWorkspaceShareItemType,
    validateWorkspaceShareRequest
} from '../middleware/workspaceMutationGuards'

type SwitchedLoggedInUser = LoggedInUser & { role: string; isSSO: boolean; authVersion?: string }

export async function persistWorkspaceSwitch(req: Request, res: Response, switchedUser: SwitchedLoggedInUser) {
    req.user = switchedUser
    const passportSession = (req.session as Request['session'] & { passport?: { user?: LoggedInUser } }).passport
    if (!passportSession) {
        throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, GeneralErrorMessage.UNAUTHORIZED)
    }
    passportSession.user = switchedUser
    await new Promise<void>((resolve, reject) => {
        req.session.save((error) => (error ? reject(error) : resolve()))
    })

    // Workspace is part of both token identities, so switching must rotate both cookies.
    return setTokenOrCookies(res, switchedUser, true, req, false, Boolean(switchedUser.ssoProvider))
}

export function assertWorkspaceSwitchMembershipActive(workspaceUser: { status?: string }, organizationUser: { status?: string }): void {
    if (workspaceUser.status !== WorkspaceUserStatus.ACTIVE || organizationUser.status !== OrganizationUserStatus.ACTIVE) {
        throw new InternalFlowiseError(StatusCodes.FORBIDDEN, GeneralErrorMessage.FORBIDDEN)
    }
}

export class WorkspaceController {
    public async create(req: Request, res: Response, next: NextFunction) {
        try {
            bindWorkspaceCreateRequest(req)
            const workspaceUserService = new WorkspaceUserService()
            const newWorkspace = await workspaceUserService.createWorkspace(req.body)
            return res.status(StatusCodes.CREATED).json(newWorkspace)
        } catch (error) {
            next(error)
        }
    }

    public async read(req: Request, res: Response, next: NextFunction) {
        let queryRunner
        try {
            const user = getLoggedInUser(req)
            queryRunner = getRunningExpressApp().AppDataSource.createQueryRunner()
            await queryRunner.connect()
            const query = req.query as Partial<Workspace>
            const workspaceService = new WorkspaceService()

            assertQueryOrganizationMatchesActiveOrg(user, query.organizationId)

            let workspace:
                | Workspace
                | null
                | (Workspace & {
                      userCount: number
                  })[]
            if (query.id) {
                await assertWorkspaceIdAccessibleToUser(user, query.id, queryRunner)
                workspace = await workspaceService.readWorkspaceById(query.id, queryRunner)
            } else if (query.organizationId) {
                workspace = await workspaceService.readWorkspaceByOrganizationId(query.organizationId, queryRunner)
                if (!user.isOrganizationAdmin && Array.isArray(workspace)) {
                    const allowed = new Set((user.assignedWorkspaces ?? []).map((w) => w.id))
                    if (user.activeWorkspaceId) allowed.add(user.activeWorkspaceId)
                    workspace = workspace.filter((w) => allowed.has(w.id))
                }
            } else {
                throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, GeneralErrorMessage.UNHANDLED_EDGE_CASE)
            }

            return res.status(StatusCodes.OK).json(workspace)
        } catch (error) {
            next(error)
        } finally {
            if (queryRunner) await queryRunner.release()
        }
    }

    public async switchWorkspace(req: Request, res: Response, next: NextFunction) {
        if (!req.user) {
            return next(new InternalFlowiseError(StatusCodes.UNAUTHORIZED, `Unauthorized: User not found`))
        }
        let queryRunner
        try {
            queryRunner = getRunningExpressApp().AppDataSource.createQueryRunner()
            await queryRunner.connect()
            const query = req.query as Partial<Workspace>
            await queryRunner.startTransaction()

            const workspaceService = new WorkspaceService()
            const workspace = await workspaceService.readWorkspaceById(query.id, queryRunner)
            if (!workspace) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, WorkspaceErrorMessage.WORKSPACE_NOT_FOUND)

            const userService = new UserService()
            const user = await userService.readUserById(req.user.id, queryRunner)
            if (!user) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, UserErrorMessage.USER_NOT_FOUND)

            const workspaceUserService = new WorkspaceUserService()
            const { workspaceUser } = await workspaceUserService.readWorkspaceUserByWorkspaceIdUserId(query.id, req.user.id, queryRunner)
            if (!workspaceUser) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, WorkspaceUserErrorMessage.WORKSPACE_USER_NOT_FOUND)

            const organizationUserService = new OrganizationUserService()
            const { organizationUser } = await organizationUserService.readOrganizationUserByWorkspaceIdUserId(
                workspaceUser.workspaceId,
                workspaceUser.userId,
                queryRunner
            )
            if (!organizationUser)
                throw new InternalFlowiseError(StatusCodes.NOT_FOUND, OrganizationUserErrorMessage.ORGANIZATION_USER_NOT_FOUND)
            assertWorkspaceSwitchMembershipActive(workspaceUser, organizationUser)

            workspaceUser.lastLogin = new Date().toISOString()
            workspaceUser.updatedBy = user.id
            await workspaceUserService.saveWorkspaceUser(workspaceUser, queryRunner)

            const roleService = new RoleService()
            const ownerRole = await roleService.readGeneralRoleByName(GeneralRole.OWNER, queryRunner)
            const role = await roleService.readRoleById(workspaceUser.roleId, queryRunner)
            if (!role) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, RoleErrorMessage.ROLE_NOT_FOUND)

            const orgService = new OrganizationService()
            const org = await orgService.readOrganizationById(organizationUser.organizationId, queryRunner)
            if (!org) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, OrganizationErrorMessage.ORGANIZATION_NOT_FOUND)
            const subscriptionId = org.subscriptionId as string
            const customerId = org.customerId as string
            const features = await getRunningExpressApp().identityManager.getFeaturesByPlan(subscriptionId)
            const productId = await getRunningExpressApp().identityManager.getProductIdFromSubscription(subscriptionId)

            const workspaceUsers = await workspaceUserService.readWorkspaceUserByUserId(req.user.id, queryRunner)
            const assignedWorkspaces: IAssignedWorkspace[] = workspaceUsers
                .filter((assignedWorkspaceUser) => assignedWorkspaceUser.status === WorkspaceUserStatus.ACTIVE)
                .map((workspaceUser) => {
                    return {
                        id: workspaceUser.workspace.id,
                        name: workspaceUser.workspace.name,
                        role: workspaceUser.role?.name,
                        organizationId: workspaceUser.workspace.organizationId
                    } as IAssignedWorkspace
                })

            const loggedInUser: SwitchedLoggedInUser = {
                ...req.user,
                activeOrganizationId: org.id,
                activeOrganizationSubscriptionId: subscriptionId,
                activeOrganizationCustomerId: customerId,
                activeOrganizationProductId: productId,
                isOrganizationAdmin: organizationUser.roleId === ownerRole.id,
                activeWorkspaceId: workspace.id,
                activeWorkspace: workspace.name,
                assignedWorkspaces,
                isSSO: req.user.ssoProvider ? true : false,
                permissions: [...JSON.parse(role.permissions)],
                features,
                role: role.name,
                roleId: role.id
            }

            await queryRunner.commitTransaction()

            return persistWorkspaceSwitch(req, res, { ...req.user, ...loggedInUser })
        } catch (error) {
            if (queryRunner?.isTransactionActive) {
                await queryRunner.rollbackTransaction()
            }
            next(error)
        } finally {
            if (queryRunner && !queryRunner.isReleased) {
                await queryRunner.release()
            }
        }
    }

    public async update(req: Request, res: Response, next: NextFunction) {
        let queryRunner: QueryRunner | undefined
        try {
            queryRunner = getRunningExpressApp().AppDataSource.createQueryRunner()
            await queryRunner.connect()
            await bindWorkspaceUpdateRequest(req, queryRunner)
            const workspaceService = new WorkspaceService()
            const workspace = await workspaceService.updateWorkspace(req.body)
            return res.status(StatusCodes.OK).json(workspace)
        } catch (error) {
            next(error)
        } finally {
            if (queryRunner && !queryRunner.isReleased) await queryRunner.release()
        }
    }

    public async delete(req: Request, res: Response, next: NextFunction) {
        let queryRunner: QueryRunner | undefined
        try {
            queryRunner = getRunningExpressApp().AppDataSource.createQueryRunner()
            await queryRunner.connect()
            const workspaceId = req.params.id
            if (!workspaceId) {
                throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, WorkspaceErrorMessage.INVALID_WORKSPACE_ID)
            }
            await assertWorkspaceDeleteRequest(req, queryRunner)
            const workspaceService = new WorkspaceService()
            await queryRunner.startTransaction()

            const workspace = await workspaceService.deleteWorkspaceById(queryRunner, workspaceId)

            await queryRunner.commitTransaction()
            return res.status(StatusCodes.OK).json(workspace)
        } catch (error) {
            if (queryRunner && queryRunner.isTransactionActive) await queryRunner.rollbackTransaction()
            next(error)
        } finally {
            if (queryRunner && !queryRunner.isReleased) await queryRunner.release()
        }
    }

    public async getSharedWorkspacesForItem(req: Request, res: Response, next: NextFunction) {
        let queryRunner: QueryRunner | undefined
        try {
            if (typeof req.params === 'undefined' || !req.params.id) {
                throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, WorkspaceErrorMessage.INVALID_WORKSPACE_ID)
            }
            const user = getLoggedInUser(req)
            const itemType = readWorkspaceShareItemType(req.query.itemType)
            queryRunner = getRunningExpressApp().AppDataSource.createQueryRunner()
            await queryRunner.connect()
            await validateWorkspaceShareRequest(req, req.params.id, itemType, [], queryRunner)
            const workspaceService = new WorkspaceService()
            return res.json(await workspaceService.getSharedWorkspacesForItem(req.params.id, itemType, user.activeOrganizationId))
        } catch (error) {
            next(error)
        } finally {
            if (queryRunner && !queryRunner.isReleased) await queryRunner.release()
        }
    }

    public async setSharedWorkspacesForItem(req: Request, res: Response, next: NextFunction) {
        let queryRunner: QueryRunner | undefined
        try {
            const user = getLoggedInUser(req)
            if (typeof req.params === 'undefined' || !req.params.id) {
                throw new InternalFlowiseError(
                    StatusCodes.UNAUTHORIZED,
                    `Error: workspaceController.setSharedWorkspacesForItem - id not provided!`
                )
            }
            if (!req.body) {
                throw new InternalFlowiseError(
                    StatusCodes.PRECONDITION_FAILED,
                    `Error: workspaceController.setSharedWorkspacesForItem - body not provided!`
                )
            }
            const itemType = readWorkspaceShareItemType(req.body.itemType)
            queryRunner = getRunningExpressApp().AppDataSource.createQueryRunner()
            await queryRunner.connect()
            const workspaceIds = await validateWorkspaceShareRequest(req, req.params.id, itemType, req.body.workspaceIds, queryRunner)
            const workspaceService = new WorkspaceService()
            return res.json(
                await workspaceService.setSharedWorkspacesForItem(
                    req.params.id,
                    { itemType, workspaceIds },
                    { sourceWorkspaceId: user.activeWorkspaceId, organizationId: user.activeOrganizationId }
                )
            )
        } catch (error) {
            next(error)
        } finally {
            if (queryRunner && !queryRunner.isReleased) await queryRunner.release()
        }
    }
}
