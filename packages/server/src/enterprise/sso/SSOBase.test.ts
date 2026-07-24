import { Application } from 'express'
import { OrganizationUserStatus } from '../database/entities/organization-user.entity'
import { WorkspaceUser, WorkspaceUserStatus } from '../database/entities/workspace-user.entity'

const mockReadUserByEmail = jest.fn()
const mockReadOrganizationMembership = jest.fn()
const mockReadOrganizationWorkspaceUsers = jest.fn()
const mockReadWorkspaceUserByLastLogin = jest.fn()
const mockReadWorkspaceUserByUserId = jest.fn()
const mockReadOrganizationById = jest.fn()
const mockReadOrganizations = jest.fn()
const mockReadOwnerRole = jest.fn()
const mockReadRoleById = jest.fn()
const mockGetFeaturesByPlan = jest.fn()
const mockGetProductIdFromSubscription = jest.fn()
const mockQueryRunner = {
    connect: jest.fn(),
    release: jest.fn(),
    isReleased: false
}

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({
        AppDataSource: {
            createQueryRunner: () => mockQueryRunner
        },
        identityManager: {
            getPlatformType: () => 'enterprise',
            getFeaturesByPlan: mockGetFeaturesByPlan,
            getProductIdFromSubscription: mockGetProductIdFromSubscription
        }
    })
}))

jest.mock('../services/user.service', () => ({
    UserErrorMessage: { USER_NOT_FOUND: 'User Not Found' },
    UserService: jest.fn().mockImplementation(() => ({
        readUserByEmail: mockReadUserByEmail
    }))
}))

jest.mock('../services/organization-user.service', () => ({
    OrganizationUserService: jest.fn().mockImplementation(() => ({
        readOrganizationUserByOrganizationIdUserId: mockReadOrganizationMembership
    }))
}))

jest.mock('../services/workspace-user.service', () => ({
    WorkspaceUserService: jest.fn().mockImplementation(() => ({
        readWorkspaceUserByOrganizationIdUserId: mockReadOrganizationWorkspaceUsers,
        readWorkspaceUserByLastLogin: mockReadWorkspaceUserByLastLogin,
        readWorkspaceUserByUserId: mockReadWorkspaceUserByUserId
    }))
}))

jest.mock('../services/organization.service', () => ({
    OrganizationService: jest.fn().mockImplementation(() => ({
        readOrganizationById: mockReadOrganizationById,
        readOrganization: mockReadOrganizations
    }))
}))

jest.mock('../services/role.service', () => ({
    RoleErrorMessage: { ROLE_NOT_FOUND: 'Role Not Found' },
    RoleService: jest.fn().mockImplementation(() => ({
        readGeneralRoleByName: mockReadOwnerRole,
        readRoleById: mockReadRoleById
    }))
}))

jest.mock('../services/account.service', () => ({
    AccountService: jest.fn()
}))

import SSOBase, { selectActiveWorkspaceUser } from './SSOBase'

class TestSSO extends SSOBase {
    getProviderName(): string {
        return 'Test SSO'
    }

    initialize(): void {}

    async refreshToken(): Promise<{ [key: string]: any }> {
        return {}
    }
}

function workspaceUser(data: Partial<WorkspaceUser>): WorkspaceUser {
    return {
        workspaceId: 'workspace-default',
        userId: 'user-1',
        roleId: 'member-role',
        status: WorkspaceUserStatus.ACTIVE,
        workspace: {
            id: 'workspace-default',
            name: 'Default workspace',
            organizationId: 'org-bound'
        },
        role: { name: 'Member' },
        ...data
    } as WorkspaceUser
}

describe('SSOBase enterprise organization boundary', () => {
    const originalAdminOnlyMode = process.env.ADMIN_ONLY_MODE

    beforeEach(() => {
        jest.clearAllMocks()
        process.env.ADMIN_ONLY_MODE = 'false'
        mockQueryRunner.isReleased = false
        mockReadUserByEmail.mockResolvedValue({ id: 'user-1', email: 'user@example.com', name: 'User', status: 'active' })
        mockReadOrganizationMembership.mockResolvedValue({
            organization: { id: 'org-bound' },
            organizationUser: { organizationId: 'org-bound', userId: 'user-1', roleId: 'org-member', status: OrganizationUserStatus.ACTIVE }
        })
        mockReadOrganizationById.mockResolvedValue({
            id: 'org-bound',
            subscriptionId: 'subscription-1',
            customerId: 'customer-1'
        })
        mockReadOrganizations.mockResolvedValue([{ id: 'org-bound' }])
        mockReadOwnerRole.mockResolvedValue({ id: 'workspace-owner' })
        mockReadRoleById.mockResolvedValue({ id: 'workspace-owner', permissions: '["sso:view"]' })
        mockGetFeaturesByPlan.mockResolvedValue({ sso: true })
        mockGetProductIdFromSubscription.mockResolvedValue('product-1')
    })

    afterAll(() => {
        if (originalAdminOnlyMode === undefined) delete process.env.ADMIN_ONLY_MODE
        else process.env.ADMIN_ONLY_MODE = originalAdminOnlyMode
    })

    it('selects only an ACTIVE workspace inside the configured organization and derives admin status from the organization role', async () => {
        const olderActive = workspaceUser({
            workspaceId: 'workspace-old',
            workspace: { id: 'workspace-old', name: 'Old workspace', organizationId: 'org-bound' },
            lastLogin: '2026-01-01T00:00:00.000Z'
        })
        const newerActive = workspaceUser({
            workspaceId: 'workspace-new',
            roleId: 'workspace-owner',
            role: { id: 'workspace-owner', name: 'Owner', permissions: '["sso:view"]' },
            workspace: { id: 'workspace-new', name: 'New workspace', organizationId: 'org-bound' },
            lastLogin: '2026-02-01T00:00:00.000Z'
        })
        const disabledNewest = workspaceUser({
            workspaceId: 'workspace-disabled',
            status: WorkspaceUserStatus.DISABLE,
            lastLogin: '2026-03-01T00:00:00.000Z'
        })
        mockReadOrganizationWorkspaceUsers.mockResolvedValue([olderActive, disabledNewest, newerActive])
        const done = jest.fn()

        await new TestSSO({} as Application, { organizationId: 'org-bound', configEnabled: true }).verifyAndLogin(
            {} as Application,
            'user@example.com',
            done,
            { displayName: 'User' } as any,
            'access-token',
            'refresh-token'
        )

        expect(mockReadOrganizationMembership).toHaveBeenCalledWith('org-bound', 'user-1', mockQueryRunner)
        expect(mockReadOrganizationWorkspaceUsers).toHaveBeenCalledWith('org-bound', 'user-1', mockQueryRunner)
        expect(mockReadWorkspaceUserByLastLogin).not.toHaveBeenCalled()
        expect(mockReadWorkspaceUserByUserId).not.toHaveBeenCalled()
        expect(done).toHaveBeenCalledWith(
            null,
            expect.objectContaining({
                activeOrganizationId: 'org-bound',
                activeWorkspaceId: 'workspace-new',
                isOrganizationAdmin: false,
                assignedWorkspaces: expect.arrayContaining([
                    expect.objectContaining({ id: 'workspace-old', organizationId: 'org-bound' }),
                    expect.objectContaining({ id: 'workspace-new', organizationId: 'org-bound' })
                ])
            }),
            { message: 'Logged in Successfully' }
        )
        expect(done.mock.calls[0][1].assignedWorkspaces).toHaveLength(2)
        expect(mockQueryRunner.release).toHaveBeenCalledTimes(1)
    })

    it('rejects an inactive organization membership before workspace selection', async () => {
        mockReadOrganizationMembership.mockResolvedValue({
            organization: { id: 'org-bound' },
            organizationUser: {
                organizationId: 'org-bound',
                userId: 'user-1',
                roleId: 'org-member',
                status: OrganizationUserStatus.DISABLE
            }
        })
        const done = jest.fn()

        await new TestSSO({} as Application, { organizationId: 'org-bound', configEnabled: true }).verifyAndLogin(
            {} as Application,
            'user@example.com',
            done,
            {} as any,
            'access-token',
            'refresh-token'
        )

        expect(done).toHaveBeenCalledWith(expect.objectContaining({ name: 'SSO_LOGIN_FAILED' }), undefined)
        expect(mockReadOrganizationWorkspaceUsers).not.toHaveBeenCalled()
    })

    it('rejects a disabled user before organization membership lookup', async () => {
        mockReadUserByEmail.mockResolvedValue({ id: 'user-1', email: 'user@example.com', status: 'disable' })
        const done = jest.fn()

        await new TestSSO({} as Application, { organizationId: 'org-bound', configEnabled: true }).verifyAndLogin(
            {} as Application,
            'user@example.com',
            done,
            {} as any,
            'access-token',
            'refresh-token'
        )

        expect(done).toHaveBeenCalledWith(expect.objectContaining({ name: 'SSO_LOGIN_FAILED' }), undefined)
        expect(mockReadOrganizationMembership).not.toHaveBeenCalled()
    })

    it('rejects when the configured organization has no ACTIVE workspace membership', async () => {
        mockReadOrganizationWorkspaceUsers.mockResolvedValue([
            workspaceUser({ status: WorkspaceUserStatus.DISABLE, lastLogin: '2026-03-01T00:00:00.000Z' })
        ])
        const done = jest.fn()

        await new TestSSO({} as Application, { organizationId: 'org-bound', configEnabled: true }).verifyAndLogin(
            {} as Application,
            'user@example.com',
            done,
            {} as any,
            'access-token',
            'refresh-token'
        )

        expect(done).toHaveBeenCalledWith(expect.objectContaining({ name: 'SSO_LOGIN_FAILED' }), undefined)
        expect(mockReadRoleById).not.toHaveBeenCalled()
    })

    it('rejects an enterprise callback whose provider is not organization-bound', async () => {
        const done = jest.fn()

        await new TestSSO({} as Application, { configEnabled: true }).verifyAndLogin(
            {} as Application,
            'user@example.com',
            done,
            {} as any,
            'access-token',
            'refresh-token'
        )

        expect(done).toHaveBeenCalledWith(expect.objectContaining({ name: 'SSO_LOGIN_FAILED' }), undefined)
        expect(mockReadUserByEmail).not.toHaveBeenCalled()
    })

    it('fails closed immediately if another organization is added while a provider is still registered', async () => {
        mockReadOrganizations.mockResolvedValue([{ id: 'org-bound' }, { id: 'org-other' }])
        const done = jest.fn()

        await new TestSSO({} as Application, { organizationId: 'org-bound', configEnabled: true }).verifyAndLogin(
            {} as Application,
            'user@example.com',
            done,
            {} as any,
            'access-token',
            'refresh-token'
        )

        expect(done).toHaveBeenCalledWith(expect.objectContaining({ name: 'SSO_LOGIN_FAILED' }), undefined)
        expect(mockReadUserByEmail).not.toHaveBeenCalled()
    })

    it('preserves admin-only mode rejection before opening a datastore connection', async () => {
        process.env.ADMIN_ONLY_MODE = 'true'
        const done = jest.fn()

        await new TestSSO({} as Application, { organizationId: 'org-bound', configEnabled: true }).verifyAndLogin(
            {} as Application,
            'user@example.com',
            done,
            {} as any,
            'access-token',
            'refresh-token'
        )

        expect(done).toHaveBeenCalledWith(expect.objectContaining({ name: 'SSO_LOGIN_FAILED' }), undefined)
        expect(mockQueryRunner.connect).not.toHaveBeenCalled()
    })
})

describe('selectActiveWorkspaceUser', () => {
    it('ignores a more recent disabled membership', () => {
        const active = workspaceUser({ lastLogin: '2026-01-01T00:00:00.000Z' })
        const disabled = workspaceUser({ status: WorkspaceUserStatus.DISABLE, lastLogin: '2026-02-01T00:00:00.000Z' })

        expect(selectActiveWorkspaceUser([disabled, active])).toBe(active)
    })
})
