import { IdentityManager } from '../../IdentityManager'
import { OrganizationUserStatus } from '../database/entities/organization-user.entity'
import { GeneralRole } from '../database/entities/role.entity'
import { WorkspaceUser, WorkspaceUserStatus } from '../database/entities/workspace-user.entity'
import { buildLoggedInUser, LoggedInUserBuilderDependencies } from './loggedInUserBuilder'

const user = {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'owner@fixture.invalid',
    name: 'Fixture Owner'
}

const workspaceUser = {
    userId: user.id,
    workspaceId: '00000000-0000-4000-8000-000000000002',
    roleId: '00000000-0000-4000-8000-000000000003',
    status: WorkspaceUserStatus.ACTIVE,
    workspace: {
        id: '00000000-0000-4000-8000-000000000002',
        name: 'Fixture Workspace',
        organizationId: '00000000-0000-4000-8000-000000000004'
    },
    role: { name: GeneralRole.OWNER }
} as WorkspaceUser

const organizationUser = {
    userId: user.id,
    organizationId: workspaceUser.workspace.organizationId,
    status: OrganizationUserStatus.ACTIVE
}

function createHarness() {
    const updateWorkspaceUser = jest.fn().mockResolvedValue(undefined)
    const updateOrganizationUser = jest.fn().mockResolvedValue(undefined)
    const dependencies: LoggedInUserBuilderDependencies = {
        workspaceUserService: {
            updateWorkspaceUser,
            readWorkspaceUserByUserId: jest.fn().mockResolvedValue([workspaceUser])
        },
        organizationUserService: {
            readOrganizationUserByWorkspaceIdUserId: jest.fn().mockResolvedValue({ organizationUser }),
            updateOrganizationUser
        },
        roleService: {
            readGeneralRoleByName: jest.fn().mockResolvedValue({ id: workspaceUser.roleId }),
            readRoleById: jest.fn().mockResolvedValue({ id: workspaceUser.roleId, permissions: '["chatflows:manage"]' })
        },
        organizationService: {
            readOrganizationById: jest.fn().mockResolvedValue({
                id: organizationUser.organizationId,
                subscriptionId: 'subscription-fixture',
                customerId: 'customer-fixture'
            })
        }
    }
    const identityManager = {
        getFeaturesByPlan: jest.fn().mockResolvedValue({ workspaces: '1' }),
        getProductIdFromSubscription: jest.fn().mockResolvedValue('product-fixture')
    } as unknown as IdentityManager

    return { dependencies, identityManager, updateWorkspaceUser, updateOrganizationUser }
}

describe('buildLoggedInUser', () => {
    it('preserves the existing user shape and login-state updates for password login', async () => {
        const harness = createHarness()
        const mutableWorkspaceUser = { ...workspaceUser, status: WorkspaceUserStatus.DISABLE } as WorkspaceUser

        const result = await buildLoggedInUser(
            {
                user,
                workspaceUser: mutableWorkspaceUser,
                queryRunner: {} as never,
                identityManager: harness.identityManager,
                mode: 'password-login'
            },
            harness.dependencies
        )

        expect(result).toEqual({
            id: user.id,
            email: user.email,
            name: user.name,
            roleId: workspaceUser.roleId,
            activeOrganizationId: organizationUser.organizationId,
            activeOrganizationSubscriptionId: 'subscription-fixture',
            activeOrganizationCustomerId: 'customer-fixture',
            activeOrganizationProductId: 'product-fixture',
            isOrganizationAdmin: true,
            activeWorkspaceId: workspaceUser.workspaceId,
            activeWorkspace: workspaceUser.workspace.name,
            assignedWorkspaces: [
                {
                    id: workspaceUser.workspace.id,
                    name: workspaceUser.workspace.name,
                    role: GeneralRole.OWNER,
                    organizationId: workspaceUser.workspace.organizationId
                }
            ],
            permissions: ['chatflows:manage'],
            features: { workspaces: '1' }
        })
        expect(harness.updateWorkspaceUser).toHaveBeenCalledTimes(1)
        expect(harness.updateOrganizationUser).toHaveBeenCalledTimes(1)
    })

    it.each(['workspace', 'organization'] as const)('rejects inactive %s membership without activating it', async (membership) => {
        const harness = createHarness()
        const candidateWorkspaceUser = {
            ...workspaceUser,
            status: membership === 'workspace' ? WorkspaceUserStatus.DISABLE : WorkspaceUserStatus.ACTIVE
        } as WorkspaceUser
        if (membership === 'organization') {
            ;(harness.dependencies.organizationUserService!.readOrganizationUserByWorkspaceIdUserId as jest.Mock).mockResolvedValue({
                organizationUser: { ...organizationUser, status: OrganizationUserStatus.DISABLE }
            })
        }

        await expect(
            buildLoggedInUser(
                {
                    user,
                    workspaceUser: candidateWorkspaceUser,
                    queryRunner: {} as never,
                    identityManager: harness.identityManager,
                    mode: 'acceptance-login'
                },
                harness.dependencies
            )
        ).rejects.toThrow('Inactive acceptance membership')

        expect(harness.updateWorkspaceUser).not.toHaveBeenCalled()
        expect(harness.updateOrganizationUser).not.toHaveBeenCalled()
    })

    it('does not mutate active memberships during acceptance login', async () => {
        const harness = createHarness()

        await expect(
            buildLoggedInUser(
                {
                    user,
                    workspaceUser: { ...workspaceUser } as WorkspaceUser,
                    queryRunner: {} as never,
                    identityManager: harness.identityManager,
                    mode: 'acceptance-login'
                },
                harness.dependencies
            )
        ).resolves.toMatchObject({ id: user.id, activeWorkspaceId: workspaceUser.workspaceId })

        expect(harness.updateWorkspaceUser).not.toHaveBeenCalled()
        expect(harness.updateOrganizationUser).not.toHaveBeenCalled()
    })
})
