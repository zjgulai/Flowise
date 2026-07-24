import { QueryRunner } from 'typeorm'
import { Organization } from '../database/entities/organization.entity'
import { OrganizationService } from './organization.service'

const makeService = () => Object.create(OrganizationService.prototype) as OrganizationService

describe('OrganizationService public write allowlists', () => {
    it('generates the create id and drops untrusted billing and audit fields', () => {
        const create = jest.fn((_entity: unknown, data: Partial<Organization>) => data)
        const queryRunner = { manager: { create } } as unknown as QueryRunner
        const service = makeService()

        const organization = service.createNewOrganization(
            {
                id: 'attacker-selected-id',
                name: 'Public name',
                customerId: 'cus-attacker',
                subscriptionId: 'sub-attacker',
                createdBy: 'server-actor',
                updatedBy: 'attacker'
            } as never,
            queryRunner
        )

        expect(create).toHaveBeenCalledWith(
            Organization,
            expect.objectContaining({
                name: 'Public name',
                createdBy: 'server-actor',
                updatedBy: 'server-actor'
            })
        )
        expect(organization.id).toEqual(expect.any(String))
        expect(organization.id).not.toBe('attacker-selected-id')
        expect(organization).not.toHaveProperty('customerId')
        expect(organization).not.toHaveProperty('subscriptionId')
    })

    it('retains provider-issued billing fields only on the explicit registration path', () => {
        const create = jest.fn((_entity: unknown, data: Partial<Organization>) => data)
        const queryRunner = { manager: { create } } as unknown as QueryRunner
        const service = makeService()

        const organization = service.createNewOrganizationForRegistration(
            {
                name: 'Default Organization',
                customerId: 'cus-provider',
                subscriptionId: 'sub-provider',
                createdBy: 'server-actor'
            },
            queryRunner
        )

        expect(organization).toEqual(
            expect.objectContaining({
                customerId: 'cus-provider',
                subscriptionId: 'sub-provider',
                createdBy: 'server-actor',
                updatedBy: 'server-actor'
            })
        )
    })

    it('updates only name and server-bound audit identity while preserving stored billing ids', async () => {
        const stored = {
            id: '00000000-0000-4000-8000-000000000001',
            name: 'Before',
            customerId: 'cus-stored',
            subscriptionId: 'sub-stored',
            createdBy: 'creator'
        } as Organization
        const merge = jest.fn((_entity: unknown, oldData: Organization, update: Partial<Organization>) => ({ ...oldData, ...update }))
        const save = jest.fn((_entity: unknown, data: Organization) => Promise.resolve(data))
        const queryRunner = {
            connect: jest.fn().mockResolvedValue(undefined),
            startTransaction: jest.fn().mockResolvedValue(undefined),
            commitTransaction: jest.fn().mockResolvedValue(undefined),
            rollbackTransaction: jest.fn().mockResolvedValue(undefined),
            release: jest.fn().mockResolvedValue(undefined),
            manager: { merge, save }
        } as unknown as QueryRunner
        const service = makeService()
        ;(service as never as { dataSource: unknown }).dataSource = { createQueryRunner: jest.fn().mockReturnValue(queryRunner) }
        ;(service as never as { userService: unknown }).userService = { readUserById: jest.fn().mockResolvedValue({ id: 'admin-a' }) }
        service.readOrganizationById = jest.fn().mockResolvedValue(stored)

        const result = await service.updateOrganization(
            {
                id: stored.id,
                name: 'After',
                customerId: 'cus-attacker',
                subscriptionId: 'sub-attacker',
                createdBy: 'attacker',
                updatedBy: 'attacker'
            } as never,
            'admin-a',
            stored.id
        )

        expect(merge).toHaveBeenCalledWith(Organization, stored, {
            id: stored.id,
            name: 'After',
            createdBy: 'creator',
            updatedBy: 'admin-a'
        })
        expect(result).toEqual(expect.objectContaining({ customerId: 'cus-stored', subscriptionId: 'sub-stored' }))
        expect(result.customerId).not.toBe('cus-attacker')
        expect(result.subscriptionId).not.toBe('sub-attacker')
    })

    it('rejects a cross-tenant update before opening a query runner', async () => {
        const createQueryRunner = jest.fn()
        const service = makeService()
        ;(service as never as { dataSource: unknown }).dataSource = { createQueryRunner }

        await expect(service.updateOrganization({ id: 'org-b', name: 'Other' }, 'admin-a', 'org-a')).rejects.toMatchObject({
            statusCode: 403
        })
        expect(createQueryRunner).not.toHaveBeenCalled()
    })
})
