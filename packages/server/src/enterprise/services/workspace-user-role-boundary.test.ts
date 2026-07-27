import { OrganizationUser } from '../database/entities/organization-user.entity'
import { WorkspaceUser, WorkspaceUserStatus } from '../database/entities/workspace-user.entity'
import {
    assertWorkspaceInvitationActivationAllowed,
    assertWorkspaceOwnerMutationAllowed,
    assertWorkspaceRoleAssignmentAllowed,
    WorkspaceUserService
} from './workspace-user.service'

const workspace = { id: 'workspace-a', organizationId: 'org-a', name: 'Workspace A' }
const memberRole = { id: 'member-role', organizationId: null, name: 'member', permissions: '[]' }
const ownerRole = { id: 'owner-role', organizationId: null, name: 'owner', permissions: '["admin"]' }
const foreignRole = { id: 'foreign-role', organizationId: 'org-b', name: 'foreign admin', permissions: '["admin"]' }
const customRole = { id: 'custom-role', organizationId: 'org-a', name: 'editor', permissions: '["chatflows:update"]' }
const actorRole = { id: 'actor-role', organizationId: 'org-a', name: 'manager', permissions: '["chatflows:view"]' }
const elevatedRole = {
    id: 'elevated-role',
    organizationId: 'org-a',
    name: 'elevated',
    permissions: '["chatflows:view","users:manage"]'
}

const makeHarness = (role: any, organizationRoleId = memberRole.id, actorOrganizationRoleId = ownerRole.id) => {
    let transactionActive = false
    const manager = {
        findOneBy: jest.fn().mockImplementation(async (entity, criteria) => {
            if (entity === OrganizationUser && criteria.userId === 'actor-user') {
                return { organizationId: 'org-a', userId: 'actor-user', roleId: actorOrganizationRoleId, status: 'active' }
            }
            if (entity === OrganizationUser) {
                return { organizationId: 'org-a', userId: 'target-user', roleId: organizationRoleId, status: 'active' }
            }
            if (entity === WorkspaceUser && criteria.userId === 'actor-user') {
                return {
                    workspaceId: 'workspace-a',
                    userId: 'actor-user',
                    roleId: actorRole.id,
                    status: WorkspaceUserStatus.ACTIVE
                }
            }
            return null
        }),
        create: jest.fn((_entity, value) => ({ ...value })),
        save: jest.fn(async (_entity, value) => ({ ...value })),
        merge: jest.fn((_entity, current, value) => ({ ...current, ...value }))
    }
    const queryRunner: any = {
        manager,
        connect: jest.fn().mockResolvedValue(undefined),
        startTransaction: jest.fn().mockImplementation(async () => {
            transactionActive = true
        }),
        commitTransaction: jest.fn().mockImplementation(async () => {
            transactionActive = false
        }),
        rollbackTransaction: jest.fn().mockImplementation(async () => {
            transactionActive = false
        }),
        release: jest.fn().mockResolvedValue(undefined)
    }
    Object.defineProperty(queryRunner, 'isTransactionActive', { get: () => transactionActive })

    const service = Object.create(WorkspaceUserService.prototype) as WorkspaceUserService
    ;(service as any).dataSource = { createQueryRunner: jest.fn().mockReturnValue(queryRunner) }
    ;(service as any).roleService = {
        readRoleById: jest.fn().mockImplementation(async (id) => (id === actorRole.id ? actorRole : role)),
        readGeneralRoleByName: jest.fn().mockResolvedValue(ownerRole),
        saveRole: jest.fn()
    }
    ;(service as any).userService = { readUserById: jest.fn().mockResolvedValue({ id: 'actor-user' }) }
    ;(service as any).workspaceService = { saveWorkspace: jest.fn(async (value) => value) }
    ;(service as any).readWorkspaceUserByWorkspaceIdUserId = jest.fn().mockResolvedValue({ workspace, workspaceUser: null })
    ;(service as any).saveWorkspaceUser = jest.fn(async (value) => value)
    return { service, queryRunner, manager }
}

describe('WorkspaceUserService role tenant boundary', () => {
    it('rejects assigning permissions the workspace manager does not hold', async () => {
        const { service, queryRunner, manager } = makeHarness(elevatedRole, memberRole.id, memberRole.id)

        await expect(
            service.createWorkspaceUser({
                workspaceId: workspace.id,
                userId: 'target-user',
                roleId: elevatedRole.id,
                createdBy: 'actor-user'
            })
        ).rejects.toThrow('Forbidden')

        expect(queryRunner.startTransaction).not.toHaveBeenCalled()
        expect(manager.save).not.toHaveBeenCalled()
        expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled()
        expect(queryRunner.release).toHaveBeenCalledTimes(1)
    })

    it('accepts only well-formed permission arrays and enforces subset assignment', () => {
        expect(() => assertWorkspaceRoleAssignmentAllowed(actorRole as any, actorRole as any)).not.toThrow()
        expect(() => assertWorkspaceRoleAssignmentAllowed(actorRole as any, elevatedRole as any)).toThrow(
            expect.objectContaining({ statusCode: 403 })
        )
        expect(() => assertWorkspaceRoleAssignmentAllowed({ ...actorRole, permissions: '{}' } as any, customRole as any)).toThrow(
            'Invalid Role Permissions'
        )
    })

    it('allows only an organization owner to grant or mutate a workspace owner membership', () => {
        expect(() =>
            assertWorkspaceOwnerMutationAllowed({
                actorOrganizationRoleId: ownerRole.id,
                requestedWorkspaceRoleId: ownerRole.id,
                ownerRoleId: ownerRole.id
            })
        ).not.toThrow()
        expect(() =>
            assertWorkspaceOwnerMutationAllowed({
                actorOrganizationRoleId: memberRole.id,
                requestedWorkspaceRoleId: ownerRole.id,
                ownerRoleId: ownerRole.id
            })
        ).toThrow(expect.objectContaining({ statusCode: 403 }))
        expect(() =>
            assertWorkspaceOwnerMutationAllowed({
                actorOrganizationRoleId: memberRole.id,
                targetWorkspaceRoleId: ownerRole.id,
                ownerRoleId: ownerRole.id
            })
        ).toThrow(expect.objectContaining({ statusCode: 403 }))
    })

    it('allows only the invited workspace member to activate their own membership', () => {
        expect(() =>
            assertWorkspaceInvitationActivationAllowed({
                currentStatus: WorkspaceUserStatus.INVITED,
                requestedStatus: WorkspaceUserStatus.ACTIVE,
                targetUserId: 'target-user',
                actorUserId: 'target-user'
            })
        ).not.toThrow()
        expect(() =>
            assertWorkspaceInvitationActivationAllowed({
                currentStatus: WorkspaceUserStatus.INVITED,
                requestedStatus: WorkspaceUserStatus.ACTIVE,
                targetUserId: 'target-user',
                actorUserId: 'admin-user'
            })
        ).toThrow(expect.objectContaining({ statusCode: 403 }))
        expect(() =>
            assertWorkspaceInvitationActivationAllowed({
                currentStatus: WorkspaceUserStatus.INVITED,
                requestedStatus: WorkspaceUserStatus.DISABLE,
                targetUserId: 'target-user',
                actorUserId: 'admin-user'
            })
        ).toThrow(expect.objectContaining({ statusCode: 403 }))
    })

    it('rejects a custom role owned by another organization before any membership write', async () => {
        const { service, queryRunner, manager } = makeHarness(foreignRole)

        await expect(
            service.createWorkspaceUser({
                workspaceId: workspace.id,
                userId: 'target-user',
                roleId: foreignRole.id,
                createdBy: 'actor-user'
            })
        ).rejects.toThrow('Role Not Found')

        expect(queryRunner.startTransaction).not.toHaveBeenCalled()
        expect(manager.save).not.toHaveBeenCalled()
    })

    it('rejects assigning the global owner role to an organization member', async () => {
        const { service, queryRunner } = makeHarness(ownerRole, memberRole.id)
        ;(service as any).readWorkspaceUserByWorkspaceIdUserId.mockResolvedValue({
            workspace,
            workspaceUser: {
                workspaceId: workspace.id,
                userId: 'target-user',
                roleId: memberRole.id,
                role: memberRole,
                status: 'active',
                createdBy: 'actor-user'
            } as unknown as WorkspaceUser
        })

        await expect(
            service.updateWorkspaceUser(
                { workspaceId: workspace.id, userId: 'target-user', roleId: ownerRole.id, updatedBy: 'actor-user' },
                queryRunner
            )
        ).rejects.toThrow('Role Not Found')

        expect(queryRunner.manager.save).not.toHaveBeenCalled()
    })

    it('rejects a non-owner attempting to disable a workspace owner membership', async () => {
        const { service, queryRunner } = makeHarness(customRole, ownerRole.id, memberRole.id)
        ;(service as any).readWorkspaceUserByWorkspaceIdUserId.mockResolvedValue({
            workspace,
            workspaceUser: {
                workspaceId: workspace.id,
                userId: 'target-user',
                roleId: ownerRole.id,
                role: ownerRole,
                status: WorkspaceUserStatus.ACTIVE,
                createdBy: 'owner-user'
            } as unknown as WorkspaceUser
        })

        await expect(
            service.updateWorkspaceUser(
                {
                    workspaceId: workspace.id,
                    userId: 'target-user',
                    status: WorkspaceUserStatus.DISABLE,
                    updatedBy: 'actor-user'
                },
                queryRunner
            )
        ).rejects.toThrow('Forbidden')

        expect(queryRunner.manager.save).not.toHaveBeenCalled()
    })

    it('allows an organization-scoped role and never saves the role entity as a side effect', async () => {
        const { service, queryRunner } = makeHarness(customRole)

        await expect(
            service.createWorkspaceUser({
                workspaceId: workspace.id,
                userId: 'target-user',
                roleId: customRole.id,
                createdBy: 'actor-user'
            })
        ).resolves.toMatchObject({ workspaceId: workspace.id, userId: 'target-user', roleId: customRole.id })

        expect(queryRunner.startTransaction).toHaveBeenCalledTimes(1)
        expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1)
        expect(queryRunner.release).toHaveBeenCalledTimes(1)
        expect((service as any).roleService.saveRole).not.toHaveBeenCalled()
    })

    it('forces a newly created workspace membership to invited even when the client requests active', async () => {
        const { service } = makeHarness(customRole)

        await expect(
            service.createWorkspaceUser({
                workspaceId: workspace.id,
                userId: 'target-user',
                roleId: customRole.id,
                status: WorkspaceUserStatus.ACTIVE,
                createdBy: 'actor-user'
            })
        ).resolves.toMatchObject({ status: WorkspaceUserStatus.INVITED })

        expect((service as any).saveWorkspaceUser).toHaveBeenCalledWith(
            expect.objectContaining({ status: WorkspaceUserStatus.INVITED }),
            expect.anything()
        )
    })

    it.each([WorkspaceUserStatus.ACTIVE, WorkspaceUserStatus.DISABLE])(
        'rejects an administrator changing another user invitation to %s',
        async (requestedStatus) => {
            const { service, queryRunner } = makeHarness(customRole)
            ;(service as any).readWorkspaceUserByWorkspaceIdUserId.mockResolvedValue({
                workspace,
                workspaceUser: {
                    workspaceId: workspace.id,
                    userId: 'target-user',
                    roleId: customRole.id,
                    role: customRole,
                    status: WorkspaceUserStatus.INVITED,
                    createdBy: 'actor-user'
                } as WorkspaceUser
            })

            await expect(
                service.updateWorkspaceUser(
                    {
                        workspaceId: workspace.id,
                        userId: 'target-user',
                        status: requestedStatus,
                        updatedBy: 'actor-user'
                    },
                    queryRunner
                )
            ).rejects.toThrow('Forbidden')

            expect(queryRunner.manager.save).not.toHaveBeenCalled()
        }
    )

    it('rejects invalid empty workspace membership status before any write', async () => {
        const { service, queryRunner } = makeHarness(customRole)
        ;(service as any).readWorkspaceUserByWorkspaceIdUserId.mockResolvedValue({
            workspace,
            workspaceUser: {
                workspaceId: workspace.id,
                userId: 'target-user',
                roleId: customRole.id,
                role: customRole,
                status: WorkspaceUserStatus.INVITED,
                createdBy: 'actor-user'
            } as WorkspaceUser
        })

        await expect(
            service.updateWorkspaceUser(
                {
                    workspaceId: workspace.id,
                    userId: 'target-user',
                    status: '',
                    updatedBy: 'actor-user'
                },
                queryRunner
            )
        ).rejects.toEqual(expect.objectContaining({ statusCode: 400 }))

        expect(queryRunner.manager.save).not.toHaveBeenCalled()
    })
})
