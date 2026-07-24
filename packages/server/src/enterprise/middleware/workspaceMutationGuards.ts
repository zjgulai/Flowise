import { Request } from 'express'
import { StatusCodes } from 'http-status-codes'
import { In, QueryRunner } from 'typeorm'
import { Credential } from '../../database/entities/Credential'
import { CustomTemplate } from '../../database/entities/CustomTemplate'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { GeneralErrorMessage } from '../../utils/constants'
import { Workspace, WorkspaceName } from '../database/entities/workspace.entity'
import { LoggedInUser } from '../Interface.Enterprise'
import { getLoggedInUser } from '../utils/tenantRequestGuards'

export type WorkspaceShareItemType = 'credential' | 'custom_template'

const forbidden = () => new InternalFlowiseError(StatusCodes.FORBIDDEN, GeneralErrorMessage.FORBIDDEN)
const invalidRequest = () => new InternalFlowiseError(StatusCodes.BAD_REQUEST, GeneralErrorMessage.UNHANDLED_EDGE_CASE)

function assertWorkspaceBelongsToActiveOrganization(user: LoggedInUser, workspace: Workspace | null): asserts workspace is Workspace {
    if (!workspace || workspace.organizationId !== user.activeOrganizationId) throw forbidden()
}

export function bindWorkspaceCreateRequest(req: Request): void {
    const user = getLoggedInUser(req)
    const body = req.body ?? {}
    if (body.organizationId !== undefined && body.organizationId !== user.activeOrganizationId) throw forbidden()

    req.body = {
        name: body.name,
        description: body.description,
        organizationId: user.activeOrganizationId,
        createdBy: user.id,
        existingWorkspaceId: user.activeWorkspaceId
    }
}

export async function bindWorkspaceUpdateRequest(req: Request, queryRunner: QueryRunner): Promise<void> {
    const user = getLoggedInUser(req)
    const body = req.body ?? {}
    if (typeof body.id !== 'string' || !body.id) throw invalidRequest()

    const workspace = await queryRunner.manager.findOneBy(Workspace, { id: body.id })
    assertWorkspaceBelongsToActiveOrganization(user, workspace)
    if (workspace.name === WorkspaceName.DEFAULT_WORKSPACE || workspace.name === WorkspaceName.DEFAULT_PERSONAL_WORKSPACE) throw forbidden()

    // A non-org-admin permission snapshot belongs to the active workspace only.
    if (!user.isOrganizationAdmin && workspace.id !== user.activeWorkspaceId) throw forbidden()

    req.body = {
        id: workspace.id,
        name: body.name,
        description: body.description,
        updatedBy: user.id
    }
}

export async function assertWorkspaceDeleteRequest(req: Request, queryRunner: QueryRunner): Promise<Workspace> {
    const user = getLoggedInUser(req)
    const workspaceId = req.params.id
    if (typeof workspaceId !== 'string' || !workspaceId) throw invalidRequest()

    const workspace = await queryRunner.manager.findOneBy(Workspace, { id: workspaceId })
    assertWorkspaceBelongsToActiveOrganization(user, workspace)

    // Destructive cross-workspace authority is organization-wide and cannot be inferred from an active-workspace role.
    if (!user.isOrganizationAdmin || workspace.id === user.activeWorkspaceId) throw forbidden()
    if (workspace.name === WorkspaceName.DEFAULT_WORKSPACE || workspace.name === WorkspaceName.DEFAULT_PERSONAL_WORKSPACE) throw forbidden()

    return workspace
}

export function readWorkspaceShareItemType(value: unknown): WorkspaceShareItemType {
    if (value !== 'credential' && value !== 'custom_template') throw invalidRequest()
    return value
}

export function assertWorkspaceSharePermission(user: LoggedInUser, itemType: WorkspaceShareItemType): void {
    if (user.isOrganizationAdmin) return
    const permission = itemType === 'credential' ? 'credentials:share' : 'templates:custom-share'
    if (!user.permissions?.includes(permission)) throw forbidden()
}

export async function assertWorkspaceShareSource(
    user: LoggedInUser,
    itemId: string,
    itemType: WorkspaceShareItemType,
    queryRunner: QueryRunner
): Promise<void> {
    if (!itemId) throw invalidRequest()
    const source =
        itemType === 'credential'
            ? await queryRunner.manager.findOneBy(Credential, { id: itemId, workspaceId: user.activeWorkspaceId })
            : await queryRunner.manager.findOneBy(CustomTemplate, { id: itemId, workspaceId: user.activeWorkspaceId })
    if (!source) throw forbidden()
}

export async function validateWorkspaceShareRequest(
    req: Request,
    itemId: string,
    itemType: WorkspaceShareItemType,
    workspaceIds: unknown,
    queryRunner: QueryRunner
): Promise<string[]> {
    const user = getLoggedInUser(req)
    assertWorkspaceSharePermission(user, itemType)
    await assertWorkspaceShareSource(user, itemId, itemType, queryRunner)

    if (!Array.isArray(workspaceIds) || workspaceIds.length > 100 || workspaceIds.some((id) => typeof id !== 'string' || !id)) {
        throw invalidRequest()
    }

    const uniqueWorkspaceIds = [...new Set(workspaceIds as string[])]
    if (uniqueWorkspaceIds.includes(user.activeWorkspaceId)) throw forbidden()
    if (uniqueWorkspaceIds.length === 0) return []

    const workspaces = await queryRunner.manager.findBy(Workspace, { id: In(uniqueWorkspaceIds) })
    if (
        workspaces.length !== uniqueWorkspaceIds.length ||
        workspaces.some((workspace) => workspace.organizationId !== user.activeOrganizationId)
    ) {
        throw forbidden()
    }

    if (!user.isOrganizationAdmin) {
        const assignedWorkspaceIds = new Set((user.assignedWorkspaces ?? []).map((workspace) => workspace.id))
        if (uniqueWorkspaceIds.some((workspaceId) => !assignedWorkspaceIds.has(workspaceId))) throw forbidden()
    }

    return uniqueWorkspaceIds
}
