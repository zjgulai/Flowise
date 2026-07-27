const mockGetHash = jest.fn().mockReturnValue('replacement-derived-value')
const mockValidatePasswordOrThrow = jest.fn()

jest.mock('../enterprise/utils/encryption.util', () => ({
    getHash: mockGetHash
}))

jest.mock('../enterprise/utils/validation.util', () => ({
    validatePasswordOrThrow: mockValidatePasswordOrThrow
}))

jest.mock('../utils/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), error: jest.fn() }
}))

import { User } from '../enterprise/database/entities/user.entity'
import { resetUserPassword } from './user'

describe('resetUserPassword CLI mutation', () => {
    beforeEach(() => jest.clearAllMocks())

    it('atomically replaces the credential and clears every recovery token field', async () => {
        const storedUser = {
            id: '00000000-0000-4000-8000-000000000001',
            email: 'admin@example.invalid',
            credential: 'old-derived-value',
            tempToken: 'outstanding-reset-token',
            tokenExpiry: new Date(Date.now() + 60_000),
            updatedBy: 'previous-actor'
        } as User
        const queryRunner = {
            manager: {
                findOne: jest.fn().mockResolvedValue(storedUser),
                update: jest.fn().mockResolvedValue({ affected: 1 }),
                save: jest.fn()
            }
        } as any

        await resetUserPassword(queryRunner, storedUser.email, 'replacement-password')

        expect(mockValidatePasswordOrThrow).toHaveBeenCalledWith('replacement-password')
        expect(mockGetHash).toHaveBeenCalledWith('replacement-password')
        expect(queryRunner.manager.update).toHaveBeenCalledWith(
            User,
            { id: storedUser.id },
            {
                credential: 'replacement-derived-value',
                tempToken: null,
                tokenExpiry: null,
                updatedBy: storedUser.id
            }
        )
        expect(queryRunner.manager.save).not.toHaveBeenCalled()
    })

    it('reports a lost update instead of claiming the password was reset', async () => {
        const queryRunner = {
            manager: {
                findOne: jest.fn().mockResolvedValue({ id: 'user-id', email: 'admin@example.invalid' }),
                update: jest.fn().mockResolvedValue({ affected: 0 })
            }
        } as any

        await expect(resetUserPassword(queryRunner, 'admin@example.invalid', 'replacement-password')).rejects.toThrow(
            'Password reset failed'
        )
    })
})
