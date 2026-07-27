const mockDestroyAllSessionsForUser = jest.fn()
const mockGetRunningExpressApp = jest.fn()
const mockCompareHash = jest.fn().mockReturnValue(true)

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: mockGetRunningExpressApp
}))

jest.mock('../middleware/passport/SessionPersistance', () => ({
    destroyAllSessionsForUser: mockDestroyAllSessionsForUser
}))

jest.mock('../utils/encryption.util', () => ({
    compareHash: mockCompareHash,
    getHash: jest.fn().mockReturnValue('derived-value')
}))

jest.mock('../utils/validation.util', () => ({
    isInvalidEmail: jest.fn().mockReturnValue(false),
    isInvalidName: jest.fn().mockReturnValue(false),
    isInvalidPassword: jest.fn().mockReturnValue(false),
    isInvalidUUID: jest.fn().mockReturnValue(false)
}))

jest.mock('../../utils/sanitize.util', () => ({
    sanitizeUser: jest.fn().mockImplementation((user) => user)
}))

jest.mock('../../utils/telemetry', () => ({
    Telemetry: jest.fn(),
    TelemetryEventType: {
        USER_CREATED: 'user-created'
    }
}))

import { User } from '../database/entities/user.entity'
import { UserService } from './user.service'

type FailurePoint = 'save' | 'commit'

const userId = '00000000-0000-4000-8000-000000000001'

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
        }),
        manager: {
            merge: jest.fn().mockImplementation((_entity, current, patch) => ({ ...current, ...patch })),
            update: jest.fn().mockImplementation(async () => {
                events.push('update')
                return { affected: 1 }
            }),
            save: jest.fn().mockImplementation(async (_entity, user) => {
                events.push('save')
                if (failurePoint === 'save') throw new Error('save-failure')
                return user
            })
        }
    }

    Object.defineProperties(queryRunner, {
        isTransactionActive: { get: () => transactionActive },
        isReleased: { get: () => released }
    })

    const dataSource = {
        createQueryRunner: jest.fn().mockReturnValue(queryRunner)
    }
    mockGetRunningExpressApp.mockReturnValue({
        AppDataSource: dataSource,
        telemetry: { sendTelemetry: jest.fn() }
    })

    const service = new UserService()
    const oldUser = {
        id: userId,
        email: 'account@example.invalid',
        credential: 'stored-derived-value',
        createdBy: userId,
        updatedBy: userId
    } as User
    jest.spyOn(service, 'readUserById').mockResolvedValue(oldUser)
    jest.spyOn(service, 'encryptUserCredential').mockReturnValue('replacement-derived-value')

    return { service, queryRunner, events }
}

const passwordPatch = () => ({
    id: userId,
    oldPassword: 'previous-value',
    newPassword: 'replacement-value',
    confirmPassword: 'replacement-value'
})

describe('UserService.updateUser session revocation ordering', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockCompareHash.mockReturnValue(true)
    })

    it('keeps the committed replacement credential when post-commit session cleanup fails', async () => {
        const { service, queryRunner } = createHarness()
        const revocationError = new Error('revocation-failure')
        mockDestroyAllSessionsForUser.mockRejectedValue(revocationError)

        await expect(service.updateUser(passwordPatch())).rejects.toBe(revocationError)

        expect(queryRunner.startTransaction).toHaveBeenCalledTimes(1)
        expect(queryRunner.manager.save).toHaveBeenCalledTimes(1)
        expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1)
        expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled()
        expect(queryRunner.release).toHaveBeenCalledTimes(1)
    })

    it('commits the replacement credential before revoking sessions', async () => {
        const { service, events } = createHarness()
        mockDestroyAllSessionsForUser.mockImplementation(async () => {
            events.push('revoke')
        })

        await service.updateUser(passwordPatch())

        expect(events).toEqual(['start', 'save', 'commit', 'revoke', 'release'])
        expect(mockDestroyAllSessionsForUser).toHaveBeenCalledWith(userId)
    })

    it.each(['save', 'commit'] as FailurePoint[])('does not revoke sessions when %s fails', async (failurePoint) => {
        const { service, queryRunner, events } = createHarness(failurePoint)
        mockDestroyAllSessionsForUser.mockImplementation(async () => {
            events.push('revoke')
        })

        await expect(service.updateUser(passwordPatch())).rejects.toThrow(`${failurePoint}-failure`)

        expect(mockDestroyAllSessionsForUser).not.toHaveBeenCalled()
        expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1)
        expect(queryRunner.release).toHaveBeenCalledTimes(1)
    })

    it('does not revoke sessions for a name-only profile update', async () => {
        const { service, events } = createHarness()

        await service.updateUser({ id: userId, name: 'Renamed Account' })

        expect(mockDestroyAllSessionsForUser).not.toHaveBeenCalled()
        expect(events).toEqual(['start', 'save', 'commit', 'release'])
    })
})

describe('UserService.confirmEmailChange', () => {
    beforeEach(() => jest.clearAllMocks())

    it('atomically consumes the expected token, changes the email and revokes sessions', async () => {
        const { service, queryRunner, events } = createHarness()
        jest.spyOn(service, 'readUserById').mockResolvedValue({
            id: userId,
            email: 'old@example.invalid',
            tempToken: 'one-time-token'
        } as User)
        jest.spyOn(service, 'readUserByEmail').mockResolvedValue(null)
        mockDestroyAllSessionsForUser.mockImplementation(async () => events.push('revoke'))
        const onEmailChanged = jest.fn().mockImplementation(async () => events.push('external-sync'))

        await service.confirmEmailChange(userId, 'new@example.invalid', 'one-time-token', onEmailChanged)

        expect(queryRunner.manager.update).toHaveBeenCalledWith(
            User,
            { id: userId, tempToken: 'one-time-token' },
            {
                email: 'new@example.invalid',
                tempToken: null,
                tokenExpiry: null,
                updatedBy: userId
            }
        )
        expect(events).toEqual(['start', 'update', 'commit', 'revoke', 'external-sync', 'release'])
    })

    it('rejects a replay when the conditional token consume affects no row', async () => {
        const { service, queryRunner } = createHarness()
        jest.spyOn(service, 'readUserById').mockResolvedValue({
            id: userId,
            email: 'old@example.invalid',
            tempToken: 'one-time-token'
        } as User)
        jest.spyOn(service, 'readUserByEmail').mockResolvedValue(null)
        queryRunner.manager.update.mockResolvedValueOnce({ affected: 0 })

        await expect(service.confirmEmailChange(userId, 'new@example.invalid', 'one-time-token')).rejects.toMatchObject({
            statusCode: 400,
            message: 'Invalid Temporary Token'
        })

        expect(queryRunner.rollbackTransaction).toHaveBeenCalledTimes(1)
        expect(mockDestroyAllSessionsForUser).not.toHaveBeenCalled()
    })
})
