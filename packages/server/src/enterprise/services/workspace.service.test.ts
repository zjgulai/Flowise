import { Credential } from '../../database/entities/Credential'
import { GeneralSuccessMessage } from '../../utils/constants'
import { WorkspaceShared } from '../database/entities/EnterpriseEntities'
import { Workspace } from '../database/entities/workspace.entity'

const mockApp = { AppDataSource: {} as any, telemetry: {} }

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => mockApp
}))

import { WorkspaceService } from './workspace.service'

describe('WorkspaceService sharing transaction boundaries', () => {
    const buildService = (source: unknown, targets: unknown[]) => {
        const credentialRepository = { findOneBy: jest.fn().mockResolvedValue(source) }
        const workspaceRepository = { findBy: jest.fn().mockResolvedValue(targets) }
        const sharedRepository = {
            delete: jest.fn().mockResolvedValue({ affected: 0 }),
            create: jest.fn((value) => value),
            save: jest.fn().mockImplementation(async (value) => value)
        }
        const manager = {
            getRepository: jest.fn((entity) => {
                if (entity === Credential) return credentialRepository
                if (entity === Workspace) return workspaceRepository
                if (entity === WorkspaceShared) return sharedRepository
                throw new Error('Unexpected entity')
            })
        }
        const transaction = jest.fn(async (work) => work(manager))
        mockApp.AppDataSource = { transaction }

        return {
            service: new WorkspaceService(),
            credentialRepository,
            workspaceRepository,
            sharedRepository,
            transaction
        }
    }

    it('does not mutate shares when the source credential is outside the active workspace', async () => {
        const { service, workspaceRepository, sharedRepository } = buildService(null, [])

        await expect(
            service.setSharedWorkspacesForItem(
                'credential-b',
                { itemType: 'credential', workspaceIds: ['workspace-b'] },
                { sourceWorkspaceId: 'workspace-a', organizationId: 'org-a' }
            )
        ).rejects.toThrow('Forbidden')

        expect(workspaceRepository.findBy).not.toHaveBeenCalled()
        expect(sharedRepository.delete).not.toHaveBeenCalled()
        expect(sharedRepository.save).not.toHaveBeenCalled()
    })

    it('does not mutate shares when a target workspace is outside the active organization', async () => {
        const { service, sharedRepository } = buildService({ id: 'credential-a', workspaceId: 'workspace-a' }, [
            { id: 'workspace-b', organizationId: 'org-b' }
        ])

        await expect(
            service.setSharedWorkspacesForItem(
                'credential-a',
                { itemType: 'credential', workspaceIds: ['workspace-b'] },
                { sourceWorkspaceId: 'workspace-a', organizationId: 'org-a' }
            )
        ).rejects.toThrow('Forbidden')

        expect(sharedRepository.delete).not.toHaveBeenCalled()
        expect(sharedRepository.save).not.toHaveBeenCalled()
    })

    it('revalidates a legal source and targets, then replaces only the matching item type', async () => {
        const { service, sharedRepository } = buildService({ id: 'credential-a', workspaceId: 'workspace-a' }, [
            { id: 'workspace-b', organizationId: 'org-a' }
        ])

        await expect(
            service.setSharedWorkspacesForItem(
                'credential-a',
                { itemType: 'credential', workspaceIds: ['workspace-b', 'workspace-b'] },
                { sourceWorkspaceId: 'workspace-a', organizationId: 'org-a' }
            )
        ).resolves.toEqual({ message: GeneralSuccessMessage.UPDATED })

        expect(sharedRepository.delete).toHaveBeenCalledWith({ sharedItemId: 'credential-a', itemType: 'credential' })
        expect(sharedRepository.save).toHaveBeenCalledWith([
            { workspaceId: 'workspace-b', sharedItemId: 'credential-a', itemType: 'credential' }
        ])
    })
})
