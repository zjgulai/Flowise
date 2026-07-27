import { IdentityManager } from '../../IdentityManager'
import { OrganizationUserStatus } from '../database/entities/organization-user.entity'
import { User, UserStatus } from '../database/entities/user.entity'
import { WorkspaceUser, WorkspaceUserStatus } from '../database/entities/workspace-user.entity'
import { LoggedInUser } from '../Interface.Enterprise'
import { hashAcceptanceCode } from '../utils/acceptanceLoginPolicy'
import { AcceptanceLoginRejectedError, AcceptanceLoginService, AcceptanceLoginServiceDependencies } from './acceptanceLogin.service'

const validCode = 'A'.repeat(43)
const storedHash = hashAcceptanceCode(validCode)!
const now = new Date('2026-07-22T00:00:00.000Z')
const syntheticUser = {
    id: '00000000-0000-4000-8000-000000000001',
    email: 'flowise-acceptance+run-01@acceptance.invalid',
    name: 'Acceptance Run',
    credential: null,
    tempToken: storedHash,
    tokenExpiry: new Date(now.getTime() + 60_000),
    status: UserStatus.ACTIVE
} as User
const workspaceUser = {
    userId: syntheticUser.id,
    workspaceId: '00000000-0000-4000-8000-000000000002',
    roleId: '00000000-0000-4000-8000-000000000003',
    status: WorkspaceUserStatus.ACTIVE,
    workspace: { id: '00000000-0000-4000-8000-000000000002', name: 'Acceptance', organizationId: 'org-id' }
} as WorkspaceUser
const organizationUser = {
    userId: syntheticUser.id,
    organizationId: 'org-id',
    status: OrganizationUserStatus.ACTIVE
}
const loggedInUser = { id: syntheticUser.id, activeWorkspaceId: workspaceUser.workspaceId } as LoggedInUser

function createHarness() {
    const findOneBy = jest.fn().mockResolvedValue({ ...syntheticUser })
    const execute = jest.fn().mockResolvedValue({ affected: 1 })
    const updateBuilder = {
        update: jest.fn(),
        set: jest.fn(),
        where: jest.fn(),
        execute
    }
    updateBuilder.update.mockReturnValue(updateBuilder)
    updateBuilder.set.mockReturnValue(updateBuilder)
    updateBuilder.where.mockReturnValue(updateBuilder)
    const queryRunner = {
        connect: jest.fn().mockResolvedValue(undefined),
        release: jest.fn().mockResolvedValue(undefined),
        manager: {
            findOneBy,
            createQueryBuilder: jest.fn().mockReturnValue(updateBuilder),
            update: jest.fn()
        }
    }
    const buildUser = jest.fn().mockResolvedValue(loggedInUser)
    const workspaceUserService = {
        readWorkspaceUserByLastLogin: jest.fn().mockResolvedValue({ ...workspaceUser })
    }
    const organizationUserService = {
        readOrganizationUserByWorkspaceIdUserId: jest.fn().mockResolvedValue({ organizationUser: { ...organizationUser } })
    }
    const dependencies: AcceptanceLoginServiceDependencies = {
        dataSource: { createQueryRunner: jest.fn().mockReturnValue(queryRunner) } as never,
        identityManager: {} as IdentityManager,
        now: () => now,
        buildUser,
        workspaceUserService,
        organizationUserService
    }
    const service = new AcceptanceLoginService(dependencies)
    return {
        service,
        queryRunner,
        findOneBy,
        execute,
        updateBuilder,
        buildUser,
        workspaceUserService,
        organizationUserService
    }
}

describe('AcceptanceLoginService', () => {
    it('atomically consumes one valid active synthetic token before building the user', async () => {
        const harness = createHarness()

        await expect(harness.service.consume(validCode)).resolves.toBe(loggedInUser)

        expect(harness.updateBuilder.set).toHaveBeenCalledWith({ tempToken: null, tokenExpiry: null })
        expect(harness.updateBuilder.where).toHaveBeenCalledWith(
            expect.objectContaining({
                id: syntheticUser.id,
                email: syntheticUser.email,
                tempToken: storedHash,
                status: UserStatus.ACTIVE,
                tokenExpiry: expect.objectContaining({ type: 'moreThan', value: now }),
                credential: expect.objectContaining({ type: 'isNull' })
            })
        )
        expect(harness.buildUser).toHaveBeenCalledWith(
            expect.objectContaining({ user: expect.objectContaining({ id: syntheticUser.id }), mode: 'acceptance-login' })
        )
        expect(harness.queryRunner.release).toHaveBeenCalledTimes(1)
    })

    it.each([
        ['expired token', { tokenExpiry: new Date(now.getTime() - 1) }],
        ['expiry equality', { tokenExpiry: now }],
        ['real email', { email: 'real@example.invalid' }],
        ['credential present', { credential: 'stored-derived-value' }],
        ['inactive user', { status: UserStatus.DELETED }],
        ['consumed token', { tempToken: null }]
    ])('rejects %s before CAS and session construction', async (_label, patch) => {
        const harness = createHarness()
        harness.findOneBy.mockResolvedValue({ ...syntheticUser, ...patch })

        await expect(harness.service.consume(validCode)).rejects.toBeInstanceOf(AcceptanceLoginRejectedError)

        expect(harness.execute).not.toHaveBeenCalled()
        expect(harness.buildUser).not.toHaveBeenCalled()
        expect(harness.queryRunner.release).toHaveBeenCalledTimes(1)
    })

    it.each(['workspace-missing', 'workspace-inactive', 'organization-missing', 'organization-inactive'] as const)(
        'rejects %s before CAS',
        async (condition) => {
            const harness = createHarness()
            if (condition === 'workspace-missing') harness.workspaceUserService.readWorkspaceUserByLastLogin.mockResolvedValue([])
            if (condition === 'workspace-inactive') {
                harness.workspaceUserService.readWorkspaceUserByLastLogin.mockResolvedValue({
                    ...workspaceUser,
                    status: WorkspaceUserStatus.DISABLE
                })
            }
            if (condition === 'organization-missing') {
                harness.organizationUserService.readOrganizationUserByWorkspaceIdUserId.mockResolvedValue({ organizationUser: undefined })
            }
            if (condition === 'organization-inactive') {
                harness.organizationUserService.readOrganizationUserByWorkspaceIdUserId.mockResolvedValue({
                    organizationUser: { ...organizationUser, status: OrganizationUserStatus.DISABLE }
                })
            }

            await expect(harness.service.consume(validCode)).rejects.toBeInstanceOf(AcceptanceLoginRejectedError)
            expect(harness.execute).not.toHaveBeenCalled()
            expect(harness.buildUser).not.toHaveBeenCalled()
        }
    )

    it('rejects malformed input without querying the database', async () => {
        const harness = createHarness()
        await expect(harness.service.consume('short')).rejects.toBeInstanceOf(AcceptanceLoginRejectedError)
        expect(harness.findOneBy).not.toHaveBeenCalled()
    })

    it('requires exactly one affected row', async () => {
        const harness = createHarness()
        harness.execute.mockResolvedValue({ affected: 0 })
        await expect(harness.service.consume(validCode)).rejects.toBeInstanceOf(AcceptanceLoginRejectedError)
        expect(harness.buildUser).not.toHaveBeenCalled()
    })

    it('allows only one of two concurrent consumers', async () => {
        const harness = createHarness()
        harness.execute.mockResolvedValueOnce({ affected: 1 }).mockResolvedValueOnce({ affected: 0 })

        const results = await Promise.allSettled([harness.service.consume(validCode), harness.service.consume(validCode)])

        expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1)
        expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1)
    })

    it('does not restore a consumed token when user construction fails', async () => {
        const harness = createHarness()
        harness.buildUser.mockRejectedValue(new Error('builder-failure'))

        await expect(harness.service.consume(validCode)).rejects.toThrow('builder-failure')

        expect(harness.execute).toHaveBeenCalledTimes(1)
        expect(harness.queryRunner.manager.update).not.toHaveBeenCalled()
    })
})
