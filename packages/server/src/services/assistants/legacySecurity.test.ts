import { StatusCodes } from 'http-status-codes'
import { In } from 'typeorm'
import { Assistant } from '../../database/entities/Assistant'
import { Credential } from '../../database/entities/Credential'
import { WorkspaceShared } from '../../enterprise/database/entities/EnterpriseEntities'

const mockProviderDelete = jest.fn()
const mockProviderRetrieve = jest.fn()
const mockProviderUpdate = jest.fn()
const mockDecryptCredentialData = jest.fn()
const mockGetRunningExpressApp = jest.fn()
const mockCheckUsageLimit = jest.fn()
const mockLoggerError = jest.fn()
const mockTelemetry = jest.fn()
const mockIncrementCounter = jest.fn()

jest.mock('openai', () => {
    const OpenAIMock = jest.fn().mockImplementation(() => ({
        beta: {
            assistants: {
                delete: (...args: unknown[]) => mockProviderDelete(...args),
                retrieve: (...args: unknown[]) => mockProviderRetrieve(...args),
                update: (...args: unknown[]) => mockProviderUpdate(...args)
            }
        }
    }))
    return { __esModule: true, default: OpenAIMock, OpenAI: OpenAIMock }
})

jest.mock('flowise-components', () => ({
    extractResponseContent: jest.fn()
}))

jest.mock('../../utils', () => ({
    databaseEntities: {},
    decryptCredentialData: (...args: unknown[]) => mockDecryptCredentialData(...args),
    getAppVersion: jest.fn().mockResolvedValue('test')
}))

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => mockGetRunningExpressApp()
}))

jest.mock('../../utils/quotaUsage', () => ({
    checkUsageLimit: (...args: unknown[]) => mockCheckUsageLimit(...args)
}))

jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: { error: (...args: unknown[]) => mockLoggerError(...args) }
}))

jest.mock('../nodes', () => ({
    __esModule: true,
    default: { getAllNodesForCategory: jest.fn() }
}))

jest.mock('./customAssistantSave', () => ({
    getCustomAssistantFlow: jest.fn(),
    saveCustomAssistant: jest.fn()
}))

import assistantsService from '.'

const ASSISTANT_ID = '11111111-1111-4111-8111-111111111111'
const PROVIDER_ID = 'asst_provider_1'
const CREDENTIAL_ID = '22222222-2222-4222-8222-222222222222'
const WORKSPACE_ID = 'workspace-1'

const makeAssistant = (overrides: Partial<Assistant> = {}): Assistant =>
    ({
        id: ASSISTANT_ID,
        type: 'OPENAI',
        credential: CREDENTIAL_ID,
        details: JSON.stringify({ id: PROVIDER_ID, name: 'Legacy assistant' }),
        workspaceId: WORKSPACE_ID,
        ...overrides
    } as Assistant)

describe('legacy assistant service security boundaries', () => {
    const assistantRepository = {
        create: jest.fn(),
        save: jest.fn(),
        findOneBy: jest.fn(),
        findBy: jest.fn(),
        delete: jest.fn(),
        insert: jest.fn()
    }
    const credentialRepository = { findOneBy: jest.fn() }
    const sharedRepository = { findOneBy: jest.fn() }

    beforeEach(() => {
        jest.clearAllMocks()
        assistantRepository.create.mockImplementation((value) => value)
        assistantRepository.save.mockImplementation(async (value) => value)
        assistantRepository.findBy.mockResolvedValue([])
        assistantRepository.delete.mockResolvedValue({ affected: 1, raw: [] })
        assistantRepository.insert.mockResolvedValue({ identifiers: [] })
        credentialRepository.findOneBy.mockResolvedValue({ id: CREDENTIAL_ID, encryptedData: 'encrypted', workspaceId: WORKSPACE_ID })
        sharedRepository.findOneBy.mockResolvedValue(null)
        mockDecryptCredentialData.mockResolvedValue({ openAIApiKey: 'test-key' })
        mockCheckUsageLimit.mockResolvedValue(undefined)
        mockTelemetry.mockResolvedValue(undefined)
        mockIncrementCounter.mockReturnValue(undefined)
        mockProviderDelete.mockResolvedValue({ id: PROVIDER_ID, deleted: true })
        mockProviderRetrieve.mockResolvedValue({
            id: PROVIDER_ID,
            name: 'Before',
            description: 'Before description',
            instructions: 'Before instructions',
            model: 'gpt-before',
            tools: [],
            tool_resources: {},
            temperature: 0.5,
            top_p: 0.8
        })
        mockProviderUpdate.mockResolvedValue({ id: PROVIDER_ID })
        mockGetRunningExpressApp.mockReturnValue({
            AppDataSource: {
                getRepository: (entity: unknown) => {
                    if (entity === Assistant) return assistantRepository
                    if (entity === Credential) return credentialRepository
                    if (entity === WorkspaceShared) return sharedRepository
                    throw new Error('unexpected repository')
                }
            },
            usageCacheManager: {},
            telemetry: { sendTelemetry: (...args: unknown[]) => mockTelemetry(...args) },
            metricsProvider: { incrementCounter: (...args: unknown[]) => mockIncrementCounter(...args) }
        })
    })

    it('does not reverse a persisted custom assistant when telemetry and metrics fail', async () => {
        const persisted = makeAssistant({ type: 'CUSTOM', details: '{"name":"Persisted"}' })
        assistantRepository.save.mockResolvedValueOnce(persisted)
        mockTelemetry.mockRejectedValueOnce(new Error('telemetry secret'))
        mockIncrementCounter.mockImplementationOnce(() => {
            throw new Error('metrics secret')
        })

        await expect(
            assistantsService.createAssistant({ type: 'CUSTOM', details: '{"name":"Persisted"}' }, 'organization-1', WORKSPACE_ID)
        ).resolves.toBe(persisted)

        expect(assistantRepository.save).toHaveBeenCalledTimes(1)
        expect(mockLoggerError).toHaveBeenCalledWith('[server]: Assistant create observability failed', {
            failedCount: 2,
            totalCount: 2
        })
        expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain('telemetry secret')
        expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain('metrics secret')
    })

    it.each([
        ['create', () => assistantsService.createAssistant({ type: 'OPENAI' }, 'organization-1', WORKSPACE_ID)],
        ['import', () => assistantsService.importAssistants([{ type: 'OPENAI' }], 'organization-1', WORKSPACE_ID, 'subscription-1')],
        ['create Azure', () => assistantsService.createAssistant({ type: 'AZURE' }, 'organization-1', WORKSPACE_ID)],
        ['import Azure', () => assistantsService.importAssistants([{ type: 'AZURE' }], 'organization-1', WORKSPACE_ID, 'subscription-1')]
    ])('rejects legacy provider-backed %s before app, quota, database, or Provider access', async (_operation, invoke) => {
        await expect(invoke()).rejects.toMatchObject({ statusCode: StatusCodes.GONE })
        expect(mockGetRunningExpressApp).not.toHaveBeenCalled()
        expect(mockCheckUsageLimit).not.toHaveBeenCalled()
        expect(mockProviderUpdate).not.toHaveBeenCalled()
        expect(mockProviderDelete).not.toHaveBeenCalled()
    })

    it('rejects unknown import types before app, quota, or database access', async () => {
        await expect(
            assistantsService.importAssistants([{ type: 'UNKNOWN' as never }], 'organization-1', WORKSPACE_ID, 'subscription-1')
        ).rejects.toMatchObject({ statusCode: StatusCodes.BAD_REQUEST })
        expect(mockGetRunningExpressApp).not.toHaveBeenCalled()
        expect(mockCheckUsageLimit).not.toHaveBeenCalled()
        expect(assistantRepository.insert).not.toHaveBeenCalled()
    })

    it('rejects malicious imported IDs before constructing a database query', async () => {
        await expect(
            assistantsService.importAssistants(
                [{ id: "abc') OR 1=1 --", type: 'CUSTOM' }],
                'organization-1',
                WORKSPACE_ID,
                'subscription-1'
            )
        ).rejects.toMatchObject({ statusCode: StatusCodes.BAD_REQUEST })
        expect(mockGetRunningExpressApp).not.toHaveBeenCalled()
        expect(assistantRepository.findBy).not.toHaveBeenCalled()
        expect(assistantRepository.insert).not.toHaveBeenCalled()
    })

    it('parameterizes valid import IDs, preserves them, strips protected fields, and forces the active workspace', async () => {
        const source = {
            id: ASSISTANT_ID,
            type: 'CUSTOM' as const,
            details: '{"name":"Imported"}',
            credential: CREDENTIAL_ID,
            workspaceId: 'attacker-workspace',
            createdDate: new Date('2020-01-01')
        }

        await assistantsService.importAssistants([source], 'organization-1', WORKSPACE_ID, 'subscription-1')

        expect(assistantRepository.findBy).toHaveBeenCalledWith({ id: In([ASSISTANT_ID]), workspaceId: WORKSPACE_ID })
        expect(assistantRepository.insert).toHaveBeenCalledWith([
            {
                id: ASSISTANT_ID,
                type: 'CUSTOM',
                details: '{"name":"Imported"}',
                credential: CREDENTIAL_ID,
                workspaceId: WORKSPACE_ID
            }
        ])
        expect(source.workspaceId).toBe('attacker-workspace')
    })

    it('rejects a credential switch before credential decryption or Provider access', async () => {
        assistantRepository.findOneBy.mockResolvedValue(makeAssistant())

        await expect(
            assistantsService.updateAssistant(
                ASSISTANT_ID,
                { credential: '33333333-3333-4333-8333-333333333333', details: '{"name":"Changed"}' },
                WORKSPACE_ID
            )
        ).rejects.toMatchObject({ statusCode: StatusCodes.BAD_REQUEST })

        expect(mockDecryptCredentialData).not.toHaveBeenCalled()
        expect(mockProviderRetrieve).not.toHaveBeenCalled()
        expect(mockProviderUpdate).not.toHaveBeenCalled()
    })

    it('rejects a type switch before credential decryption or Provider access', async () => {
        assistantRepository.findOneBy.mockResolvedValue(makeAssistant())

        await expect(
            assistantsService.updateAssistant(
                ASSISTANT_ID,
                { type: 'CUSTOM', credential: CREDENTIAL_ID, details: '{"name":"Changed"}' },
                WORKSPACE_ID
            )
        ).rejects.toMatchObject({ statusCode: StatusCodes.BAD_REQUEST })

        expect(mockDecryptCredentialData).not.toHaveBeenCalled()
        expect(mockProviderRetrieve).not.toHaveBeenCalled()
        expect(mockProviderUpdate).not.toHaveBeenCalled()
    })

    it('rejects generic CUSTOM updates before details, credential, or persistence side effects', async () => {
        assistantRepository.findOneBy.mockResolvedValue(
            makeAssistant({
                type: 'CUSTOM',
                credential: '',
                details: JSON.stringify({ name: 'Custom', flowId: '44444444-4444-4444-8444-444444444444' })
            })
        )

        await expect(
            assistantsService.updateAssistant(
                ASSISTANT_ID,
                { details: JSON.stringify({ name: 'Changed', flowId: '55555555-5555-4555-8555-555555555555' }) },
                WORKSPACE_ID
            )
        ).rejects.toMatchObject({
            statusCode: StatusCodes.CONFLICT,
            message: 'Custom assistants must be updated through the snapshot-bound custom save endpoint'
        })

        expect(assistantRepository.save).not.toHaveBeenCalled()
        expect(credentialRepository.findOneBy).not.toHaveBeenCalled()
        expect(mockDecryptCredentialData).not.toHaveBeenCalled()
        expect(mockProviderRetrieve).not.toHaveBeenCalled()
        expect(mockProviderUpdate).not.toHaveBeenCalled()
    })

    it('keeps custom deletion constrained to the active workspace and type', async () => {
        assistantRepository.findOneBy.mockResolvedValue(makeAssistant({ type: 'CUSTOM' }))

        await assistantsService.deleteAssistant(ASSISTANT_ID, false, WORKSPACE_ID)

        expect(assistantRepository.delete).toHaveBeenCalledWith({ id: ASSISTANT_ID, workspaceId: WORKSPACE_ID, type: 'CUSTOM' })
        expect(mockProviderDelete).not.toHaveBeenCalled()
    })

    it('fails closed before deleting either side of a linked custom assistant', async () => {
        assistantRepository.findOneBy.mockResolvedValue(
            makeAssistant({ type: 'CUSTOM', details: JSON.stringify({ name: 'Linked', flowId: '44444444-4444-4444-8444-444444444444' }) })
        )

        await expect(assistantsService.deleteAssistant(ASSISTANT_ID, false, WORKSPACE_ID)).rejects.toMatchObject({
            statusCode: StatusCodes.CONFLICT,
            message: 'Linked custom assistants must be deleted through the custom assistant endpoint'
        })

        expect(assistantRepository.delete).not.toHaveBeenCalled()
        expect(mockProviderDelete).not.toHaveBeenCalled()
    })

    it('fails closed on malformed custom assistant details before deletion', async () => {
        assistantRepository.findOneBy.mockResolvedValue(makeAssistant({ type: 'CUSTOM', details: '{not-json' }))

        await expect(assistantsService.deleteAssistant(ASSISTANT_ID, false, WORKSPACE_ID)).rejects.toMatchObject({
            statusCode: StatusCodes.PRECONDITION_FAILED,
            message: 'Stored assistant details are invalid'
        })

        expect(assistantRepository.delete).not.toHaveBeenCalled()
    })

    it.each([
        ['CUSTOM', false],
        ['OPENAI', false]
    ])('fails closed when a %s local-only delete loses its compare-and-delete race', async (type, isDeleteBoth) => {
        assistantRepository.findOneBy.mockResolvedValue(makeAssistant({ type: type as Assistant['type'] }))
        assistantRepository.delete.mockResolvedValue({ affected: 0, raw: [] })

        await expect(assistantsService.deleteAssistant(ASSISTANT_ID, isDeleteBoth, WORKSPACE_ID)).rejects.toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            message: 'Unable to delete assistant'
        })
        expect(mockProviderDelete).not.toHaveBeenCalled()
    })

    it('deletes at the Provider before the workspace-scoped local row and validates the exact Provider response', async () => {
        assistantRepository.findOneBy.mockResolvedValue(makeAssistant())

        await expect(assistantsService.deleteAssistant(ASSISTANT_ID, true, WORKSPACE_ID)).resolves.toMatchObject({ affected: 1 })

        expect(assistantRepository.findOneBy).toHaveBeenCalledWith({ id: ASSISTANT_ID, workspaceId: WORKSPACE_ID })
        expect(credentialRepository.findOneBy).toHaveBeenCalledWith({ id: CREDENTIAL_ID, workspaceId: WORKSPACE_ID })
        expect(mockProviderDelete).toHaveBeenCalledWith(PROVIDER_ID)
        expect(assistantRepository.delete).toHaveBeenCalledWith({
            id: ASSISTANT_ID,
            workspaceId: WORKSPACE_ID,
            type: 'OPENAI',
            credential: CREDENTIAL_ID,
            details: JSON.stringify({ id: PROVIDER_ID, name: 'Legacy assistant' })
        })
        expect(mockProviderDelete.mock.invocationCallOrder[0]).toBeLessThan(assistantRepository.delete.mock.invocationCallOrder[0])
    })

    it('does not delete locally when the Provider response is not an exact successful deletion', async () => {
        assistantRepository.findOneBy.mockResolvedValue(makeAssistant())
        mockProviderDelete.mockResolvedValue({ id: 'unexpected', deleted: true })

        await expect(assistantsService.deleteAssistant(ASSISTANT_ID, true, WORKSPACE_ID)).rejects.toMatchObject({
            statusCode: StatusCodes.INTERNAL_SERVER_ERROR,
            message: 'Unable to delete assistant'
        })
        expect(assistantRepository.delete).not.toHaveBeenCalled()
    })

    it('redacts raw Provider deletion failures', async () => {
        assistantRepository.findOneBy.mockResolvedValue(makeAssistant())
        mockProviderDelete.mockRejectedValue(new Error('provider secret sk-live-delete'))

        const error = await assistantsService.deleteAssistant(ASSISTANT_ID, true, WORKSPACE_ID).catch((caught) => caught)

        expect(error).toMatchObject({ statusCode: StatusCodes.INTERNAL_SERVER_ERROR, message: 'Unable to delete assistant' })
        expect(error.message).not.toContain('sk-live-delete')
        expect(assistantRepository.delete).not.toHaveBeenCalled()
    })

    it('supports a workspace-shared bound credential without accepting an unrelated credential', async () => {
        assistantRepository.findOneBy.mockResolvedValue(makeAssistant())
        credentialRepository.findOneBy.mockResolvedValueOnce(null).mockResolvedValueOnce({
            id: CREDENTIAL_ID,
            encryptedData: 'shared-encrypted',
            workspaceId: 'owner-workspace'
        })
        sharedRepository.findOneBy.mockResolvedValue({
            workspaceId: WORKSPACE_ID,
            sharedItemId: CREDENTIAL_ID,
            itemType: 'credential'
        })

        await assistantsService.deleteAssistant(ASSISTANT_ID, true, WORKSPACE_ID)

        expect(sharedRepository.findOneBy).toHaveBeenCalledWith({
            workspaceId: WORKSPACE_ID,
            sharedItemId: CREDENTIAL_ID,
            itemType: 'credential'
        })
        expect(mockProviderDelete).toHaveBeenCalledWith(PROVIDER_ID)
    })

    it('treats false deletion as local-only and never resolves credentials or calls the Provider', async () => {
        assistantRepository.findOneBy.mockResolvedValue(makeAssistant())

        await assistantsService.deleteAssistant(ASSISTANT_ID, false, WORKSPACE_ID)

        expect(assistantRepository.delete).toHaveBeenCalledWith({
            id: ASSISTANT_ID,
            workspaceId: WORKSPACE_ID,
            type: 'OPENAI',
            credential: CREDENTIAL_ID,
            details: JSON.stringify({ id: PROVIDER_ID, name: 'Legacy assistant' })
        })
        expect(credentialRepository.findOneBy).not.toHaveBeenCalled()
        expect(mockProviderDelete).not.toHaveBeenCalled()
    })

    it('rejects non-boolean direct service deletion flags before app or Provider access', async () => {
        await expect(assistantsService.deleteAssistant(ASSISTANT_ID, 'false' as unknown as boolean, WORKSPACE_ID)).rejects.toMatchObject({
            statusCode: StatusCodes.BAD_REQUEST
        })
        expect(mockGetRunningExpressApp).not.toHaveBeenCalled()
        expect(mockProviderDelete).not.toHaveBeenCalled()
    })

    it('compensates the Provider when local persistence fails and emits only aggregate audit data', async () => {
        assistantRepository.findOneBy.mockResolvedValue(makeAssistant())
        assistantRepository.save.mockRejectedValue(new Error('database secret db-internal-1'))

        const error = await assistantsService
            .updateAssistant(
                ASSISTANT_ID,
                {
                    credential: CREDENTIAL_ID,
                    details: JSON.stringify({ id: PROVIDER_ID, name: 'After', model: 'gpt-after', tools: [] })
                },
                WORKSPACE_ID
            )
            .catch((caught) => caught)

        expect(error).toMatchObject({ statusCode: StatusCodes.INTERNAL_SERVER_ERROR, message: 'Unable to update assistant' })
        expect(mockProviderUpdate).toHaveBeenCalledTimes(2)
        expect(mockProviderUpdate.mock.calls[0][0]).toBe(PROVIDER_ID)
        expect(mockProviderUpdate.mock.calls[1][0]).toBe(PROVIDER_ID)
        expect(mockProviderUpdate.mock.calls[1][1]).toMatchObject({ name: 'Before', model: 'gpt-before' })
        expect(mockLoggerError).toHaveBeenCalledWith(
            '[server]: OpenAI assistant update database persistence failed',
            expect.objectContaining({
                providerUpdatesSucceeded: 1,
                databaseUpdatesSucceeded: 0,
                compensationsAttempted: 1,
                compensationsSucceeded: 1
            })
        )
        const serializedLog = JSON.stringify(mockLoggerError.mock.calls)
        expect(serializedLog).not.toContain(PROVIDER_ID)
        expect(serializedLog).not.toContain('db-internal-1')
        expect(serializedLog).not.toContain('test-key')
    })

    it('redacts raw Provider update failures and does not persist locally', async () => {
        assistantRepository.findOneBy.mockResolvedValue(makeAssistant())
        mockProviderUpdate.mockRejectedValueOnce(new Error('provider secret sk-live-update'))

        const error = await assistantsService
            .updateAssistant(
                ASSISTANT_ID,
                { credential: CREDENTIAL_ID, details: JSON.stringify({ id: PROVIDER_ID, name: 'After', tools: [] }) },
                WORKSPACE_ID
            )
            .catch((caught) => caught)

        expect(error).toMatchObject({ statusCode: StatusCodes.INTERNAL_SERVER_ERROR, message: 'Unable to update assistant' })
        expect(error.message).not.toContain('sk-live-update')
        expect(assistantRepository.save).not.toHaveBeenCalled()
    })

    it('records only aggregate state when Provider deletion succeeds but local deletion fails', async () => {
        assistantRepository.findOneBy.mockResolvedValue(makeAssistant())
        assistantRepository.delete.mockRejectedValue(new Error('database secret db-delete-1'))

        await expect(assistantsService.deleteAssistant(ASSISTANT_ID, true, WORKSPACE_ID)).rejects.toMatchObject({
            message: 'Unable to delete assistant'
        })
        expect(mockLoggerError).toHaveBeenCalledWith('[server]: OpenAI assistant delete reached a partial completion state', {
            providerDeletesSucceeded: 1,
            databaseDeletesSucceeded: 0
        })
        const serializedLog = JSON.stringify(mockLoggerError.mock.calls)
        expect(serializedLog).not.toContain(PROVIDER_ID)
        expect(serializedLog).not.toContain('db-delete-1')
        expect(serializedLog).not.toContain('test-key')
    })
})
