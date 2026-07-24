import { Request } from 'express'
import { QueryRunner } from 'typeorm'
import { Workspace } from '../database/entities/workspace.entity'
import { bindOrganizationMembershipMutationRequest, bindWorkspaceMembershipMutationRequest } from './membershipMutationGuards'

const interactiveUser = {
    id: 'admin-a',
    activeOrganizationId: 'org-a',
    activeWorkspaceId: 'workspace-a',
    assignedWorkspaces: [{ id: 'workspace-a', organizationId: 'org-a', name: 'A', role: 'Owner' }],
    isOrganizationAdmin: true,
    permissions: ['users:manage', 'workspace:add-user', 'workspace:unlink-user']
}

const request = (method: string, body: Record<string, unknown> = {}, query: Record<string, unknown> = {}) =>
    ({ method, body, query, user: interactiveUser } as unknown as Request)

describe('membership mutation tenant guards', () => {
    it('rejects an organization mutation aimed at another tenant before binding audit fields', () => {
        const req = request('PUT', { organizationId: 'org-b', userId: 'victim', updatedBy: 'attacker' })

        expect(() => bindOrganizationMembershipMutationRequest(req)).toThrow('Forbidden')
        expect(req.body.updatedBy).toBe('attacker')
    })

    it('binds organization mutation identity and audit fields to the active session', () => {
        const req = request('POST', {
            organizationId: 'org-a',
            userId: 'member',
            roleId: 'member-role',
            status: 'active',
            createdBy: 'attacker',
            updatedBy: 'attacker',
            createdDate: 'forged',
            role: { permissions: '["admin"]' }
        })

        bindOrganizationMembershipMutationRequest(req)

        expect(req.body).toEqual({
            organizationId: 'org-a',
            userId: 'member',
            roleId: 'member-role',
            status: 'active',
            createdBy: 'admin-a'
        })
    })

    it('rejects a workspace mutation when the workspace belongs to another organization', async () => {
        const req = request('PUT', { workspaceId: 'workspace-b', userId: 'victim' })
        const queryRunner = {
            manager: { findOneBy: jest.fn().mockResolvedValue({ id: 'workspace-b', organizationId: 'org-b' }) }
        } as unknown as QueryRunner

        await expect(bindWorkspaceMembershipMutationRequest(req, queryRunner)).rejects.toThrow('Forbidden')
        expect(queryRunner.manager.findOneBy).toHaveBeenCalledWith(Workspace, { id: 'workspace-b' })
    })

    it('binds a same-tenant workspace mutation to the authenticated user', async () => {
        const req = request('PUT', {
            workspaceId: 'workspace-a',
            userId: 'member',
            roleId: 'role-a',
            status: 'active',
            updatedBy: 'attacker',
            createdBy: 'attacker',
            lastLogin: 'forged',
            updatedDate: 'forged'
        })
        const queryRunner = {
            manager: { findOneBy: jest.fn().mockResolvedValue({ id: 'workspace-a', organizationId: 'org-a' }) }
        } as unknown as QueryRunner

        await bindWorkspaceMembershipMutationRequest(req, queryRunner)

        expect(req.body).toEqual({
            workspaceId: 'workspace-a',
            userId: 'member',
            roleId: 'role-a',
            status: 'active',
            updatedBy: 'admin-a'
        })
    })
})
