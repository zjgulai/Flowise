import { StatusCodes } from 'http-status-codes'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { OrganizationUserStatus } from '../database/entities/organization-user.entity'
import { UserStatus } from '../database/entities/user.entity'
import { WorkspaceUserStatus } from '../database/entities/workspace-user.entity'

export const ADMIN_ONLY_ERROR_MESSAGE = 'Invalid administrator credentials'
export const ACCOUNT_PROVISIONING_DISABLED_MESSAGE = '当前系统仅开放管理员账号登录。'

export function isAdminOnlyModeEnabled(value = process.env.ADMIN_ONLY_MODE): boolean {
    return value !== 'false'
}

export function assertAccountProvisioningAllowed(adminOnlyMode = isAdminOnlyModeEnabled()): void {
    if (adminOnlyMode) {
        throw new InternalFlowiseError(StatusCodes.FORBIDDEN, ACCOUNT_PROVISIONING_DISABLED_MESSAGE)
    }
}

export function assertAdminPasswordLoginAllowed(input: {
    userStatus: string
    workspaceStatus?: string
    organizationStatus?: string
    workspaceRoleId: string
    ownerRoleId: string
}): void {
    if (
        input.userStatus !== UserStatus.ACTIVE ||
        input.workspaceStatus !== WorkspaceUserStatus.ACTIVE ||
        input.organizationStatus !== OrganizationUserStatus.ACTIVE ||
        input.workspaceRoleId !== input.ownerRoleId
    ) {
        throw new InternalFlowiseError(StatusCodes.UNAUTHORIZED, ADMIN_ONLY_ERROR_MESSAGE)
    }
}
