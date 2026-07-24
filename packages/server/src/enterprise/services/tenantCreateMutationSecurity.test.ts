const queryRunner: any = {
    isTransactionActive: false,
    isReleased: false,
    connect: jest.fn(),
    startTransaction: jest.fn(async () => {
        queryRunner.isTransactionActive = true
    }),
    commitTransaction: jest.fn(async () => {
        queryRunner.isTransactionActive = false
    }),
    rollbackTransaction: jest.fn(async () => {
        queryRunner.isTransactionActive = false
    }),
    release: jest.fn(async () => {
        queryRunner.isReleased = true
    }),
    manager: {
        create: jest.fn((_entity: unknown, data: Record<string, unknown>) => ({ ...data, id: 'database-generated-id' })),
        save: jest.fn(async (_entity: unknown, data: Record<string, unknown>) => data),
        merge: jest.fn((_entity: unknown, oldData: Record<string, unknown>, data: Record<string, unknown>) => ({ ...oldData, ...data })),
        findOneBy: jest.fn(),
        delete: jest.fn()
    }
}

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: jest.fn(() => ({
        AppDataSource: { createQueryRunner: jest.fn(() => queryRunner) },
        telemetry: {}
    }))
}))

import { LoginMethod } from '../database/entities/login-method.entity'
import { Role } from '../database/entities/role.entity'
import { LoginMethodService } from './login-method.service'
import { RoleService } from './role.service'

function resetQueryRunner() {
    jest.clearAllMocks()
    queryRunner.isTransactionActive = false
    queryRunner.isReleased = false
    queryRunner.manager.create.mockImplementation((_entity: unknown, data: Record<string, unknown>) => ({
        ...data,
        id: 'database-generated-id'
    }))
    queryRunner.manager.save.mockImplementation(async (_entity: unknown, data: Record<string, unknown>) => data)
    queryRunner.manager.merge.mockImplementation((_entity: unknown, oldData: Record<string, unknown>, data: Record<string, unknown>) => ({
        ...oldData,
        ...data
    }))
}

describe('role service mutation hardening', () => {
    beforeEach(resetQueryRunner)

    it('never passes a caller-selected id or audit timestamps to role creation', async () => {
        const service = new RoleService() as any
        service.userService = { readUserById: jest.fn().mockResolvedValue({ id: 'user-active' }) }
        service.organizationService = { readOrganizationById: jest.fn().mockResolvedValue({ id: 'org-active' }) }

        await service.createRole({
            id: 'attacker-selected-id',
            organizationId: 'org-active',
            name: 'Operators',
            permissions: 'chatflows:view',
            createdBy: 'user-active',
            updatedBy: 'attacker',
            createdDate: new Date('2000-01-01')
        })

        expect(queryRunner.manager.create).toHaveBeenCalledTimes(1)
        const [, data] = queryRunner.manager.create.mock.calls[0]
        expect(queryRunner.manager.create).toHaveBeenCalledWith(Role, expect.any(Object))
        expect(data).toEqual({
            organizationId: 'org-active',
            name: 'Operators',
            description: undefined,
            permissions: 'chatflows:view',
            createdBy: 'user-active',
            updatedBy: 'user-active'
        })
        expect(data.id).toBeUndefined()
    })

    it('queries updates by both role id and active organization, excluding general roles', async () => {
        const service = new RoleService() as any
        service.userService = { readUserById: jest.fn() }
        service.organizationService = { readOrganizationById: jest.fn().mockResolvedValue({ id: 'org-active' }) }
        queryRunner.manager.findOneBy.mockResolvedValue(null)
        const roleId = '11111111-1111-4111-8111-111111111111'

        await expect(service.updateRole({ id: roleId, updatedBy: 'user-active' }, 'org-active')).rejects.toThrow('Role Not Found')

        expect(queryRunner.manager.findOneBy).toHaveBeenCalledWith(Role, { id: roleId, organizationId: 'org-active' })
        expect(service.userService.readUserById).not.toHaveBeenCalled()
        expect(queryRunner.manager.save).not.toHaveBeenCalled()
        expect(queryRunner.release).toHaveBeenCalledTimes(1)
    })

    it('does not delete memberships or roles when the role is absent from the active organization', async () => {
        const service = new RoleService() as any
        service.organizationService = { readOrganizationById: jest.fn().mockResolvedValue({ id: 'org-active' }) }
        queryRunner.manager.findOneBy.mockResolvedValue(null)
        const roleId = '11111111-1111-4111-8111-111111111111'

        await expect(service.deleteRole('org-active', roleId)).rejects.toThrow('Role Not Found')

        expect(queryRunner.manager.findOneBy).toHaveBeenCalledWith(Role, { id: roleId, organizationId: 'org-active' })
        expect(queryRunner.manager.delete).not.toHaveBeenCalled()
        expect(queryRunner.release).toHaveBeenCalledTimes(1)
    })
})

describe('login-method service create hardening', () => {
    beforeEach(resetQueryRunner)

    it('uses an insert-shaped DTO without a caller-selected id', async () => {
        const service = new LoginMethodService() as any
        service.userService = { readUserById: jest.fn().mockResolvedValue({ id: 'user-active' }) }
        service.organizationService = { readOrganizationById: jest.fn().mockResolvedValue({ id: 'org-active' }) }
        service.encryptLoginMethodConfig = jest.fn().mockResolvedValue('encrypted-config')

        await service.createLoginMethod({
            id: 'attacker-selected-id',
            organizationId: 'org-active',
            name: 'google',
            config: '{"clientID":"client"}',
            status: 'enable',
            createdBy: 'user-active',
            updatedBy: 'attacker',
            createdDate: new Date('2000-01-01')
        })

        expect(queryRunner.manager.create).toHaveBeenCalledTimes(1)
        const [, data] = queryRunner.manager.create.mock.calls[0]
        expect(queryRunner.manager.create).toHaveBeenCalledWith(LoginMethod, expect.any(Object))
        expect(data).toEqual({
            organizationId: 'org-active',
            name: 'google',
            config: 'encrypted-config',
            status: 'enable',
            createdBy: 'user-active',
            updatedBy: 'user-active'
        })
        expect(data.id).toBeUndefined()
    })

    it('rejects an unsupported provider before a direct create can open a connection or write', async () => {
        const service = new LoginMethodService() as any

        await expect(
            service.createLoginMethod({
                organizationId: 'org-active',
                name: 'unsupported-provider',
                config: '{"clientSecret":"must-not-be-persisted"}',
                status: 'enable',
                createdBy: 'user-active'
            })
        ).rejects.toThrow('Invalid Login Method Name')

        expect(queryRunner.connect).not.toHaveBeenCalled()
        expect(queryRunner.manager.create).not.toHaveBeenCalled()
        expect(queryRunner.manager.save).not.toHaveBeenCalled()
    })

    it('prevalidates every provider in a direct update batch before any connection or write', async () => {
        const service = new LoginMethodService() as any

        await expect(
            service.createOrUpdateConfig({
                organizationId: 'org-active',
                userId: 'user-active',
                providers: [
                    { providerName: 'google', config: { clientID: 'client' }, status: 'enable' },
                    {
                        providerName: 'unsupported-provider',
                        config: { clientSecret: 'must-not-be-persisted' },
                        status: 'enable'
                    }
                ]
            })
        ).rejects.toThrow('Invalid Login Method Name')

        expect(queryRunner.connect).not.toHaveBeenCalled()
        expect(queryRunner.startTransaction).not.toHaveBeenCalled()
        expect(queryRunner.manager.save).not.toHaveBeenCalled()
    })

    it('rejects an unsupported provider before a direct entity update can open a connection or write', async () => {
        const service = new LoginMethodService() as any

        await expect(
            service.updateLoginMethod({
                id: '11111111-1111-4111-8111-111111111111',
                name: 'unsupported-provider',
                updatedBy: 'user-active'
            })
        ).rejects.toThrow('Invalid Login Method Name')

        expect(queryRunner.connect).not.toHaveBeenCalled()
        expect(queryRunner.manager.merge).not.toHaveBeenCalled()
        expect(queryRunner.manager.save).not.toHaveBeenCalled()
    })
})
