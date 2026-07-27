import { Request } from 'express'
import { QueryRunner } from 'typeorm'
import { Credential } from '../../database/entities/Credential'
import { Workspace } from '../database/entities/workspace.entity'
import {
    assertWorkspaceDeleteRequest,
    bindWorkspaceCreateRequest,
    bindWorkspaceUpdateRequest,
    readWorkspaceShareItemType,
    validateWorkspaceShareRequest
} from './workspaceMutationGuards'

const admin = {
    id: 'admin-a',
    activeOrganizationId: 'org-a',
    activeWorkspaceId: 'workspace-a',
    assignedWorkspaces: [{ id: 'workspace-a' }, { id: 'workspace-b' }],
    isOrganizationAdmin: true,
    permissions: []
}

const member = {
    ...admin,
    id: 'member-a',
    isOrganizationAdmin: false,
    permissions: ['workspace:update', 'credentials:share']
}

const request = (user: any = admin, body: Record<string, unknown> = {}, params: Record<string, string> = {}) =>
    ({ user, body, params, query: {} } as unknown as Request)

const runner = (manager: Record<string, jest.Mock>) => ({ manager } as unknown as QueryRunner)

describe('workspace mutation tenant guards', () => {
    it('binds create tenant and audit fields while dropping server-owned fields', () => {
        const req = request(admin, {
            name: 'Safe',
            description: 'Description',
            organizationId: 'org-a',
            createdBy: 'attacker',
            id: 'victim-id'
        })

        bindWorkspaceCreateRequest(req)

        expect(req.body).toEqual({
            name: 'Safe',
            description: 'Description',
            organizationId: 'org-a',
            createdBy: 'admin-a',
            existingWorkspaceId: 'workspace-a'
        })
    })

    it('rejects workspace creation in another organization', () => {
        expect(() => bindWorkspaceCreateRequest(request(admin, { name: 'Cross tenant', organizationId: 'org-b' }))).toThrow('Forbidden')
    })

    it('does not let an assigned-workspace membership reuse active-workspace update permission', async () => {
        const req = request(member, { id: 'workspace-b', name: 'Forged', updatedBy: 'attacker' })
        const queryRunner = runner({
            findOneBy: jest.fn().mockResolvedValue({ id: 'workspace-b', organizationId: 'org-a' })
        })

        await expect(bindWorkspaceUpdateRequest(req, queryRunner)).rejects.toThrow('Forbidden')
    })

    it('binds an active-workspace update to a session identity and allowlisted fields', async () => {
        const req = request(member, { id: 'workspace-a', name: 'Updated', organizationId: 'org-b', updatedBy: 'attacker' })
        const queryRunner = runner({
            findOneBy: jest.fn().mockResolvedValue({ id: 'workspace-a', organizationId: 'org-a' })
        })

        await bindWorkspaceUpdateRequest(req, queryRunner)

        expect(req.body).toEqual({ id: 'workspace-a', name: 'Updated', description: undefined, updatedBy: 'member-a' })
    })

    it('does not allow a reserved system workspace to be renamed before deletion', async () => {
        const req = request(admin, { id: 'workspace-b', name: 'Ordinary workspace' })
        const queryRunner = runner({
            findOneBy: jest.fn().mockResolvedValue({ id: 'workspace-b', name: 'Default Workspace', organizationId: 'org-a' })
        })

        await expect(bindWorkspaceUpdateRequest(req, queryRunner)).rejects.toThrow('Forbidden')
    })

    it('rejects delete of an active, default, non-admin, or foreign workspace', async () => {
        const cases = [
            { user: admin, workspace: { id: 'workspace-a', name: 'Active', organizationId: 'org-a' } },
            { user: admin, workspace: { id: 'workspace-b', name: 'Default Workspace', organizationId: 'org-a' } },
            { user: member, workspace: { id: 'workspace-b', name: 'Other', organizationId: 'org-a' } },
            { user: admin, workspace: { id: 'workspace-b', name: 'Other', organizationId: 'org-b' } }
        ]

        for (const item of cases) {
            const req = request(item.user, {}, { id: item.workspace.id })
            const queryRunner = runner({ findOneBy: jest.fn().mockResolvedValue(item.workspace) })
            await expect(assertWorkspaceDeleteRequest(req, queryRunner)).rejects.toThrow('Forbidden')
        }
    })

    it('allows an organization admin to delete an ordinary inactive workspace in the active organization', async () => {
        const workspace = { id: 'workspace-b', name: 'Disposable', organizationId: 'org-a' }
        const req = request(admin, {}, { id: workspace.id })
        const queryRunner = runner({ findOneBy: jest.fn().mockResolvedValue(workspace) })

        await expect(assertWorkspaceDeleteRequest(req, queryRunner)).resolves.toBe(workspace)
    })

    it('requires a recognized share item type', () => {
        expect(() => readWorkspaceShareItemType('chatflow')).toThrow()
        expect(readWorkspaceShareItemType('credential')).toBe('credential')
    })

    it('rejects sharing a foreign source item before looking up target workspaces', async () => {
        const req = request(member)
        const findOneBy = jest.fn().mockResolvedValue(null)
        const findBy = jest.fn()
        const queryRunner = runner({ findOneBy, findBy })

        await expect(validateWorkspaceShareRequest(req, 'credential-b', 'credential', ['workspace-b'], queryRunner)).rejects.toThrow(
            'Forbidden'
        )
        expect(findOneBy).toHaveBeenCalledWith(Credential, { id: 'credential-b', workspaceId: 'workspace-a' })
        expect(findBy).not.toHaveBeenCalled()
    })

    it('rejects a cross-organization share target and deduplicates valid targets', async () => {
        const req = request(admin)
        const findOneBy = jest.fn().mockResolvedValue({ id: 'credential-a', workspaceId: 'workspace-a' })
        const findBy = jest
            .fn()
            .mockResolvedValueOnce([{ id: 'workspace-b', organizationId: 'org-b' }])
            .mockResolvedValueOnce([{ id: 'workspace-b', organizationId: 'org-a' }])
        const queryRunner = runner({ findOneBy, findBy })

        await expect(validateWorkspaceShareRequest(req, 'credential-a', 'credential', ['workspace-b'], queryRunner)).rejects.toThrow(
            'Forbidden'
        )
        await expect(
            validateWorkspaceShareRequest(req, 'credential-a', 'credential', ['workspace-b', 'workspace-b'], queryRunner)
        ).resolves.toEqual(['workspace-b'])
        expect(findBy).toHaveBeenCalledWith(Workspace, expect.objectContaining({ id: expect.anything() }))
    })
})
