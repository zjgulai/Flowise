import { AES } from 'crypto-js'
import { decryptCredentialData, getCredentialData } from './utils'

const CredentialEntity = class CredentialEntity {}
const WorkspaceSharedEntity = class WorkspaceSharedEntity {}
const ENCRYPTION_KEY = 'unit-test-encryption-key'

const encryptedData = AES.encrypt(JSON.stringify({ apiKey: 'decrypted-test-value' }), ENCRYPTION_KEY).toString()
const credential = { id: 'credential-1', workspaceId: 'workspace-owner', encryptedData }

const buildOptions = ({ workspaceId, ownedCredential = credential, sharedRecord = null, sharedCredential = credential } = {} as any) => {
    const credentialRepository = {
        findOneBy: jest.fn(async (where: Record<string, string>) => {
            if (where.workspaceId) return ownedCredential
            return sharedCredential
        })
    }
    const sharedRepository = {
        findOneBy: jest.fn(async () => sharedRecord)
    }
    const getRepository = jest.fn((entity) => {
        if (entity === CredentialEntity) return credentialRepository
        if (entity === WorkspaceSharedEntity) return sharedRepository
        throw new Error('Unexpected entity')
    })

    return {
        options: {
            appDataSource: { getRepository },
            databaseEntities: {
                Credential: CredentialEntity,
                WorkspaceShared: WorkspaceSharedEntity
            },
            ...(workspaceId ? { workspaceId } : {})
        },
        credentialRepository,
        sharedRepository
    }
}

describe('getCredentialData workspace authorization', () => {
    const previousEncryptionKey = process.env.FLOWISE_SECRETKEY_OVERWRITE

    beforeAll(() => {
        process.env.FLOWISE_SECRETKEY_OVERWRITE = ENCRYPTION_KEY
    })

    afterAll(() => {
        if (previousEncryptionKey === undefined) delete process.env.FLOWISE_SECRETKEY_OVERWRITE
        else process.env.FLOWISE_SECRETKEY_OVERWRITE = previousEncryptionKey
    })

    it('decrypts a credential owned by the active workspace', async () => {
        const { options, credentialRepository, sharedRepository } = buildOptions({ workspaceId: 'workspace-owner' })

        await expect(getCredentialData('credential-1', options)).resolves.toEqual({ apiKey: 'decrypted-test-value' })
        expect(credentialRepository.findOneBy).toHaveBeenCalledWith({ id: 'credential-1', workspaceId: 'workspace-owner' })
        expect(sharedRepository.findOneBy).not.toHaveBeenCalled()
    })

    it('decrypts a credential explicitly shared with the active workspace', async () => {
        const { options, credentialRepository, sharedRepository } = buildOptions({
            workspaceId: 'workspace-shared',
            ownedCredential: null,
            sharedRecord: { workspaceId: 'workspace-shared', sharedItemId: 'credential-1', itemType: 'credential' }
        })

        await expect(getCredentialData('credential-1', options)).resolves.toEqual({ apiKey: 'decrypted-test-value' })
        expect(sharedRepository.findOneBy).toHaveBeenCalledWith({
            workspaceId: 'workspace-shared',
            sharedItemId: 'credential-1',
            itemType: 'credential'
        })
        expect(credentialRepository.findOneBy).toHaveBeenLastCalledWith({ id: 'credential-1' })
    })

    it('fails closed immediately after a credential share is revoked', async () => {
        const { options, credentialRepository, sharedRepository } = buildOptions({
            workspaceId: 'workspace-shared',
            ownedCredential: null,
            sharedRecord: { workspaceId: 'workspace-shared', sharedItemId: 'credential-1', itemType: 'credential' }
        })

        await expect(getCredentialData('credential-1', options)).resolves.toEqual({ apiKey: 'decrypted-test-value' })
        sharedRepository.findOneBy.mockResolvedValue(null)
        credentialRepository.findOneBy.mockImplementation(async (where: Record<string, string>) => (where.workspaceId ? null : credential))

        await expect(getCredentialData('credential-1', options)).rejects.toThrow('Credential is not available in this workspace')
    })

    it('does not reveal whether a cross-workspace credential exists', async () => {
        const { options, credentialRepository } = buildOptions({
            workspaceId: 'workspace-attacker',
            ownedCredential: null,
            sharedRecord: null,
            sharedCredential: credential
        })

        await expect(getCredentialData('credential-secret-id', options)).rejects.toThrow('Credential is not available in this workspace')
        expect(credentialRepository.findOneBy).toHaveBeenCalledTimes(1)
        expect(credentialRepository.findOneBy).not.toHaveBeenCalledWith({ id: 'credential-secret-id' })
    })

    it('fails closed without a workspace before reading any credential record', async () => {
        const { options, credentialRepository, sharedRepository } = buildOptions()

        await expect(getCredentialData('credential-1', options)).rejects.toThrow('Credential is not available in this workspace')
        expect(credentialRepository.findOneBy).not.toHaveBeenCalled()
        expect(sharedRepository.findOneBy).not.toHaveBeenCalled()
    })

    it('fails closed when a scoped caller omits the WorkspaceShared entity', async () => {
        const { options } = buildOptions({ workspaceId: 'workspace-shared', ownedCredential: null })
        delete (options.databaseEntities as Record<string, unknown>).WorkspaceShared

        await expect(getCredentialData('credential-1', options)).rejects.toThrow('Credential is not available in this workspace')
    })

    it('does not log decrypted plaintext when credential JSON is malformed', async () => {
        const malformedCiphertext = AES.encrypt('not-json-secret-plaintext', ENCRYPTION_KEY).toString()
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)

        await expect(decryptCredentialData(malformedCiphertext)).rejects.toThrow('Credentials could not be decrypted.')
        expect(consoleError).not.toHaveBeenCalled()

        consoleError.mockRestore()
    })
})
