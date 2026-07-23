import { QueryRunner } from 'typeorm'
import { StatusCodes } from 'http-status-codes'
import { IdentityManager } from '../../IdentityManager'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { OrganizationUserStatus } from '../database/entities/organization-user.entity'
import { GeneralRole } from '../database/entities/role.entity'
import { User } from '../database/entities/user.entity'
import { WorkspaceUser, WorkspaceUserStatus } from '../database/entities/workspace-user.entity'
import { IAssignedWorkspace, LoggedInUser } from '../Interface.Enterprise'
import { OrganizationUserErrorMessage, OrganizationUserService } from './organization-user.service'
import { OrganizationService } from './organization.service'
import { RoleErrorMessage, RoleService } from './role.service'
import { WorkspaceUserService } from './workspace-user.service'
import { assertAdminPasswordLoginAllowed, isAdminOnlyModeEnabled } from '../utils/adminOnlyPolicy'

export type LoggedInUserBuildMode = 'password-login' | 'acceptance-login'

export interface BuildLoggedInUserInput {
    user: Pick<User, 'id' | 'email' | 'name' | 'status'>
    workspaceUser: WorkspaceUser
    queryRunner: QueryRunner
    identityManager: IdentityManager
    mode: LoggedInUserBuildMode
    adminOnlyMode?: boolean
}

export interface LoggedInUserBuilderDependencies {
    workspaceUserService: Pick<WorkspaceUserService, 'updateWorkspaceUser' | 'readWorkspaceUserByUserId'>
    organizationUserService: Pick<OrganizationUserService, 'readOrganizationUserByWorkspaceIdUserId' | 'updateOrganizationUser'>
    roleService: Pick<RoleService, 'readGeneralRoleByName' | 'readRoleById'>
    organizationService: Pick<OrganizationService, 'readOrganizationById'>
}

export async function buildLoggedInUser(
    { user, workspaceUser, queryRunner, identityManager, mode, adminOnlyMode = isAdminOnlyModeEnabled() }: BuildLoggedInUserInput,
    overrides: Partial<LoggedInUserBuilderDependencies> = {}
): Promise<LoggedInUser> {
    const workspaceUserService = overrides.workspaceUserService ?? new WorkspaceUserService()
    const organizationUserService = overrides.organizationUserService ?? new OrganizationUserService()
    const roleService = overrides.roleService ?? new RoleService()
    const organizationService = overrides.organizationService ?? new OrganizationService()

    const { organizationUser } = await organizationUserService.readOrganizationUserByWorkspaceIdUserId(
        workspaceUser.workspaceId,
        workspaceUser.userId,
        queryRunner
    )
    if (!organizationUser) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, OrganizationUserErrorMessage.ORGANIZATION_USER_NOT_FOUND)
    }

    const ownerRole = await roleService.readGeneralRoleByName(GeneralRole.OWNER, queryRunner)

    if (mode === 'acceptance-login') {
        if (workspaceUser.status !== WorkspaceUserStatus.ACTIVE || organizationUser.status !== OrganizationUserStatus.ACTIVE) {
            throw new Error('Inactive acceptance membership')
        }
    } else if (adminOnlyMode) {
        assertAdminPasswordLoginAllowed({
            userStatus: user.status,
            workspaceStatus: workspaceUser.status,
            organizationStatus: organizationUser.status,
            workspaceRoleId: workspaceUser.roleId,
            ownerRoleId: ownerRole.id
        })
        workspaceUser.lastLogin = new Date().toISOString()
        workspaceUser.updatedBy = workspaceUser.userId
        await workspaceUserService.updateWorkspaceUser(workspaceUser, queryRunner)
    } else {
        workspaceUser.status = WorkspaceUserStatus.ACTIVE
        workspaceUser.lastLogin = new Date().toISOString()
        workspaceUser.updatedBy = workspaceUser.userId
        organizationUser.status = OrganizationUserStatus.ACTIVE
        await workspaceUserService.updateWorkspaceUser(workspaceUser, queryRunner)
        await organizationUserService.updateOrganizationUser(organizationUser)
    }

    const workspaceUsers = await workspaceUserService.readWorkspaceUserByUserId(organizationUser.userId, queryRunner)
    const assignedWorkspaces: IAssignedWorkspace[] = workspaceUsers.map((assignedWorkspaceUser) => ({
        id: assignedWorkspaceUser.workspace.id,
        name: assignedWorkspaceUser.workspace.name,
        role: assignedWorkspaceUser.role?.name,
        organizationId: assignedWorkspaceUser.workspace.organizationId
    })) as IAssignedWorkspace[]

    const role = await roleService.readRoleById(workspaceUser.roleId, queryRunner)
    if (!role) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, RoleErrorMessage.ROLE_NOT_FOUND)

    const organization = await organizationService.readOrganizationById(organizationUser.organizationId, queryRunner)
    if (!organization) throw new Error('Organization not found')

    const subscriptionId = organization.subscriptionId as string
    const customerId = organization.customerId as string
    const features = await identityManager.getFeaturesByPlan(subscriptionId)
    const productId = await identityManager.getProductIdFromSubscription(subscriptionId)

    return {
        id: workspaceUser.userId,
        email: user.email,
        name: user.name ?? user.email,
        roleId: workspaceUser.roleId,
        activeOrganizationId: organization.id,
        activeOrganizationSubscriptionId: subscriptionId,
        activeOrganizationCustomerId: customerId,
        activeOrganizationProductId: productId,
        isOrganizationAdmin: workspaceUser.roleId === ownerRole.id,
        activeWorkspaceId: workspaceUser.workspaceId,
        activeWorkspace: workspaceUser.workspace.name,
        assignedWorkspaces,
        permissions: [...JSON.parse(role.permissions)],
        features
    }
}
