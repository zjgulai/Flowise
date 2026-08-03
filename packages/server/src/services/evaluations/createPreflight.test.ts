import { ApiKey } from '../../database/entities/ApiKey'
import { Assistant } from '../../database/entities/Assistant'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { Dataset } from '../../database/entities/Dataset'
import { DatasetRow } from '../../database/entities/DatasetRow'
import { Evaluation } from '../../database/entities/Evaluation'
import { EvaluationRun } from '../../database/entities/EvaluationRun'
import { Evaluator } from '../../database/entities/Evaluator'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'

const mockRunEvaluations = jest.fn()
const mockAssertCredentialInWorkspace = jest.fn()
const mockEvaluationCreate = jest.fn()
const mockEvaluationSave = jest.fn()
const mockEvaluationFindOneBy = jest.fn()
const mockEvaluationRunCreate = jest.fn()
const mockEvaluationRunSave = jest.fn()
const mockDatasetFindOneBy = jest.fn()
const mockDatasetRowFind = jest.fn()
const mockChatFlowFind = jest.fn()
const mockAssistantFind = jest.fn()
const mockEvaluatorFind = jest.fn()
const mockApiKeyFindOneBy = jest.fn()
const mockSendTelemetry = jest.fn()
const mockLoggerWarn = jest.fn()
const mockLoggerError = jest.fn()

jest.mock('flowise-components', () => ({
    EvaluationRunner: class {
        runEvaluations(...args: unknown[]) {
            return mockRunEvaluations(...args)
        }
    }
}))
jest.mock('../../utils', () => ({ databaseEntities: {}, getAppVersion: jest.fn(async () => 'test-version') }))
jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))
jest.mock('../../utils/logger', () => ({
    __esModule: true,
    default: { warn: (...args: unknown[]) => mockLoggerWarn(...args), error: (...args: unknown[]) => mockLoggerError(...args) }
}))
jest.mock('../oauth2CredentialRefresh', () => ({ createWorkspaceOAuth2RefreshCapability: jest.fn() }))
jest.mock('../credentials', () => ({
    __esModule: true,
    default: { assertCredentialInWorkspace: (...args: unknown[]) => mockAssertCredentialInWorkspace(...args) }
}))

import evaluationsService from '.'

const mockGetRunningExpressApp = getRunningExpressApp as jest.Mock
const queryBuilder = {
    select: jest.fn(),
    addSelect: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    groupBy: jest.fn(),
    orderBy: jest.fn(),
    skip: jest.fn(),
    take: jest.fn(),
    getRawOne: jest.fn(),
    getRawMany: jest.fn()
}
for (const method of ['select', 'addSelect', 'where', 'andWhere', 'groupBy', 'orderBy', 'skip', 'take'] as const) {
    queryBuilder[method].mockReturnValue(queryBuilder)
}

const evaluationRepository = {
    create: mockEvaluationCreate,
    save: mockEvaluationSave,
    findOneBy: mockEvaluationFindOneBy,
    createQueryBuilder: jest.fn(() => queryBuilder)
}
const evaluationRunRepository = { create: mockEvaluationRunCreate, save: mockEvaluationRunSave }
const datasetRepository = { findOneBy: mockDatasetFindOneBy }
const datasetRowRepository = { find: mockDatasetRowFind }
const chatFlowRepository = { find: mockChatFlowFind }
const assistantRepository = { find: mockAssistantFind }
const evaluatorRepository = { find: mockEvaluatorFind }
const apiKeyRepository = { findOneBy: mockApiKeyFindOneBy }

const safeComponent = {
    name: 'evaluationModel',
    category: 'Chat Models',
    baseClasses: ['BaseChatModel'],
    credential: { name: 'credential', type: 'credential', credentialNames: ['providerCredential'] },
    filePath: 'unused-evaluation-model',
    inputs: [{ name: 'modelName', type: 'asyncOptions' }]
}

const validBody = () => ({
    name: 'Evaluation',
    evaluationType: 'llm',
    credentialId: 'credential-1',
    datasetId: 'dataset-1',
    datasetName: 'Dataset',
    chatflowId: JSON.stringify(['chatflow-1']),
    chatflowName: JSON.stringify(['Chatflow']),
    chatflowType: JSON.stringify(['Chatflow']),
    selectedSimpleEvaluators: '',
    selectedLLMEvaluators: JSON.stringify(['evaluator-1']),
    llm: 'evaluationModel',
    model: 'model-1',
    datasetAsOneConversation: false
})
const flushAsyncWork = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('evaluation create preflight', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        for (const method of ['select', 'addSelect', 'where', 'andWhere', 'groupBy', 'orderBy', 'skip', 'take'] as const) {
            queryBuilder[method].mockReturnValue(queryBuilder)
        }
        queryBuilder.getRawOne.mockResolvedValue({ count: '0' })
        queryBuilder.getRawMany.mockResolvedValue([])
        mockAssertCredentialInWorkspace.mockResolvedValue(undefined)
        mockDatasetFindOneBy.mockResolvedValue({ id: 'dataset-1', workspaceId: 'workspace-1', name: 'Canonical Dataset' })
        mockDatasetRowFind.mockResolvedValue([])
        mockChatFlowFind.mockResolvedValue([{ id: 'chatflow-1', name: 'Canonical Chatflow', workspaceId: 'workspace-1', type: 'CHATFLOW' }])
        mockAssistantFind.mockResolvedValue([])
        mockEvaluatorFind.mockResolvedValue([{ id: 'evaluator-1', workspaceId: 'workspace-1', type: 'llm' }])
        mockEvaluationCreate.mockImplementation((evaluation) => evaluation)
        mockEvaluationSave.mockImplementation(async (evaluation) => ({ ...evaluation, id: 'evaluation-1' }))
        mockEvaluationFindOneBy.mockResolvedValue({ id: 'evaluation-1', workspaceId: 'workspace-1' })
        mockEvaluationRunCreate.mockImplementation((evaluationRun) => evaluationRun)
        mockEvaluationRunSave.mockImplementation(async (evaluationRun) => evaluationRun)
        mockSendTelemetry.mockResolvedValue(undefined)
        mockRunEvaluations.mockReturnValue(new Promise(() => undefined))
        mockGetRunningExpressApp.mockReturnValue({
            AppDataSource: {
                getRepository: (entity: unknown) => {
                    if (entity === Evaluation) return evaluationRepository
                    if (entity === EvaluationRun) return evaluationRunRepository
                    if (entity === Dataset) return datasetRepository
                    if (entity === DatasetRow) return datasetRowRepository
                    if (entity === ChatFlow) return chatFlowRepository
                    if (entity === Assistant) return assistantRepository
                    if (entity === Evaluator) return evaluatorRepository
                    if (entity === ApiKey) return apiKeyRepository
                    throw new Error('Unexpected repository')
                }
            },
            nodesPool: { componentNodes: { evaluationModel: { ...safeComponent } } },
            telemetry: { sendTelemetry: mockSendTelemetry }
        })
    })

    const expectNoCreateSideEffects = () => {
        expect(mockEvaluationSave).not.toHaveBeenCalled()
        expect(mockSendTelemetry).not.toHaveBeenCalled()
        expect(mockRunEvaluations).not.toHaveBeenCalled()
    }

    it.each([
        ['unknown evaluation type', { evaluationType: 'provider' }],
        ['malformed chatflow JSON', { chatflowId: '{' }],
        ['mismatched flow metadata lengths', { chatflowType: JSON.stringify([]) }],
        ['too many flow references', { chatflowId: JSON.stringify(Array.from({ length: 101 }, (_, index) => `flow-${index}`)) }]
    ])('rejects %s before database, telemetry, or provider execution', async (_label, override) => {
        await expect(
            evaluationsService.createEvaluation(
                { ...validBody(), ...override },
                'https://flowise.example.test',
                'organization-1',
                'workspace-1'
            )
        ).rejects.toMatchObject({ statusCode: 400 })

        expectNoCreateSideEffects()
    })

    it('rejects a cross-workspace dataset before save, telemetry, or provider execution', async () => {
        mockDatasetFindOneBy.mockResolvedValue(null)

        await expect(
            evaluationsService.createEvaluation(validBody(), 'https://flowise.example.test', 'organization-1', 'workspace-1')
        ).rejects.toMatchObject({ statusCode: 404 })

        expect(mockDatasetFindOneBy).toHaveBeenCalledWith({ id: 'dataset-1', workspaceId: 'workspace-1' })
        expectNoCreateSideEffects()
    })

    it('requires every flow ID to resolve in the active workspace', async () => {
        const body = validBody()
        body.chatflowId = JSON.stringify(['chatflow-1', 'chatflow-2'])
        body.chatflowName = JSON.stringify(['Chatflow 1', 'Chatflow 2'])
        body.chatflowType = JSON.stringify(['Chatflow', 'Chatflow'])

        await expect(
            evaluationsService.createEvaluation(body, 'https://flowise.example.test', 'organization-1', 'workspace-1')
        ).rejects.toMatchObject({ statusCode: 404 })

        expect(mockChatFlowFind.mock.calls[0][0].where.workspaceId).toBe('workspace-1')
        expect(mockChatFlowFind.mock.calls[0][0].where.id.value).toEqual(['chatflow-1', 'chatflow-2'])
        expectNoCreateSideEffects()
    })

    it('requires every custom assistant ID to resolve in the active workspace', async () => {
        const body = validBody()
        body.chatflowId = JSON.stringify(['assistant-1', 'assistant-2'])
        body.chatflowName = JSON.stringify(['Assistant 1', 'Assistant 2'])
        body.chatflowType = JSON.stringify(['Custom Assistant', 'Custom Assistant'])
        mockAssistantFind.mockResolvedValue([{ id: 'assistant-1', workspaceId: 'workspace-1' }])

        await expect(
            evaluationsService.createEvaluation(body, 'https://flowise.example.test', 'organization-1', 'workspace-1')
        ).rejects.toMatchObject({ statusCode: 404 })

        expect(mockAssistantFind.mock.calls[0][0].where.workspaceId).toBe('workspace-1')
        expect(mockAssistantFind.mock.calls[0][0].where.id.value).toEqual(['assistant-1', 'assistant-2'])
        expectNoCreateSideEffects()
    })

    it('derives a custom assistant label from the scoped assistant entity', async () => {
        const body = validBody()
        body.chatflowId = JSON.stringify(['assistant-1'])
        body.chatflowName = JSON.stringify(['Spoofed Assistant'])
        body.chatflowType = JSON.stringify(['Custom Assistant'])
        mockAssistantFind.mockResolvedValue([
            {
                id: 'assistant-1',
                workspaceId: 'workspace-1',
                type: 'CUSTOM',
                details: JSON.stringify({ name: 'Canonical Assistant' })
            }
        ])

        await evaluationsService.createEvaluation(body, 'https://flowise.example.test', 'organization-1', 'workspace-1')

        expect(mockEvaluationSave.mock.calls[0][0].chatflowName).toBe(JSON.stringify(['Canonical Assistant']))
    })

    it.each([
        ['non-chat component', { category: 'Tools' }, 'model-1'],
        [
            'model outside declared options',
            { inputs: [{ name: 'modelName', type: 'options', options: [{ name: 'allowed-model' }] }] },
            'other-model'
        ]
    ])('rejects an invalid %s before credential lookup, save, telemetry, or provider execution', async (_label, override, model) => {
        mockGetRunningExpressApp.mockReturnValue({
            ...mockGetRunningExpressApp(),
            nodesPool: { componentNodes: { evaluationModel: { ...safeComponent, ...override } } }
        })

        await expect(
            evaluationsService.createEvaluation({ ...validBody(), model }, 'https://flowise.example.test', 'organization-1', 'workspace-1')
        ).rejects.toMatchObject({ statusCode: 400 })

        expect(mockAssertCredentialInWorkspace).not.toHaveBeenCalled()
        expectNoCreateSideEffects()
    })

    it('rejects a cross-workspace credential before any reference lookup or create side effect', async () => {
        mockAssertCredentialInWorkspace.mockRejectedValue(new InternalFlowiseError(404, 'Credential not found'))

        await expect(
            evaluationsService.createEvaluation(validBody(), 'https://flowise.example.test', 'organization-1', 'workspace-1')
        ).rejects.toMatchObject({ statusCode: 404 })

        expect(mockDatasetFindOneBy).not.toHaveBeenCalled()
        expectNoCreateSideEffects()
    })

    it('rejects a missing scoped evaluator before save, telemetry, or provider execution', async () => {
        mockEvaluatorFind.mockResolvedValue([])

        await expect(
            evaluationsService.createEvaluation(validBody(), 'https://flowise.example.test', 'organization-1', 'workspace-1')
        ).rejects.toMatchObject({ statusCode: 404 })

        expect(mockEvaluatorFind.mock.calls[0][0].where.workspaceId).toBe('workspace-1')
        expectNoCreateSideEffects()
    })

    it('saves, emits telemetry, and starts evaluation only after the complete preflight succeeds', async () => {
        await expect(
            evaluationsService.createEvaluation(validBody(), 'https://flowise.example.test', 'organization-1', 'workspace-1')
        ).resolves.toEqual([])

        expect(mockEvaluationSave).toHaveBeenCalledTimes(1)
        expect(mockEvaluationSave.mock.calls[0][0]).toEqual(
            expect.objectContaining({
                datasetName: 'Canonical Dataset',
                chatflowName: JSON.stringify(['Canonical Chatflow'])
            })
        )
        expect(mockSendTelemetry).toHaveBeenCalledTimes(1)
        expect(mockRunEvaluations).toHaveBeenCalledTimes(1)
        expect(mockDatasetFindOneBy.mock.invocationCallOrder[0]).toBeLessThan(mockEvaluationSave.mock.invocationCallOrder[0])
        expect(mockChatFlowFind.mock.invocationCallOrder[0]).toBeLessThan(mockEvaluationSave.mock.invocationCallOrder[0])
        expect(mockEvaluatorFind.mock.invocationCallOrder[0]).toBeLessThan(mockEvaluationSave.mock.invocationCallOrder[0])
        expect(mockEvaluationSave.mock.invocationCallOrder[0]).toBeLessThan(mockSendTelemetry.mock.invocationCallOrder[0])
        expect(mockSendTelemetry.mock.invocationCallOrder[0]).toBeLessThan(mockRunEvaluations.mock.invocationCallOrder[0])
    })

    it('keeps a validated saved evaluation running when telemetry fails', async () => {
        mockSendTelemetry.mockRejectedValueOnce(new Error('telemetry secret sentinel'))

        await expect(
            evaluationsService.createEvaluation(validBody(), 'https://flowise.example.test', 'organization-1', 'workspace-1')
        ).resolves.toEqual([])

        expect(mockEvaluationSave).toHaveBeenCalledTimes(1)
        expect(mockRunEvaluations).toHaveBeenCalledTimes(1)
        expect(mockLoggerWarn).toHaveBeenCalledWith('evaluation_create_telemetry_failed', { failedCount: 1 })
        expect(JSON.stringify(mockLoggerWarn.mock.calls)).not.toContain('telemetry secret sentinel')
    })

    it('stores and logs only fixed execution failure data with a workspace-scoped status update', async () => {
        mockRunEvaluations.mockRejectedValueOnce(new Error('provider-token-secret-sentinel'))

        await expect(
            evaluationsService.createEvaluation(validBody(), 'https://flowise.example.test', 'organization-1', 'workspace-1')
        ).resolves.toEqual([])
        await flushAsyncWork()
        await flushAsyncWork()

        expect(mockEvaluationFindOneBy).toHaveBeenCalledWith({ id: 'evaluation-1', workspaceId: 'workspace-1' })
        expect(mockEvaluationSave).toHaveBeenLastCalledWith(
            expect.objectContaining({
                status: 'error',
                average_metrics: JSON.stringify({ error: 'Evaluation execution failed' })
            })
        )
        expect(mockLoggerError).toHaveBeenCalledWith('evaluation_execution_failed', { failedCount: 1 })
        expect(JSON.stringify([mockLoggerError.mock.calls, mockEvaluationSave.mock.calls])).not.toContain('provider-token-secret-sentinel')
    })

    it.each([
        ['completed result', () => mockRunEvaluations.mockResolvedValueOnce({ rows: [] }), undefined],
        [
            'result-processing failure',
            () => mockRunEvaluations.mockResolvedValueOnce({ rows: null }),
            'evaluation_result_processing_failed'
        ],
        [
            'execution failure',
            () => mockRunEvaluations.mockRejectedValueOnce(new Error('provider-secret-sentinel')),
            'evaluation_execution_failed'
        ]
    ])('absorbs a status-save rejection after %s without exposing the raw error', async (_label, arrangeRun, pathLog) => {
        const unhandledRejections: unknown[] = []
        const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason)
        process.on('unhandledRejection', onUnhandledRejection)
        mockEvaluationSave
            .mockImplementationOnce(async (evaluation) => ({ ...evaluation, id: 'evaluation-1' }))
            .mockRejectedValueOnce(new Error('status-save-secret-sentinel'))
        arrangeRun()

        try {
            await evaluationsService.createEvaluation(validBody(), 'https://flowise.example.test', 'organization-1', 'workspace-1')
            await flushAsyncWork()
            await flushAsyncWork()

            expect(unhandledRejections).toEqual([])
            expect(mockLoggerError).toHaveBeenCalledWith('evaluation_status_update_failed', { failedCount: 1 })
            if (pathLog) expect(mockLoggerError).toHaveBeenCalledWith(pathLog, { failedCount: 1 })
            expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain('status-save-secret-sentinel')
            expect(JSON.stringify(mockLoggerError.mock.calls)).not.toContain('provider-secret-sentinel')
        } finally {
            process.off('unhandledRejection', onUnhandledRejection)
        }
    })

    it('drops prototype-pollution metric keys before persistence', async () => {
        const body = {
            ...validBody(),
            evaluationType: 'benchmarking',
            selectedLLMEvaluators: '',
            credentialId: '',
            llm: '',
            model: ''
        }
        const maliciousMetric = JSON.parse('{"safeMetric":1,"__proto__":{"polluted":true},"constructor":{"polluted":true},"prototype":1}')
        mockRunEvaluations.mockResolvedValueOnce({
            rows: [
                {
                    input: 'input',
                    expectedOutput: 'expected',
                    evaluations: [{ status: 'complete', actualOutput: 'output', latency: '1', metrics: [maliciousMetric], error: '' }]
                }
            ]
        })

        await evaluationsService.createEvaluation(body, 'https://flowise.example.test', 'organization-1', 'workspace-1')
        await flushAsyncWork()
        await flushAsyncWork()

        const persistedMetrics = JSON.parse(mockEvaluationRunSave.mock.calls[0][0].metrics)[0]
        expect(persistedMetrics).toEqual({ safeMetric: 1 })
        expect(Object.prototype.hasOwnProperty.call(persistedMetrics, '__proto__')).toBe(false)
        expect(Object.prototype.hasOwnProperty.call(persistedMetrics, 'constructor')).toBe(false)
        expect(Object.prototype.hasOwnProperty.call(persistedMetrics, 'prototype')).toBe(false)
    })
})
