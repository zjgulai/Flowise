const mockDestroyAllSessionsForUser = jest.fn()

jest.mock('../middleware/passport/SessionPersistance', () => ({
    destroyAllSessionsForUser: mockDestroyAllSessionsForUser
}))

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: jest.fn()
}))

import { OrganizationUserService } from './organization-user.service'
import { WorkspaceUserService } from './workspace-user.service'

const userId = '00000000-0000-4000-8000-000000000001'
const workspaceId = '00000000-0000-4000-8000-000000000002'
const organizationId = '00000000-0000-4000-8000-000000000003'

describe('membership authorization session revocation', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it('revokes after an organization membership status change commits', async () => {
        const events: string[] = []
        const queryRunner = {
            connect: jest.fn(),
            startTransaction: jest.fn(),
            commitTransaction: jest.fn().mockImplementation(async () => events.push('commit')),
            rollbackTransaction: jest.fn(),
            release: jest.fn(),
            manager: {
                merge: jest.fn().mockImplementation((_entity, current, patch) => ({ ...current, ...patch })),
                findOneBy: jest.fn()
            }
        }
        mockDestroyAllSessionsForUser.mockImplementation(async () => events.push('revoke'))
        const service = Object.create(OrganizationUserService.prototype) as OrganizationUserService
        ;(service as any).dataSource = { createQueryRunner: jest.fn().mockReturnValue(queryRunner) }
        ;(service as any).roleService = {
            readRoleIsGeneral: jest.fn(),
            readGeneralRoleByName: jest.fn().mockResolvedValue({ id: 'owner-role' })
        }
        jest.spyOn(service, 'readOrganizationUserByOrganizationIdUserId').mockResolvedValue({
            organization: {} as any,
            organizationUser: { userId, organizationId, roleId: 'role-id', status: 'active', createdBy: userId } as any
        })
        jest.spyOn(service, 'saveOrganizationUser').mockImplementation(async (membership) => membership as any)

        await service.updateOrganizationUser({ userId, organizationId, status: 'disable', updatedBy: userId })

        expect(events).toEqual(['commit', 'revoke'])
        expect(mockDestroyAllSessionsForUser).toHaveBeenCalledWith(userId)
    })

    it('revokes after a workspace membership role change is saved', async () => {
        const events: string[] = []
        const queryRunner = {
            manager: {
                merge: jest.fn().mockImplementation((_entity, current, patch) => ({ ...current, ...patch })),
                findOneBy: jest.fn().mockResolvedValue({ roleId: 'owner-role', status: 'active' })
            }
        }
        mockDestroyAllSessionsForUser.mockImplementation(async () => events.push('revoke'))
        const service = Object.create(WorkspaceUserService.prototype) as WorkspaceUserService
        ;(service as any).roleService = {
            readRoleById: jest.fn().mockResolvedValue({ id: 'new-role', organizationId, permissions: '[]' }),
            readGeneralRoleByName: jest.fn().mockResolvedValue({ id: 'owner-role' })
        }
        ;(service as any).userService = { readUserById: jest.fn().mockResolvedValue({ id: userId }) }
        jest.spyOn(service, 'readWorkspaceUserByWorkspaceIdUserId').mockResolvedValue({
            workspace: { id: workspaceId, organizationId } as any,
            workspaceUser: {
                userId,
                workspaceId,
                roleId: 'old-role',
                role: { id: 'old-role', organizationId },
                status: 'active',
                createdBy: userId
            } as any
        })
        jest.spyOn(service, 'saveWorkspaceUser').mockImplementation(async (membership) => {
            events.push('save')
            return membership as any
        })

        await service.updateWorkspaceUser({ userId, workspaceId, roleId: 'new-role', updatedBy: userId }, queryRunner as any)

        expect(events).toEqual(['save', 'revoke'])
        expect(mockDestroyAllSessionsForUser).toHaveBeenCalledWith(userId)
    })

    it('does not revoke for last-login metadata only', async () => {
        const queryRunner = {
            manager: { merge: jest.fn().mockImplementation((_entity, current, patch) => ({ ...current, ...patch })) }
        }
        const service = Object.create(WorkspaceUserService.prototype) as WorkspaceUserService
        ;(service as any).userService = { readUserById: jest.fn().mockResolvedValue({ id: userId }) }
        jest.spyOn(service, 'readWorkspaceUserByWorkspaceIdUserId').mockResolvedValue({
            workspace: {} as any,
            workspaceUser: { userId, workspaceId, roleId: 'role-id', status: 'active', createdBy: userId } as any
        })
        jest.spyOn(service, 'saveWorkspaceUser').mockImplementation(async (membership) => membership as any)

        await service.updateWorkspaceUser(
            { userId, workspaceId, lastLogin: '2026-07-24T00:00:00.000Z', updatedBy: userId },
            queryRunner as any
        )

        expect(mockDestroyAllSessionsForUser).not.toHaveBeenCalled()
    })
})
