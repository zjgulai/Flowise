const mockSetTokenOrCookies = jest.fn()

jest.mock('../middleware/passport/tokenResponse', () => ({
    setTokenOrCookies: mockSetTokenOrCookies
}))

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: jest.fn()
}))

jest.mock('../../utils/constants', () => ({
    GeneralErrorMessage: {
        UNAUTHORIZED: 'Unauthorized',
        UNHANDLED_EDGE_CASE: 'Unhandled Edge Case'
    }
}))

import { OrganizationUserStatus } from '../database/entities/organization-user.entity'
import { WorkspaceUserStatus } from '../database/entities/workspace-user.entity'
import { assertWorkspaceSwitchMembershipActive, persistWorkspaceSwitch } from './workspace.controller'

describe('workspace switch membership boundary', () => {
    it('accepts only memberships that are already active in both scopes', () => {
        expect(() =>
            assertWorkspaceSwitchMembershipActive({ status: WorkspaceUserStatus.ACTIVE }, { status: OrganizationUserStatus.ACTIVE })
        ).not.toThrow()
    })

    it.each([
        [WorkspaceUserStatus.INVITED, OrganizationUserStatus.ACTIVE],
        [WorkspaceUserStatus.DISABLE, OrganizationUserStatus.ACTIVE],
        [WorkspaceUserStatus.ACTIVE, OrganizationUserStatus.INVITED],
        [WorkspaceUserStatus.ACTIVE, OrganizationUserStatus.DISABLE]
    ])('rejects inactive memberships without self-activating them (%s / %s)', (workspaceStatus, organizationStatus) => {
        const workspaceMembership = { status: workspaceStatus }
        const organizationMembership = { status: organizationStatus }

        expect(() => assertWorkspaceSwitchMembershipActive(workspaceMembership, organizationMembership)).toThrow(
            expect.objectContaining({ statusCode: 403 })
        )
        expect(workspaceMembership.status).toBe(workspaceStatus)
        expect(organizationMembership.status).toBe(organizationStatus)
        expect(mockSetTokenOrCookies).not.toHaveBeenCalled()
    })
})

describe('workspace switch authentication rotation', () => {
    beforeEach(() => jest.clearAllMocks())

    it('persists the switched Passport user before rotating both auth cookies', async () => {
        const save = jest.fn((callback: (error?: unknown) => void) => callback())
        const req = {
            user: { id: 'user-1', activeWorkspaceId: 'workspace-a' },
            session: { passport: { user: { id: 'user-1', activeWorkspaceId: 'workspace-a' } }, save }
        } as any
        const res = {} as any
        const switchedUser = {
            ...req.user,
            activeWorkspaceId: 'workspace-b',
            activeOrganizationId: 'organization-1',
            isOrganizationAdmin: true,
            permissions: ['chatflows:view'],
            role: 'Owner',
            roleId: 'role-1',
            isSSO: false
        } as any

        await persistWorkspaceSwitch(req, res, switchedUser)

        expect(save).toHaveBeenCalledTimes(1)
        expect(req.session.passport.user.activeWorkspaceId).toBe('workspace-b')
        expect(mockSetTokenOrCookies).toHaveBeenCalledWith(res, switchedUser, true, req, false, false)
        expect(save.mock.invocationCallOrder[0]).toBeLessThan(mockSetTokenOrCookies.mock.invocationCallOrder[0])
    })

    it('does not issue workspace-bound tokens when session persistence fails', async () => {
        const req = {
            user: { id: 'user-1', activeWorkspaceId: 'workspace-a' },
            session: {
                passport: { user: { id: 'user-1', activeWorkspaceId: 'workspace-a' } },
                save: (callback: (error?: unknown) => void) => callback(new Error('store unavailable'))
            }
        } as any

        await expect(
            persistWorkspaceSwitch(
                req,
                {} as any,
                {
                    ...req.user,
                    activeWorkspaceId: 'workspace-b',
                    role: 'Owner',
                    isSSO: false
                } as any
            )
        ).rejects.toThrow('store unavailable')
        expect(mockSetTokenOrCookies).not.toHaveBeenCalled()
    })
})
