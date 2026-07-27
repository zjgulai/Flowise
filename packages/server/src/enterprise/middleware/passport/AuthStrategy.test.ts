import { UserStatus } from '../../database/entities/user.entity'
import { LoggedInUser } from '../../Interface.Enterprise'
import { isTokenBoundToSession, reloadSessionAuthorization } from './AuthStrategy'
import { createCredentialAuthVersion } from './authVersion'

const userId = '00000000-0000-4000-8000-000000000001'
const workspaceId = '00000000-0000-4000-8000-000000000002'

const sessionUser = {
    id: userId,
    email: 'admin@example.invalid',
    name: 'Admin',
    roleId: 'stale-role',
    activeOrganizationId: 'organization-id',
    activeOrganizationSubscriptionId: '',
    activeOrganizationCustomerId: '',
    activeOrganizationProductId: '',
    isOrganizationAdmin: true,
    activeWorkspaceId: workspaceId,
    activeWorkspace: 'Default',
    assignedWorkspaces: [],
    permissions: ['stale:permission'],
    authVersion: 'current-version'
} as LoggedInUser & { authVersion: string }

function createReloadHarness(overrides: Record<string, unknown> = {}) {
    const queryRunner = {
        connect: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
        isReleased: false
    }
    const userService = {
        readUserById: jest.fn().mockResolvedValue({
            id: userId,
            email: sessionUser.email,
            name: sessionUser.name,
            status: UserStatus.ACTIVE,
            credential: 'current-credential'
        })
    }
    const workspaceUserService = {
        readWorkspaceUserByWorkspaceIdUserId: jest.fn().mockResolvedValue({
            workspaceUser: { userId, workspaceId, status: 'active', roleId: 'current-role' }
        })
    }
    const freshUser = {
        ...sessionUser,
        roleId: 'current-role',
        permissions: ['current:permission']
    }
    const buildUser = jest.fn().mockResolvedValue(freshUser)

    return {
        dependencies: {
            dataSource: { createQueryRunner: jest.fn().mockReturnValue(queryRunner) },
            identityManager: {},
            userService,
            workspaceUserService,
            buildUser,
            credentialVersion: (credential: string | undefined) =>
                credential === 'current-credential' ? 'current-version' : 'replacement-version',
            adminOnlyMode: true,
            ...overrides
        } as any,
        queryRunner,
        userService,
        workspaceUserService,
        buildUser,
        freshUser
    }
}

describe('refresh/access token binding', () => {
    it('requires both user and active workspace to match the encrypted token metadata', () => {
        expect(isTokenBoundToSession({ id: userId }, `${userId}:${workspaceId}`, sessionUser)).toBe(true)
        expect(isTokenBoundToSession({ id: 'other-user' }, `${userId}:${workspaceId}`, sessionUser)).toBe(false)
        expect(isTokenBoundToSession({ id: userId }, `${userId}:other-workspace`, sessionUser)).toBe(false)
    })

    it('changes the session generation when the confirmed email changes', () => {
        const before = createCredentialAuthVersion('stored-derived-value', 'old@example.invalid', 'synthetic-secret')
        const after = createCredentialAuthVersion('stored-derived-value', 'new@example.invalid', 'synthetic-secret')

        expect(before).toBeTruthy()
        expect(after).toBeTruthy()
        expect(after).not.toBe(before)
    })
})

describe('reloadSessionAuthorization', () => {
    it('replaces the serialized permission snapshot with current authorization', async () => {
        const harness = createReloadHarness()

        const result = await reloadSessionAuthorization(sessionUser, harness.dependencies)

        expect(result).toEqual(expect.objectContaining({ roleId: 'current-role', permissions: ['current:permission'] }))
        expect(harness.buildUser).toHaveBeenCalledTimes(1)
        expect(harness.queryRunner.release).toHaveBeenCalledTimes(1)
    })

    it('rejects a password session whose credential version changed after login', async () => {
        const harness = createReloadHarness()
        harness.userService.readUserById.mockResolvedValue({
            id: userId,
            email: sessionUser.email,
            name: sessionUser.name,
            status: UserStatus.ACTIVE,
            credential: 'replacement-credential'
        })

        await expect(reloadSessionAuthorization(sessionUser, harness.dependencies)).resolves.toBeUndefined()
        expect(harness.buildUser).not.toHaveBeenCalled()
    })

    it('fails closed for a legacy password session without a credential version', async () => {
        const harness = createReloadHarness()
        const { authVersion: _missing, ...legacySession } = sessionUser

        await expect(reloadSessionAuthorization(legacySession as LoggedInUser, harness.dependencies)).resolves.toBeUndefined()
        expect(harness.buildUser).not.toHaveBeenCalled()
    })

    it('rejects a disabled user before rebuilding permissions', async () => {
        const harness = createReloadHarness()
        harness.userService.readUserById.mockResolvedValue({
            id: userId,
            email: sessionUser.email,
            name: sessionUser.name,
            status: UserStatus.DELETED,
            credential: 'current-credential'
        })

        await expect(reloadSessionAuthorization(sessionUser, harness.dependencies)).resolves.toBeUndefined()
        expect(harness.workspaceUserService.readWorkspaceUserByWorkspaceIdUserId).not.toHaveBeenCalled()
    })

    it('rejects a non-owner when administrator-only mode is active', async () => {
        const harness = createReloadHarness()
        harness.buildUser.mockResolvedValue({ ...harness.freshUser, isOrganizationAdmin: false })

        await expect(reloadSessionAuthorization(sessionUser, harness.dependencies)).resolves.toBeUndefined()
    })
})
