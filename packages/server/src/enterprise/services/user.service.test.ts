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

    it('does not start or persist a password transaction when session revocation fails', async () => {
        const { service, queryRunner } = createHarness()
        const revocationError = new Error('revocation-failure')
        mockDestroyAllSessionsForUser.mockRejectedValue(revocationError)

        await expect(service.updateUser(passwordPatch())).rejects.toBe(revocationError)

        expect(queryRunner.startTransaction).not.toHaveBeenCalled()
        expect(queryRunner.manager.save).not.toHaveBeenCalled()
        expect(queryRunner.commitTransaction).not.toHaveBeenCalled()
        expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled()
        expect(queryRunner.release).toHaveBeenCalledTimes(1)
    })

    it('revokes sessions before starting and committing a password transaction', async () => {
        const { service, events } = createHarness()
        mockDestroyAllSessionsForUser.mockImplementation(async () => {
            events.push('revoke')
        })

        await service.updateUser(passwordPatch())

        expect(events).toEqual(['revoke', 'start', 'save', 'commit', 'release'])
        expect(mockDestroyAllSessionsForUser).toHaveBeenCalledWith(userId)
    })

    it.each(['save', 'commit'] as FailurePoint[])('revokes once and rolls back when %s fails', async (failurePoint) => {
        const { service, queryRunner, events } = createHarness(failurePoint)
        mockDestroyAllSessionsForUser.mockImplementation(async () => {
            events.push('revoke')
        })

        await expect(service.updateUser(passwordPatch())).rejects.toThrow(`${failurePoint}-failure`)

        expect(mockDestroyAllSessionsForUser).toHaveBeenCalledTimes(1)
        expect(events[0]).toBe('revoke')
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
