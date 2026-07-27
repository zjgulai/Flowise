import { QueryRunner } from 'typeorm'
import { OrganizationUser, OrganizationUserStatus } from '../database/entities/organization-user.entity'
import { GeneralRole } from '../database/entities/role.entity'
import { User, UserStatus } from '../database/entities/user.entity'
import {
    assertOrganizationInvitationActivationAllowed,
    assertOrganizationOwnerMutationAllowed,
    OrganizationUserService
} from './organization-user.service'

const makeService = () => Object.create(OrganizationUserService.prototype) as OrganizationUserService

const makeMutationQueryRunner = () => {
    let transactionActive = false
    let released = false
    const queryRunner = {
        manager: {
            findOneBy: jest.fn(),
            create: jest.fn((_entity, value) => ({ ...value })),
            save: jest.fn(async (_entity, value) => ({ ...value })),
            merge: jest.fn((_entity, current, patch) => ({ ...current, ...patch }))
        },
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
        })
    }
    Object.defineProperty(queryRunner, 'isTransactionActive', { get: () => transactionActive })
    Object.defineProperty(queryRunner, 'isReleased', { get: () => released })
    return queryRunner
}

describe('OrganizationUserService owner-role boundary', () => {
    const ownerRoleId = 'owner-role'

    it('requires organization-owner authority whenever an owner boundary is touched', () => {
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

    it('allows only the invited organization member to activate their own membership', () => {
        expect(() =>
            assertOrganizationInvitationActivationAllowed({
                currentStatus: OrganizationUserStatus.INVITED,
                requestedStatus: OrganizationUserStatus.ACTIVE,
                targetUserId: 'target-user',
                actorUserId: 'target-user'
            })
        ).not.toThrow()
        expect(() =>
            assertOrganizationInvitationActivationAllowed({
                currentStatus: OrganizationUserStatus.INVITED,
                requestedStatus: OrganizationUserStatus.ACTIVE,
                targetUserId: 'target-user',
                actorUserId: 'admin-user'
            })
        ).toThrow(expect.objectContaining({ statusCode: 403 }))
        expect(() =>
            assertOrganizationInvitationActivationAllowed({
                currentStatus: OrganizationUserStatus.INVITED,
                requestedStatus: OrganizationUserStatus.DISABLE,
                targetUserId: 'target-user',
                actorUserId: 'admin-user'
            })
        ).toThrow(expect.objectContaining({ statusCode: 403 }))
    })

    it('rejects creating another owner before any membership write', async () => {
        const queryRunner = makeMutationQueryRunner()
        const service = makeService()
        const readUserById = jest.fn()
        Reflect.set(service, 'dataSource', { createQueryRunner: jest.fn().mockReturnValue(queryRunner) })
        Reflect.set(service, 'roleService', {
            readRoleIsGeneral: jest.fn().mockResolvedValue({ id: ownerRoleId, name: GeneralRole.OWNER })
        })
        Reflect.set(service, 'userService', { readUserById })
        Reflect.set(
            service,
            'readOrganizationUserByOrganizationIdUserId',
            jest.fn().mockResolvedValue({ organization: { id: 'organization-1' }, organizationUser: null })
        )

        await expect(
            service.createOrganizationUser({
                organizationId: 'organization-1',
                userId: 'new-owner',
                roleId: ownerRoleId,
                createdBy: 'current-owner'
            })
        ).rejects.toEqual(expect.objectContaining({ statusCode: 400 }))

        expect(readUserById).not.toHaveBeenCalled()
        expect(queryRunner.startTransaction).not.toHaveBeenCalled()
        expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled()
        expect(queryRunner.release).toHaveBeenCalledTimes(1)
        expect(queryRunner.manager.merge).not.toHaveBeenCalled()
    })

    it('forces a newly created organization membership to invited even when the client requests active', async () => {
        const queryRunner = makeMutationQueryRunner()
        const service = makeService()
        Reflect.set(service, 'dataSource', { createQueryRunner: jest.fn().mockReturnValue(queryRunner) })
        Reflect.set(service, 'roleService', {
            readRoleIsGeneral: jest.fn().mockResolvedValue({ id: 'member-role', name: GeneralRole.MEMBER }),
            readGeneralRoleByName: jest.fn().mockResolvedValue({ id: ownerRoleId })
        })
        Reflect.set(service, 'userService', { readUserById: jest.fn().mockResolvedValue({ id: 'current-owner' }) })
        Reflect.set(service, 'organizationService', { saveOrganization: jest.fn(async (organization) => organization) })
        Reflect.set(
            service,
            'readOrganizationUserByOrganizationIdUserId',
            jest.fn().mockResolvedValue({ organization: { id: 'organization-1' }, organizationUser: null })
        )

        await expect(
            service.createOrganizationUser({
                organizationId: 'organization-1',
                userId: 'new-member',
                roleId: 'member-role',
                status: OrganizationUserStatus.ACTIVE,
                createdBy: 'current-owner'
            })
        ).resolves.toMatchObject({ status: OrganizationUserStatus.INVITED })

        expect(queryRunner.manager.save).toHaveBeenCalledWith(
            OrganizationUser,
            expect.objectContaining({ status: OrganizationUserStatus.INVITED })
        )
        expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1)
        expect(queryRunner.release).toHaveBeenCalledTimes(1)
    })

    it('rejects promoting a non-owner to owner before any membership write', async () => {
        const queryRunner = makeMutationQueryRunner()
        const service = makeService()
        Reflect.set(service, 'dataSource', { createQueryRunner: jest.fn().mockReturnValue(queryRunner) })
        Reflect.set(service, 'roleService', {
            readRoleIsGeneral: jest.fn().mockResolvedValue({ id: ownerRoleId, name: GeneralRole.OWNER })
        })
        Reflect.set(
            service,
            'readOrganizationUserByOrganizationIdUserId',
            jest.fn().mockResolvedValue({
                organization: { id: 'organization-1' },
                organizationUser: {
                    organizationId: 'organization-1',
                    userId: 'member-user',
                    roleId: 'member-role',
                    createdBy: 'current-owner'
                }
            })
        )

        await expect(
            service.updateOrganizationUser({
                organizationId: 'organization-1',
                userId: 'member-user',
                roleId: ownerRoleId,
                updatedBy: 'current-owner'
            })
        ).rejects.toEqual(expect.objectContaining({ statusCode: 400 }))

        expect(queryRunner.startTransaction).not.toHaveBeenCalled()
        expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled()
        expect(queryRunner.release).toHaveBeenCalledTimes(1)
        expect(queryRunner.manager.merge).not.toHaveBeenCalled()
    })

    it('allows the current owner to retain the owner role without creating a new owner', async () => {
        const queryRunner = makeMutationQueryRunner()
        queryRunner.manager.findOneBy.mockResolvedValue({
            organizationId: 'organization-1',
            userId: 'current-owner',
            roleId: ownerRoleId
        })
        const service = makeService()
        Reflect.set(service, 'dataSource', { createQueryRunner: jest.fn().mockReturnValue(queryRunner) })
        Reflect.set(service, 'roleService', {
            readRoleIsGeneral: jest.fn().mockResolvedValue({ id: ownerRoleId, name: GeneralRole.OWNER }),
            readGeneralRoleByName: jest.fn().mockResolvedValue({ id: ownerRoleId })
        })
        Reflect.set(
            service,
            'readOrganizationUserByOrganizationIdUserId',
            jest.fn().mockResolvedValue({
                organization: { id: 'organization-1' },
                organizationUser: {
                    organizationId: 'organization-1',
                    userId: 'current-owner',
                    roleId: ownerRoleId,
                    createdBy: 'current-owner'
                }
            })
        )
        Reflect.set(
            service,
            'saveOrganizationUser',
            jest.fn().mockImplementation(async (membership) => membership)
        )

        await expect(
            service.updateOrganizationUser({
                organizationId: 'organization-1',
                userId: 'current-owner',
                roleId: ownerRoleId,
                updatedBy: 'current-owner'
            })
        ).resolves.toEqual(expect.objectContaining({ userId: 'current-owner', roleId: ownerRoleId }))

        expect(queryRunner.startTransaction).toHaveBeenCalledTimes(1)
        expect(queryRunner.commitTransaction).toHaveBeenCalledTimes(1)
        expect(queryRunner.release).toHaveBeenCalledTimes(1)
    })

    it.each([
        ['demote', { roleId: 'member-role' }],
        ['disable', { status: OrganizationUserStatus.DISABLE }],
        ['re-invite', { status: OrganizationUserStatus.INVITED }]
    ])('rejects attempting to %s the current organization owner', async (_label, patch) => {
        const queryRunner = makeMutationQueryRunner()
        queryRunner.manager.findOneBy.mockResolvedValue({
            organizationId: 'organization-1',
            userId: 'current-owner',
            roleId: ownerRoleId,
            status: OrganizationUserStatus.ACTIVE
        })
        const service = makeService()
        Reflect.set(service, 'dataSource', { createQueryRunner: jest.fn().mockReturnValue(queryRunner) })
        Reflect.set(service, 'roleService', {
            readRoleIsGeneral: jest.fn().mockResolvedValue({ id: 'member-role', name: GeneralRole.MEMBER }),
            readGeneralRoleByName: jest.fn().mockResolvedValue({ id: ownerRoleId })
        })
        Reflect.set(
            service,
            'readOrganizationUserByOrganizationIdUserId',
            jest.fn().mockResolvedValue({
                organization: { id: 'organization-1' },
                organizationUser: {
                    organizationId: 'organization-1',
                    userId: 'current-owner',
                    roleId: ownerRoleId,
                    status: OrganizationUserStatus.ACTIVE,
                    createdBy: 'current-owner'
                }
            })
        )

        await expect(
            service.updateOrganizationUser({
                organizationId: 'organization-1',
                userId: 'current-owner',
                updatedBy: 'current-owner',
                ...patch
            })
        ).rejects.toEqual(expect.objectContaining({ statusCode: 400 }))

        expect(queryRunner.startTransaction).not.toHaveBeenCalled()
        expect(queryRunner.rollbackTransaction).not.toHaveBeenCalled()
        expect(queryRunner.release).toHaveBeenCalledTimes(1)
        expect(queryRunner.manager.merge).not.toHaveBeenCalled()
    })

    it.each([OrganizationUserStatus.ACTIVE, OrganizationUserStatus.DISABLE])(
        'rejects an administrator changing another user invitation to %s',
        async (requestedStatus) => {
            const queryRunner = makeMutationQueryRunner()
            const service = makeService()
            Reflect.set(service, 'dataSource', { createQueryRunner: jest.fn().mockReturnValue(queryRunner) })
            Reflect.set(service, 'roleService', {
                readGeneralRoleByName: jest.fn().mockResolvedValue({ id: ownerRoleId })
            })
            Reflect.set(
                service,
                'readOrganizationUserByOrganizationIdUserId',
                jest.fn().mockResolvedValue({
                    organization: { id: 'organization-1' },
                    organizationUser: {
                        organizationId: 'organization-1',
                        userId: 'target-user',
                        roleId: 'member-role',
                        status: OrganizationUserStatus.INVITED,
                        createdBy: 'current-owner'
                    }
                })
            )

            await expect(
                service.updateOrganizationUser({
                    organizationId: 'organization-1',
                    userId: 'target-user',
                    status: requestedStatus,
                    updatedBy: 'current-owner'
                })
            ).rejects.toEqual(expect.objectContaining({ statusCode: 403 }))

            expect(queryRunner.startTransaction).not.toHaveBeenCalled()
            expect(queryRunner.release).toHaveBeenCalledTimes(1)
            expect(queryRunner.manager.merge).not.toHaveBeenCalled()
        }
    )

    it('rejects invalid empty organization membership status before any write', async () => {
        const queryRunner = makeMutationQueryRunner()
        const service = makeService()
        Reflect.set(service, 'dataSource', { createQueryRunner: jest.fn().mockReturnValue(queryRunner) })
        Reflect.set(
            service,
            'readOrganizationUserByOrganizationIdUserId',
            jest.fn().mockResolvedValue({
                organization: { id: 'organization-1' },
                organizationUser: {
                    organizationId: 'organization-1',
                    userId: 'target-user',
                    roleId: 'member-role',
                    status: OrganizationUserStatus.INVITED,
                    createdBy: 'current-owner'
                }
            })
        )

        await expect(
            service.updateOrganizationUser({
                organizationId: 'organization-1',
                userId: 'target-user',
                status: '',
                updatedBy: 'current-owner'
            })
        ).rejects.toEqual(expect.objectContaining({ statusCode: 400 }))

        expect(queryRunner.startTransaction).not.toHaveBeenCalled()
        expect(queryRunner.release).toHaveBeenCalledTimes(1)
        expect(queryRunner.manager.merge).not.toHaveBeenCalled()
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

describe('OrganizationUserService organization owner details', () => {
    it('sanitizes owner credentials before returning organization memberships', async () => {
        const ownerDetails = {
            id: 'owner-user',
            name: 'Owner',
            email: 'owner@example.invalid',
            credential: 'derived-secret',
            tempToken: 'temporary-secret',
            tokenExpiry: new Date('2026-07-24T00:00:00.000Z')
        } as User
        const readUserById = jest.fn().mockResolvedValueOnce({ id: 'member-user' }).mockResolvedValueOnce(ownerDetails)
        const getMany = jest.fn().mockResolvedValue([
            {
                organizationId: 'organization-1',
                userId: 'member-user',
                roleId: 'member-role'
            }
        ])
        const queryBuilder = {
            innerJoinAndSelect: jest.fn().mockReturnThis(),
            where: jest.fn().mockReturnThis(),
            getMany
        }
        const queryRunner = {
            manager: {
                createQueryBuilder: jest.fn().mockReturnValue(queryBuilder)
            }
        } as unknown as QueryRunner
        const service = makeService()
        Reflect.set(service, 'userService', { readUserById })
        Reflect.set(service, 'roleService', { readGeneralRoleByName: jest.fn().mockResolvedValue({ id: 'owner-role' }) })
        Reflect.set(service, 'readOrganizationUserByOrganizationIdRoleId', jest.fn().mockResolvedValue([{ userId: ownerDetails.id }]))

        const result = await service.readOrganizationUserByUserId('member-user', queryRunner)

        expect(result[0].user).toEqual({
            id: ownerDetails.id,
            name: ownerDetails.name,
            email: ownerDetails.email
        })
        expect(result[0].user).not.toHaveProperty('credential')
        expect(result[0].user).not.toHaveProperty('tempToken')
        expect(result[0].user).not.toHaveProperty('tokenExpiry')
    })
})
