import { QueryRunner } from 'typeorm'
import { OrganizationUser } from '../database/entities/organization-user.entity'
import { User, UserStatus } from '../database/entities/user.entity'
import { assertOrganizationOwnerMutationAllowed, OrganizationUserService } from './organization-user.service'

const makeService = () => Object.create(OrganizationUserService.prototype) as OrganizationUserService

describe('OrganizationUserService owner-role boundary', () => {
    const ownerRoleId = 'owner-role'

    it('allows only an organization owner to grant or mutate the owner membership', () => {
        expect(() =>
            assertOrganizationOwnerMutationAllowed({ actorRoleId: ownerRoleId, requestedRoleId: ownerRoleId, ownerRoleId })
        ).not.toThrow()

        expect(() =>
            assertOrganizationOwnerMutationAllowed({ actorRoleId: 'member-role', requestedRoleId: ownerRoleId, ownerRoleId })
        ).toThrow(expect.objectContaining({ statusCode: 403 }))

        expect(() =>
            assertOrganizationOwnerMutationAllowed({ actorRoleId: 'member-role', targetRoleId: ownerRoleId, ownerRoleId })
        ).toThrow(expect.objectContaining({ statusCode: 403 }))
    })

    it('does not require owner authority for a member-to-member mutation', () => {
        expect(() =>
            assertOrganizationOwnerMutationAllowed({
                actorRoleId: 'member-role',
                targetRoleId: 'member-role',
                requestedRoleId: 'member-role',
                ownerRoleId
            })
        ).not.toThrow()
    })
})

describe('OrganizationUserService global account deletion boundary', () => {
    it('preserves the global user when another organization membership remains', async () => {
        const countBy = jest.fn().mockResolvedValue(1)
        const findOneBy = jest.fn()
        const save = jest.fn()
        const queryRunner = { manager: { countBy, findOneBy, save } } as unknown as QueryRunner

        await expect(makeService().softDeleteUserIfNoOrganizationMemberships(queryRunner, 'shared-user')).resolves.toBe(false)

        expect(countBy).toHaveBeenCalledWith(OrganizationUser, { userId: 'shared-user' })
        expect(findOneBy).not.toHaveBeenCalled()
        expect(save).not.toHaveBeenCalled()
    })

    it('anonymizes credentials only after the final organization membership is removed', async () => {
        const storedUser = {
            id: 'orphan-user',
            name: 'Before',
            email: 'before@example.invalid',
            status: UserStatus.ACTIVE,
            credential: 'derived-secret',
            tokenExpiry: new Date(),
            tempToken: 'temporary-secret'
        } as User
        const countBy = jest.fn().mockResolvedValue(0)
        const findOneBy = jest.fn().mockResolvedValue(storedUser)
        const save = jest.fn().mockResolvedValue(storedUser)
        const queryRunner = { manager: { countBy, findOneBy, save } } as unknown as QueryRunner

        await expect(makeService().softDeleteUserIfNoOrganizationMemberships(queryRunner, storedUser.id)).resolves.toBe(true)

        expect(findOneBy).toHaveBeenCalledWith(User, { id: storedUser.id })
        expect(storedUser).toEqual(
            expect.objectContaining({
                name: UserStatus.DELETED,
                status: UserStatus.DELETED,
                credential: null,
                tokenExpiry: null,
                tempToken: null
            })
        )
        expect(storedUser.email).toMatch(/^deleted_orphan-user_\d+@deleted\.flowise$/)
        expect(save).toHaveBeenCalledWith(User, storedUser)
    })
})
