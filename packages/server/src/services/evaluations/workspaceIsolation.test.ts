const mockEvaluationFindOneBy = jest.fn()
const mockEvaluationFind = jest.fn()
const mockEvaluationCountBy = jest.fn()
const mockEvaluationDelete = jest.fn()
const mockEvaluationFindBy = jest.fn()
const mockRunFind = jest.fn()
const mockRunDelete = jest.fn()
const mockRunCountBy = jest.fn()
const mockTransaction = jest.fn()

jest.mock('../../utils/getRunningExpressApp', () => ({ getRunningExpressApp: jest.fn() }))
jest.mock('../../utils/logger', () => ({ __esModule: true, default: { warn: jest.fn(), error: jest.fn() } }))
jest.mock('../../enterprise/utils/ControllerServiceUtils', () => ({
    getWorkspaceSearchOptions: (workspaceId: string) => ({ workspaceId })
}))

import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { Evaluation } from '../../database/entities/Evaluation'
import { EvaluationRun } from '../../database/entities/EvaluationRun'
import evaluationsService from '.'

const mockGetRunningExpressApp = getRunningExpressApp as jest.Mock

const evaluationRepository = {
    findOneBy: mockEvaluationFindOneBy,
    find: mockEvaluationFind,
    countBy: mockEvaluationCountBy,
    delete: mockEvaluationDelete,
    findBy: mockEvaluationFindBy
}
const evaluationRunRepository = {
    find: mockRunFind,
    delete: mockRunDelete,
    countBy: mockRunCountBy
}

const getRepository = (entity: unknown) => {
    if (entity === Evaluation) return evaluationRepository
    if (entity === EvaluationRun) return evaluationRunRepository
    throw new Error('Unexpected repository')
}

describe('evaluation workspace isolation', () => {
    beforeEach(() => {
        jest.resetAllMocks()
        mockTransaction.mockImplementation(async (callback) => callback({ getRepository }))
        mockGetRunningExpressApp.mockReturnValue({
            AppDataSource: {
                getRepository,
                transaction: mockTransaction
            }
        })
        mockEvaluationDelete.mockResolvedValue({ affected: 1 })
        mockRunDelete.mockResolvedValue({ affected: 1 })
        mockRunCountBy.mockResolvedValue(1)
        mockEvaluationFindBy.mockResolvedValue([])
        mockEvaluationFind.mockResolvedValue([])
    })

    it('scopes version lookup and version count to the active workspace', async () => {
        const evaluation = { id: 'evaluation-a', name: 'shared-name', workspaceId: 'workspace-a', runDate: new Date('2026-01-01') }
        const versions = [evaluation, { ...evaluation, id: 'evaluation-a2', runDate: new Date('2026-01-02') }]
        mockEvaluationFindOneBy.mockResolvedValue(evaluation)
        mockEvaluationFind.mockResolvedValue(versions)
        mockEvaluationCountBy.mockResolvedValue(2)
        mockRunFind.mockResolvedValue([])

        const result = await evaluationsService.getEvaluation('evaluation-a', 'workspace-a')

        expect(mockEvaluationFindOneBy).toHaveBeenCalledWith({ id: 'evaluation-a', workspaceId: 'workspace-a' })
        expect(mockEvaluationCountBy).toHaveBeenCalledWith({ name: 'shared-name', workspaceId: 'workspace-a' })
        expect(mockEvaluationFind).toHaveBeenCalledWith({
            where: { name: 'shared-name', workspaceId: 'workspace-a' },
            order: { runDate: 'ASC' }
        })
        expect(result).toEqual(expect.objectContaining({ versionCount: 2, versionNo: 1 }))
    })

    it('returns not found without querying versions for a cross-workspace evaluation', async () => {
        mockEvaluationFindOneBy.mockResolvedValue(null)

        await expect(evaluationsService.getVersions('evaluation-b', 'workspace-a')).rejects.toMatchObject({ statusCode: 404 })

        expect(mockEvaluationFindOneBy).toHaveBeenCalledWith({ id: 'evaluation-b', workspaceId: 'workspace-a' })
        expect(mockEvaluationFind).not.toHaveBeenCalled()
    })

    it('rejects the complete batch before deletion when any requested evaluation is outside the active workspace', async () => {
        const ownedId = '11111111-1111-4111-8111-111111111111'
        const foreignId = '22222222-2222-4222-8222-222222222222'
        mockEvaluationFind.mockResolvedValueOnce([{ id: ownedId, name: 'shared-name', workspaceId: 'workspace-a' }])

        await expect(evaluationsService.patchDeleteEvaluations([ownedId, foreignId], 'workspace-a', true)).rejects.toMatchObject({
            statusCode: 404,
            message: 'Evaluation deletion targets were not found'
        })

        expect(mockEvaluationFind).toHaveBeenCalledWith({
            where: expect.objectContaining({ workspaceId: 'workspace-a' })
        })
        expect(mockRunDelete).not.toHaveBeenCalled()
        expect(mockEvaluationDelete).not.toHaveBeenCalled()
    })
})
