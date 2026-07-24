const mockDestroyAllSessionsForUser = jest.fn()
const mockValidatePasswordOrThrow = jest.fn()
const mockIsEmailChangeJwtShape = jest.fn().mockReturnValue(false)
const mockCompareHash = jest.fn()
const mockRecordLoginActivity = jest.fn()
const mockHashNeedsUpgrade = jest.fn().mockReturnValue(false)
const mockSendPasswordResetEmail = jest.fn()

jest.mock('bcryptjs', () => ({
    __esModule: true,
    default: {
        genSaltSync: jest.fn().mockReturnValue('synthetic-salt'),
        hashSync: jest.fn().mockReturnValue('replacement-derived-value')
    }
}))

jest.mock('flowise-components', () => ({
    removeFolderFromStorage: jest.fn()
}))

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: jest.fn()
}))

jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: {
        error: jest.fn(),
        warn: jest.fn()
    }
}))

jest.mock('../middleware/passport/SessionPersistance', () => ({
    destroyAllSessionsForUser: mockDestroyAllSessionsForUser
}))

jest.mock('../utils/validation.util', () => ({
    validatePasswordOrThrow: mockValidatePasswordOrThrow
}))

jest.mock('../utils/encryption.util', () => ({
    compareHash: mockCompareHash,
    getHash: jest.fn().mockReturnValue('replacement-derived-value'),
    getPasswordSaltRounds: jest.fn().mockReturnValue(10),
    hashNeedsUpgrade: mockHashNeedsUpgrade
}))

jest.mock('./audit', () => ({
    __esModule: true,
    default: {
        recordLoginActivity: mockRecordLoginActivity
    }
}))

jest.mock('../utils/emailChangeJwt.util', () => ({
    EMAIL_CHANGE_JWT_TYP: 'email-change',
    isEmailChangeJwtShape: mockIsEmailChangeJwtShape,
    signEmailChangeJwt: jest.fn(),
    verifyEmailChangeJwt: jest.fn()
}))

jest.mock('../utils/sendEmail', () => ({
    isSmtpConfigured: jest.fn().mockReturnValue(false),
    sendEmailChangeConfirmationEmail: jest.fn(),
    sendPasswordResetEmail: mockSendPasswordResetEmail,
    sendVerificationEmailForCloud: jest.fn(),
    sendWorkspaceAdd: jest.fn(),
    sendWorkspaceInvite: jest.fn()
}))

jest.mock('../utils/authSecrets', () => ({
    getJWTAuthTokenSecret: jest.fn().mockReturnValue('synthetic-auth-key')
}))

jest.mock('../../utils/sanitize.util', () => ({
    sanitizeUser: jest.fn().mockImplementation((user) => user)
}))

jest.mock('../../utils/quotaUsage', () => ({
    checkUsageLimit: jest.fn()
}))

jest.mock('../../utils/telemetry', () => ({
    emitEvent: jest.fn(),
    TelemetryEventCategory: { AUDIT: 'audit' },
    TelemetryEventResult: { SUCCESS: 'success' }
}))

import { User, UserStatus } from '../database/entities/user.entity'
import { OrganizationUserStatus } from '../database/entities/organization-user.entity'
import { WorkspaceUserStatus } from '../database/entities/workspace-user.entity'
import { Platform } from '../../Interface'
import {
    AccountDTO,
    AccountService,
    bindInviteToActiveTenant,
    getPasswordRecoveryResponseDelay,
    getWorkspaceMembershipStatusForInvite
} from './account.service'

type FailurePoint = 'update' | 'commit'

const userId = '00000000-0000-4000-8000-000000000002'

const resetRequest = (): AccountDTO =>
    ({
        user: {
            email: 'account@example.invalid',
            tempToken: 'synthetic-reset-value',
            password: 'replacement-value'
        },
        organization: {},
        organizationUser: {},
        workspace: {},
        workspaceUser: {},
        role: {}
    } as unknown as AccountDTO)

const inviteRequest = (): AccountDTO =>
    ({
        user: {
            email: 'invitee@example.invalid',
            createdBy: 'forged-user',
            updatedBy: 'forged-user',
            credential: 'forged-credential',
            status: UserStatus.ACTIVE
        },
        organization: { id: 'forged-organization' },
        organizationUser: { createdBy: 'forged-user', updatedBy: 'forged-user' },
        workspace: { id: 'workspace-active', organizationId: 'forged-organization' },
        workspaceUser: { createdBy: 'forged-user', updatedBy: 'forged-user' },
        role: { id: 'role-member' }
    } as unknown as AccountDTO)

const inviteActor = (overrides: Record<string, unknown> = {}) =>
    ({
        id: 'actor-1',
        activeOrganizationId: 'organization-1',
        activeOrganizationSubscriptionId: 'subscription-1',
        activeWorkspaceId: 'workspace-active',
        isOrganizationAdmin: false,
        permissions: ['workspace:add-user', 'workspace:view'],
        ...overrides
    } as any)

describe('AccountService invite tenant boundary', () => {
    const workspace = {
        id: 'workspace-active',
        name: 'Active workspace',
        organizationId: 'organization-1',
        createdBy: 'original-creator'
    } as any
    const role = {
        id: 'role-member',
        organizationId: 'organization-1',
        permissions: JSON.stringify(['workspace:view'])
    } as any

    const createInviteHarness = (storedWorkspace = workspace) => {
        const queryRunner = {
            connect: jest.fn().mockResolvedValue(undefined),
            release: jest.fn().mockResolvedValue(undefined),
            isTransactionActive: false,
            isReleased: false
        }
        const workspaceService = { readWorkspaceById: jest.fn().mockResolvedValue(storedWorkspace) }
        const roleService = { readRoleByRoleIdOrganizationId: jest.fn().mockResolvedValue(role) }
        const organizationUserService = { readOrgUsersCountByOrgId: jest.fn() }
        const userService = { readUserByEmail: jest.fn() }
        const service = Object.create(AccountService.prototype) as AccountService
        ;(service as any).dataSource = { createQueryRunner: jest.fn().mockReturnValue(queryRunner) }
        ;(service as any).workspaceService = workspaceService
        ;(service as any).roleService = roleService
        ;(service as any).organizationUserService = organizationUserService
        ;(service as any).userService = userService
        return { service, queryRunner, workspaceService, roleService, organizationUserService, userService }
    }

    it('binds tenant and audit fields to the authenticated actor and drops forged user fields', () => {
        const data = inviteRequest()

        bindInviteToActiveTenant(data, inviteActor(), workspace, role)

        expect(data.user).toEqual({
            email: 'invitee@example.invalid',
            createdBy: 'actor-1',
            updatedBy: 'actor-1'
        })
        expect(data.organization).toEqual({ id: 'organization-1' })
        expect(data.workspace).toMatchObject({
            id: 'workspace-active',
            organizationId: 'organization-1',
            createdBy: 'original-creator',
            updatedBy: 'actor-1'
        })
        expect(data.organizationUser).toEqual({ createdBy: 'actor-1', updatedBy: 'actor-1' })
        expect(data.workspaceUser).toEqual({ createdBy: 'actor-1', updatedBy: 'actor-1' })
        expect(data.role).toBe(role)
    })

    it('rejects a workspace outside the active organization', () => {
        expect(() =>
            bindInviteToActiveTenant(inviteRequest(), inviteActor(), { ...workspace, organizationId: 'organization-2' }, role)
        ).toThrow(expect.objectContaining({ statusCode: 403 }))
    })

    it('fails a cross-tenant invite before any user or quota mutation service is reached', async () => {
        const harness = createInviteHarness({ ...workspace, organizationId: 'organization-2' })

        await expect(harness.service.invite(inviteRequest(), inviteActor())).rejects.toMatchObject({ statusCode: 403 })

        expect(harness.roleService.readRoleByRoleIdOrganizationId).toHaveBeenCalledWith(
            'role-member',
            'organization-1',
            harness.queryRunner
        )
        expect(harness.organizationUserService.readOrgUsersCountByOrgId).not.toHaveBeenCalled()
        expect(harness.userService.readUserByEmail).not.toHaveBeenCalled()
        expect(harness.queryRunner.release).toHaveBeenCalledTimes(1)
    })

    it('rejects an invite without an authenticated actor before tenant lookup', async () => {
        const harness = createInviteHarness()

        await expect(harness.service.invite(inviteRequest(), undefined)).rejects.toMatchObject({ statusCode: 401 })

        expect(harness.workspaceService.readWorkspaceById).not.toHaveBeenCalled()
        expect(harness.roleService.readRoleByRoleIdOrganizationId).not.toHaveBeenCalled()
        expect(harness.userService.readUserByEmail).not.toHaveBeenCalled()
        expect(harness.queryRunner.release).toHaveBeenCalledTimes(1)
    })

    it('rejects a role outside the active organization', () => {
        expect(() =>
            bindInviteToActiveTenant(inviteRequest(), inviteActor(), workspace, { ...role, organizationId: 'organization-2' })
        ).toThrow(expect.objectContaining({ statusCode: 403 }))
    })

    it('does not let a workspace manager assign permissions they do not hold', () => {
        expect(() =>
            bindInviteToActiveTenant(inviteRequest(), inviteActor(), workspace, {
                ...role,
                permissions: JSON.stringify(['roles:manage'])
            })
        ).toThrow(expect.objectContaining({ statusCode: 403 }))
    })

    it('does not apply an active-workspace permission to another workspace', () => {
        expect(() => bindInviteToActiveTenant(inviteRequest(), inviteActor(), { ...workspace, id: 'workspace-other' }, role)).toThrow(
            expect.objectContaining({ statusCode: 403 })
        )
    })

    it('creates an active workspace membership only for an already-active organization member', () => {
        expect(getWorkspaceMembershipStatusForInvite(OrganizationUserStatus.ACTIVE)).toBe(WorkspaceUserStatus.ACTIVE)
        expect(getWorkspaceMembershipStatusForInvite(OrganizationUserStatus.INVITED)).toBe(WorkspaceUserStatus.INVITED)
        expect(getWorkspaceMembershipStatusForInvite(OrganizationUserStatus.DISABLE)).toBe(WorkspaceUserStatus.INVITED)
    })
})

const createHarness = (failurePoint?: FailurePoint, storedStatus: UserStatus = UserStatus.ACTIVE) => {
    const events: string[] = []
    let transactionActive = false
    let released = false
    const storedUser = {
        id: userId,
        email: 'account@example.invalid',
        credential: 'stored-derived-value',
        tempToken: 'synthetic-reset-value',
        tokenExpiry: new Date(Date.now() + 60_000),
        status: storedStatus
    } as User

    const queryRunner = {
        connect: jest.fn().mockResolvedValue(undefined),
        startTransaction: jest.fn().mockImplementation(async () => {
            events.push('start')
            transactionActive = true
        }),
        commitTransaction: jest.fn().mockImplementation(async () => {
            events.push('commit')
            if (failurePoint === 'commit') throw new Error('commit-failure')
            transactionActive = false
        }),
        rollbackTransaction: jest.fn().mockImplementation(async () => {
            events.push('rollback')
            transactionActive = false
        }),
        manager: {
            update: jest.fn().mockImplementation(async (_entity, _criteria, update) => {
                events.push('update')
                if (failurePoint === 'update') throw new Error('update-failure')
                Object.assign(storedUser, update)
                return { affected: 1 }
            })
        },
        release: jest.fn().mockImplementation(async () => {
            events.push('release')
            released = true
        })
    }

    Object.defineProperties(queryRunner, {
        isTransactionActive: { get: () => transactionActive },
        isReleased: { get: () => released }
    })

    const dataSource = {
        createQueryRunner: jest.fn().mockReturnValue(queryRunner)
    }
    const userService = {
        readUserByEmail: jest.fn().mockResolvedValue(storedUser)
    }

    const service = Object.create(AccountService.prototype) as AccountService
    ;(service as any).dataSource = dataSource
    ;(service as any).userService = userService

    return { service, queryRunner, userService, storedUser, events }
}

describe('AccountService.resetPassword session revocation ordering', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockIsEmailChangeJwtShape.mockReturnValue(false)
    })

    it('keeps the committed replacement credential when post-commit session cleanup fails', async () => {
        const { service, queryRunner } = createHarness()
        const revocationError = new Error('revocation-failure')
        mockDestroyAllSessionsForUser.mockRejectedValue(revocationError)

        await expect(service.resetPassword(resetRequest())).rejects.toBe(revocationError)

        expect(queryRunner.startTransaction).toHaveBeenCalledTimes(1)
        expect(queryRunner.manager.update).toHaveBeenCalledTimes(1)
        expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1)
        expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled()
        expect(queryRunner.release).toHaveBeenCalledTimes(1)
    })

    it('commits the replacement credential before revoking sessions', async () => {
        const { service, queryRunner, events } = createHarness()
        mockDestroyAllSessionsForUser.mockImplementation(async () => {
            events.push('revoke')
        })

        await expect(service.resetPassword(resetRequest())).resolves.toEqual({ message: 'success' })

        expect(events).toEqual(['start', 'update', 'commit', 'revoke', 'release'])
        expect(queryRunner.manager.update).toHaveBeenCalledWith(
            User,
            { id: userId, tempToken: 'synthetic-reset-value' },
            {
                credential: 'replacement-derived-value',
                tempToken: null,
                tokenExpiry: null,
                updatedBy: userId
            }
        )
        expect(mockDestroyAllSessionsForUser).toHaveBeenCalledWith(userId)
    })

    it.each([UserStatus.INVITED, UserStatus.UNVERIFIED])(
        'preserves the %s lifecycle state while replacing the credential',
        async (originalStatus) => {
            const { service, queryRunner, storedUser } = createHarness(undefined, originalStatus)
            mockDestroyAllSessionsForUser.mockResolvedValue(undefined)

            await expect(service.resetPassword(resetRequest())).resolves.toEqual({ message: 'success' })

            expect(queryRunner.manager.update).toHaveBeenCalledWith(
                User,
                { id: userId, tempToken: 'synthetic-reset-value' },
                {
                    credential: 'replacement-derived-value',
                    tempToken: null,
                    tokenExpiry: null,
                    updatedBy: userId
                }
            )
            expect(storedUser.status).toBe(originalStatus)
            expect(mockDestroyAllSessionsForUser).toHaveBeenCalledWith(userId)
        }
    )

    it.each(['update', 'commit'] as FailurePoint[])('does not revoke sessions when %s fails', async (failurePoint) => {
        const { service, queryRunner, events } = createHarness(failurePoint)
        mockDestroyAllSessionsForUser.mockImplementation(async () => {
            events.push('revoke')
        })

        await expect(service.resetPassword(resetRequest())).rejects.toThrow(`${failurePoint}-failure`)

        expect(mockDestroyAllSessionsForUser).not.toHaveBeenCalled()
        expect(events).not.toContain('revoke')
        expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1)
        expect(queryRunner.release).toHaveBeenCalledTimes(1)
    })

    it('allows only one of two concurrent submissions to consume the same reset token', async () => {
        let storedToken: string | null = 'synthetic-reset-value'
        let reads = 0
        let releaseReads!: () => void
        const bothRequestsRead = new Promise<void>((resolve) => {
            releaseReads = resolve
        })

        const queryRunners: any[] = []
        const createQueryRunner = () => {
            let transactionActive = false
            let released = false
            const queryRunner: any = {
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
                release: jest.fn().mockImplementation(async () => {
                    released = true
                }),
                manager: {
                    update: jest.fn().mockImplementation(async (_entity, criteria) => {
                        if (storedToken !== criteria.tempToken) return { affected: 0 }
                        storedToken = null
                        return { affected: 1 }
                    })
                }
            }
            Object.defineProperties(queryRunner, {
                isTransactionActive: { get: () => transactionActive },
                isReleased: { get: () => released }
            })
            queryRunners.push(queryRunner)
            return queryRunner
        }

        const service = Object.create(AccountService.prototype) as AccountService
        ;(service as any).dataSource = { createQueryRunner: jest.fn().mockImplementation(createQueryRunner) }
        ;(service as any).userService = {
            readUserByEmail: jest.fn().mockImplementation(async () => {
                const tokenSnapshot = storedToken
                reads += 1
                if (reads === 2) releaseReads()
                await bothRequestsRead
                return {
                    id: userId,
                    email: 'account@example.invalid',
                    credential: 'stored-derived-value',
                    tempToken: tokenSnapshot,
                    tokenExpiry: new Date(Date.now() + 60_000),
                    status: UserStatus.ACTIVE
                } as User
            })
        }
        mockDestroyAllSessionsForUser.mockResolvedValue(undefined)

        const results = await Promise.allSettled([service.resetPassword(resetRequest()), service.resetPassword(resetRequest())])

        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
        const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
        expect(rejected?.reason).toMatchObject({ statusCode: 400, message: 'Invalid Temporary Token' })
        expect(mockDestroyAllSessionsForUser).toHaveBeenCalledTimes(1)
        expect(queryRunners).toHaveLength(2)
        expect(queryRunners.every((runner) => runner.release.mock.calls.length === 1)).toBe(true)
    })
})

describe('AccountService.login synthetic credential boundary', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockHashNeedsUpgrade.mockReturnValue(false)
    })

    it('uses the same public error and performs a synthetic password comparison for an unknown email', async () => {
        const queryRunner = {
            connect: jest.fn().mockResolvedValue(undefined),
            release: jest.fn().mockResolvedValue(undefined)
        }
        const service = Object.create(AccountService.prototype) as AccountService
        ;(service as any).dataSource = { createQueryRunner: jest.fn().mockReturnValue(queryRunner) }
        ;(service as any).identityManager = { getPlatformType: jest.fn().mockReturnValue(Platform.OPEN_SOURCE) }
        ;(service as any).userService = { readUserByEmail: jest.fn().mockResolvedValue(null) }

        mockCompareHash.mockReturnValue(false)

        await expect(
            service.login({ user: { email: 'missing@example.invalid', credential: 'fixed-test-password' } } as unknown as AccountDTO)
        ).rejects.toMatchObject({ statusCode: 401, message: 'Incorrect Email or Password' })
        expect(mockCompareHash).toHaveBeenCalledWith('fixed-test-password', expect.stringMatching(/^\$2a\$10\$/))
        expect(queryRunner.release).toHaveBeenCalledTimes(1)
    })

    it('rejects a credential-null synthetic user before password comparison or workspace lookup', async () => {
        const queryRunner = {
            connect: jest.fn().mockResolvedValue(undefined),
            release: jest.fn().mockResolvedValue(undefined)
        }
        const dataSource = {
            createQueryRunner: jest.fn().mockReturnValue(queryRunner)
        }
        const userService = {
            readUserByEmail: jest.fn().mockResolvedValue({
                id: userId,
                email: 'flowise-acceptance+run-01@acceptance.invalid',
                credential: null,
                status: UserStatus.ACTIVE
            })
        }
        const workspaceUserService = {
            readWorkspaceUserByLastLogin: jest.fn()
        }
        const identityManager = {
            getPlatformType: jest.fn().mockReturnValue(Platform.OPEN_SOURCE)
        }

        const service = Object.create(AccountService.prototype) as AccountService
        ;(service as any).dataSource = dataSource
        ;(service as any).identityManager = identityManager
        ;(service as any).userService = userService
        ;(service as any).workspaceUserService = workspaceUserService

        const request = {
            user: {
                email: 'flowise-acceptance+run-01@acceptance.invalid',
                credential: 'fixed-test-password'
            }
        } as unknown as AccountDTO

        await expect(service.login(request)).rejects.toMatchObject({ statusCode: 401, message: 'Incorrect Email or Password' })

        expect(mockRecordLoginActivity).toHaveBeenCalledTimes(1)
        expect(mockCompareHash).toHaveBeenCalledTimes(1)
        expect(workspaceUserService.readWorkspaceUserByLastLogin).not.toHaveBeenCalled()
        expect(queryRunner.release).toHaveBeenCalledTimes(1)
    })

    it('rejects a non-owner before password-hash upgrade or any membership write', async () => {
        const queryRunner = {
            connect: jest.fn().mockResolvedValue(undefined),
            release: jest.fn().mockResolvedValue(undefined)
        }
        const dataSource = { createQueryRunner: jest.fn().mockReturnValue(queryRunner) }
        const storedUser = {
            id: userId,
            email: 'member@example.invalid',
            name: 'Member',
            credential: 'stored-derived-value',
            status: UserStatus.ACTIVE
        } as User
        const userService = {
            readUserByEmail: jest.fn().mockResolvedValue(storedUser),
            saveUser: jest.fn()
        }
        const workspaceUser = {
            userId,
            workspaceId: '00000000-0000-4000-8000-000000000010',
            roleId: '00000000-0000-4000-8000-000000000011',
            status: 'active'
        }
        const workspaceUserService = { readWorkspaceUserByLastLogin: jest.fn().mockResolvedValue(workspaceUser) }
        const organizationUserService = {
            readOrganizationUserByWorkspaceIdUserId: jest.fn().mockResolvedValue({
                organizationUser: { userId, organizationId: '00000000-0000-4000-8000-000000000012', status: 'active' }
            })
        }
        const roleService = {
            readGeneralRoleByName: jest.fn().mockResolvedValue({ id: '00000000-0000-4000-8000-000000000099' })
        }
        const identityManager = { getPlatformType: jest.fn().mockReturnValue(Platform.OPEN_SOURCE) }

        const service = Object.create(AccountService.prototype) as AccountService
        ;(service as any).dataSource = dataSource
        ;(service as any).identityManager = identityManager
        ;(service as any).userService = userService
        ;(service as any).workspaceUserService = workspaceUserService
        ;(service as any).organizationUserService = organizationUserService
        ;(service as any).roleService = roleService

        mockCompareHash.mockReturnValue(true)
        mockHashNeedsUpgrade.mockReturnValue(true)

        await expect(
            service.login({ user: { email: storedUser.email, credential: 'fixed-test-password' } } as unknown as AccountDTO)
        ).rejects.toMatchObject({ statusCode: 401, message: 'Invalid administrator credentials' })

        expect(userService.saveUser).not.toHaveBeenCalled()
        expect(queryRunner.release).toHaveBeenCalledTimes(1)
    })

    it('does not swallow an authentication failure after a password-rehash CAS loses a credential race', async () => {
        const previousAdminOnlyMode = process.env.ADMIN_ONLY_MODE
        process.env.ADMIN_ONLY_MODE = 'false'
        try {
            const execute = jest.fn().mockResolvedValue({ affected: 0 })
            const queryBuilder = {
                update: jest.fn().mockReturnThis(),
                set: jest.fn().mockReturnThis(),
                where: jest.fn().mockReturnThis(),
                execute
            }
            const queryRunner = {
                connect: jest.fn().mockResolvedValue(undefined),
                release: jest.fn().mockResolvedValue(undefined),
                manager: { createQueryBuilder: jest.fn().mockReturnValue(queryBuilder) }
            }
            const storedUser = {
                id: userId,
                email: 'admin@example.invalid',
                credential: 'old-derived-value',
                status: UserStatus.ACTIVE
            } as User
            const service = Object.create(AccountService.prototype) as AccountService
            ;(service as any).dataSource = { createQueryRunner: jest.fn().mockReturnValue(queryRunner) }
            ;(service as any).identityManager = { getPlatformType: jest.fn().mockReturnValue(Platform.OPEN_SOURCE) }
            ;(service as any).userService = {
                readUserByEmail: jest.fn().mockResolvedValue(storedUser),
                readUserById: jest.fn().mockResolvedValue({ ...storedUser, credential: 'concurrent-derived-value' })
            }
            ;(service as any).workspaceUserService = {
                readWorkspaceUserByLastLogin: jest.fn().mockResolvedValue({ workspaceId: 'workspace-id' })
            }
            mockCompareHash.mockReturnValueOnce(true).mockReturnValueOnce(false)
            mockHashNeedsUpgrade.mockReturnValue(true)

            await expect(
                service.login({ user: { email: storedUser.email, credential: 'old-password' } } as unknown as AccountDTO)
            ).rejects.toMatchObject({ statusCode: 401, message: 'Incorrect Email or Password' })

            expect(execute).toHaveBeenCalledTimes(1)
            expect((service as any).userService.readUserById).toHaveBeenCalledWith(userId, queryRunner)
            expect(queryRunner.release).toHaveBeenCalledTimes(1)
        } finally {
            if (previousAdminOnlyMode === undefined) delete process.env.ADMIN_ONLY_MODE
            else process.env.ADMIN_ONLY_MODE = previousAdminOnlyMode
        }
    })
})

describe('AccountService.verify one-time token boundary', () => {
    const makeHarness = (affected = 1, tokenExpiry = new Date(Date.now() + 60_000)) => {
        let transactionActive = false
        let released = false
        const queryRunner: any = {
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
            release: jest.fn().mockImplementation(async () => {
                released = true
            }),
            manager: { update: jest.fn().mockResolvedValue({ affected }) }
        }
        Object.defineProperties(queryRunner, {
            isTransactionActive: { get: () => transactionActive },
            isReleased: { get: () => released }
        })
        const storedUser = {
            id: userId,
            email: 'invitee@example.invalid',
            tempToken: 'invite-token',
            tokenExpiry,
            status: UserStatus.INVITED,
            updatedBy: 'inviter-id'
        } as User
        const service = Object.create(AccountService.prototype) as AccountService
        ;(service as any).dataSource = { createQueryRunner: jest.fn().mockReturnValue(queryRunner) }
        ;(service as any).userService = { readUserByToken: jest.fn().mockResolvedValue(storedUser) }
        return { service, queryRunner }
    }

    beforeEach(() => {
        jest.clearAllMocks()
        mockIsEmailChangeJwtShape.mockReturnValue(false)
    })

    it('atomically consumes the expected invitation token', async () => {
        const { service, queryRunner } = makeHarness()

        await expect(service.verify({ user: { tempToken: 'invite-token' } } as unknown as AccountDTO)).resolves.toMatchObject({
            user: { tempToken: null, status: UserStatus.ACTIVE }
        })

        expect(queryRunner.manager.update).toHaveBeenCalledWith(
            User,
            { id: userId, tempToken: 'invite-token' },
            { tempToken: null, tokenExpiry: null, status: UserStatus.ACTIVE, updatedBy: userId }
        )
        expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1)
    })

    it('rejects a replay when the conditional consume affects no row', async () => {
        const { service, queryRunner } = makeHarness(0)

        await expect(service.verify({ user: { tempToken: 'invite-token' } } as unknown as AccountDTO)).rejects.toMatchObject({
            statusCode: 400,
            message: 'Invalid Temporary Token'
        })

        expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1)
    })

    it('rejects an expired invitation before attempting the conditional consume', async () => {
        const { service, queryRunner } = makeHarness(1, new Date(Date.now() - 60_000))

        await expect(service.verify({ user: { tempToken: 'invite-token' } } as unknown as AccountDTO)).rejects.toMatchObject({
            statusCode: 400,
            message: 'Expired Temporary Token'
        })

        expect(queryRunner.manager.update).not.toHaveBeenCalled()
    })
})

describe('AccountService.forgotPassword enumeration boundary', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it('returns the same success response for an unknown email without sending mail', async () => {
        const queryRunner = {
            connect: jest.fn().mockResolvedValue(undefined),
            startTransaction: jest.fn().mockResolvedValue(undefined),
            commitTransaction: jest.fn().mockResolvedValue(undefined),
            rollbackTransaction: jest.fn().mockResolvedValue(undefined),
            release: jest.fn().mockResolvedValue(undefined)
        }
        const service = Object.create(AccountService.prototype) as AccountService
        ;(service as any).dataSource = { createQueryRunner: jest.fn().mockReturnValue(queryRunner) }
        ;(service as any).userService = {
            readUserByEmail: jest.fn().mockResolvedValue(null),
            saveUser: jest.fn()
        }
        ;(service as any).canSendTransactionalEmail = jest.fn().mockReturnValue(true)

        await expect(service.forgotPassword({ user: { email: 'missing@example.invalid' } } as unknown as AccountDTO)).resolves.toEqual({
            message: 'success'
        })
        expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1)
        expect(mockSendPasswordResetEmail).not.toHaveBeenCalled()
        expect((service as any).userService.saveUser).not.toHaveBeenCalled()
    })

    it('issues a token with a narrow update that cannot overwrite a concurrent credential change', async () => {
        const previousAppUrl = process.env.APP_URL
        process.env.APP_URL = 'https://flowise.example.invalid'
        let finishMail: (() => void) | undefined
        mockSendPasswordResetEmail.mockReturnValueOnce(new Promise<void>((resolve) => (finishMail = resolve)))
        const user = {
            id: userId,
            email: 'known@example.invalid',
            credential: 'stale-derived-value',
            status: UserStatus.ACTIVE
        }
        let currentCredential = 'concurrent-derived-value'
        const queryRunner = {
            connect: jest.fn().mockResolvedValue(undefined),
            startTransaction: jest.fn().mockResolvedValue(undefined),
            commitTransaction: jest.fn().mockResolvedValue(undefined),
            rollbackTransaction: jest.fn().mockResolvedValue(undefined),
            release: jest.fn().mockResolvedValue(undefined),
            isTransactionActive: true,
            manager: {
                update: jest.fn().mockImplementation(async (_entity, _criteria, patch) => {
                    expect(patch).not.toHaveProperty('credential')
                    expect(patch).not.toHaveProperty('email')
                    expect(patch).not.toHaveProperty('status')
                    return { affected: 1 }
                })
            }
        }
        const service = Object.create(AccountService.prototype) as AccountService
        ;(service as any).dataSource = { createQueryRunner: jest.fn().mockReturnValue(queryRunner) }
        ;(service as any).userService = {
            readUserByEmail: jest.fn().mockResolvedValue(user),
            saveUser: jest.fn().mockImplementation(async () => {
                currentCredential = user.credential
            })
        }
        ;(service as any).canSendTransactionalEmail = jest.fn().mockReturnValue(true)

        try {
            await expect(service.forgotPassword({ user: { email: user.email } } as unknown as AccountDTO)).resolves.toEqual({
                message: 'success'
            })

            expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1)
            expect(queryRunner.manager.update).toHaveBeenCalledWith(
                User,
                { id: userId },
                {
                    tempToken: expect.any(String),
                    tokenExpiry: expect.any(Date),
                    updatedBy: userId
                }
            )
            expect((service as any).userService.saveUser).not.toHaveBeenCalled()
            expect(currentCredential).toBe('concurrent-derived-value')
            expect(mockSendPasswordResetEmail).toHaveBeenCalledTimes(1)
        } finally {
            finishMail?.()
            if (previousAppUrl === undefined) delete process.env.APP_URL
            else process.env.APP_URL = previousAppUrl
        }
    })

    it('returns the same success response and sends no mail when the narrow update affects no row', async () => {
        const user = { id: userId, email: 'vanished@example.invalid' }
        const queryRunner = {
            connect: jest.fn().mockResolvedValue(undefined),
            startTransaction: jest.fn().mockResolvedValue(undefined),
            commitTransaction: jest.fn().mockResolvedValue(undefined),
            rollbackTransaction: jest.fn().mockResolvedValue(undefined),
            release: jest.fn().mockResolvedValue(undefined),
            isTransactionActive: true,
            manager: { update: jest.fn().mockResolvedValue({ affected: 0 }) }
        }
        const service = Object.create(AccountService.prototype) as AccountService
        ;(service as any).dataSource = { createQueryRunner: jest.fn().mockReturnValue(queryRunner) }
        ;(service as any).userService = { readUserByEmail: jest.fn().mockResolvedValue(user), saveUser: jest.fn() }
        ;(service as any).canSendTransactionalEmail = jest.fn().mockReturnValue(true)

        await expect(service.forgotPassword({ user: { email: user.email } } as unknown as AccountDTO)).resolves.toEqual({
            message: 'success'
        })

        expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1)
        expect((service as any).userService.saveUser).not.toHaveBeenCalled()
        expect(mockSendPasswordResetEmail).not.toHaveBeenCalled()
    })

    it('uses the same minimum public response window regardless of account lookup result', () => {
        expect(getPasswordRecoveryResponseDelay(1_000, 1_100, 0)).toBe(150)
        expect(getPasswordRecoveryResponseDelay(1_000, 1_350, 0)).toBe(0)
    })
})
