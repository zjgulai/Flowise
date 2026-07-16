const mockDestroyAllSessionsForUser = jest.fn()
const mockValidatePasswordOrThrow = jest.fn()
const mockIsEmailChangeJwtShape = jest.fn().mockReturnValue(false)

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

jest.mock('../utils/emailChangeJwt.util', () => ({
    EMAIL_CHANGE_JWT_TYP: 'email-change',
    isEmailChangeJwtShape: mockIsEmailChangeJwtShape,
    signEmailChangeJwt: jest.fn(),
    verifyEmailChangeJwt: jest.fn()
}))

jest.mock('../utils/sendEmail', () => ({
    isSmtpConfigured: jest.fn().mockReturnValue(false),
    sendEmailChangeConfirmationEmail: jest.fn(),
    sendPasswordResetEmail: jest.fn(),
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
import { AccountDTO, AccountService } from './account.service'

type FailurePoint = 'save' | 'commit'

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

const createHarness = (failurePoint?: FailurePoint) => {
    const events: string[] = []
    let transactionActive = false
    let released = false

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
    const storedUser = {
        id: userId,
        email: 'account@example.invalid',
        credential: 'stored-derived-value',
        tempToken: 'synthetic-reset-value',
        tokenExpiry: new Date(Date.now() + 60_000),
        status: UserStatus.ACTIVE
    } as User
    const userService = {
        readUserByEmail: jest.fn().mockResolvedValue(storedUser),
        saveUser: jest.fn().mockImplementation(async (user) => {
            events.push('save')
            if (failurePoint === 'save') throw new Error('save-failure')
            return user
        })
    }

    const service = Object.create(AccountService.prototype) as AccountService
    ;(service as any).dataSource = dataSource
    ;(service as any).userService = userService

    return { service, queryRunner, userService, events }
}

describe('AccountService.resetPassword session revocation ordering', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockIsEmailChangeJwtShape.mockReturnValue(false)
    })

    it('does not start or persist a reset transaction when session revocation fails', async () => {
        const { service, queryRunner, userService } = createHarness()
        const revocationError = new Error('revocation-failure')
        mockDestroyAllSessionsForUser.mockRejectedValue(revocationError)

        await expect(service.resetPassword(resetRequest())).rejects.toBe(revocationError)

        expect(queryRunner.startTransaction).not.toHaveBeenCalled()
        expect(userService.saveUser).not.toHaveBeenCalled()
        expect(queryRunner.commitTransaction).not.toHaveBeenCalled()
        expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled()
        expect(queryRunner.release).toHaveBeenCalledTimes(1)
    })

    it('revokes sessions before starting and committing a reset transaction', async () => {
        const { service, events } = createHarness()
        mockDestroyAllSessionsForUser.mockImplementation(async () => {
            events.push('revoke')
        })

        await expect(service.resetPassword(resetRequest())).resolves.toEqual({ message: 'success' })

        expect(events).toEqual(['revoke', 'start', 'save', 'commit', 'release'])
        expect(mockDestroyAllSessionsForUser).toHaveBeenCalledWith(userId)
    })

    it.each(['save', 'commit'] as FailurePoint[])('revokes once and rolls back when %s fails', async (failurePoint) => {
        const { service, queryRunner, events } = createHarness(failurePoint)
        mockDestroyAllSessionsForUser.mockImplementation(async () => {
            events.push('revoke')
        })

        await expect(service.resetPassword(resetRequest())).rejects.toThrow(`${failurePoint}-failure`)

        expect(mockDestroyAllSessionsForUser).toHaveBeenCalledTimes(1)
        expect(events[0]).toBe('revoke')
        expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1)
        expect(queryRunner.release).toHaveBeenCalledTimes(1)
    })
})
