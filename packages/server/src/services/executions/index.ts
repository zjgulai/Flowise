import { StatusCodes } from 'http-status-codes'
import { EntityManager, In } from 'typeorm'
import { validate as isValidUUID } from 'uuid'
import { ChatMessage } from '../../database/entities/ChatMessage'
import { Execution } from '../../database/entities/Execution'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getErrorMessage } from '../../errors/utils'
import { ExecutionState, IAgentflowExecutedData } from '../../Interface'
import { _removeCredentialId } from '../../utils'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'

const MAX_EXECUTION_DELETE_BATCH_SIZE = 500
const MAX_EXPORT_EXECUTION_IDS = 10_000
const MAX_EXPORT_EXECUTION_QUERY_IDS = 400
const INVALID_EXECUTION_UPDATE_ERROR = 'Invalid execution update request'

export interface ExecutionFilters {
    id?: string
    agentflowId?: string
    agentflowName?: string
    sessionId?: string
    state?: ExecutionState
    startDate?: Date
    endDate?: Date
    page?: number
    limit?: number
    workspaceId?: string
}

const redactPublicExecutionErrors = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map((item) => redactPublicExecutionErrors(item))
    if (!value || typeof value !== 'object') return value

    return Object.fromEntries(
        Object.entries(value).map(([key, nestedValue]) => [
            key,
            /^(?:error|errors|exception|stack|stacktrace)$/i.test(key)
                ? '执行失败，详细信息仅对管理员可见'
                : redactPublicExecutionErrors(nestedValue)
        ])
    )
}

const sanitizeExecutionAgentflow = (execution: Execution): Execution => {
    if (!execution.agentflow) return execution
    const { id, name, type } = execution.agentflow
    return {
        ...execution,
        agentflow: { id, name, type } as Execution['agentflow']
    }
}

const getExecutionById = async (executionId: string, workspaceId?: string): Promise<Execution | null> => {
    try {
        const scopedWorkspaceId = typeof workspaceId === 'string' ? workspaceId.trim() : ''
        if (!scopedWorkspaceId) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Workspace ID is required')
        }

        const appServer = getRunningExpressApp()
        const executionRepository = appServer.AppDataSource.getRepository(Execution)
        const res = await executionRepository.findOne({ where: { id: executionId, workspaceId: scopedWorkspaceId } })
        if (!res) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Execution ${executionId} not found`)
        }
        return res
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: executionsService.getExecutionById - ${getErrorMessage(error)}`
        )
    }
}

const getPublicExecutionById = async (executionId: string): Promise<Execution | null> => {
    try {
        if (!executionId || !isValidUUID(executionId)) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, '公开执行记录不存在')
        }

        const appServer = getRunningExpressApp()
        const executionRepository = appServer.AppDataSource.getRepository(Execution)
        const res = await executionRepository.findOne({ where: { id: executionId, isPublic: true } })
        if (!res) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, '公开执行记录不存在')
        }
        const executionData = typeof res?.executionData === 'string' ? JSON.parse(res?.executionData) : res?.executionData
        const executionDataWithoutCredentialId = executionData.map((data: IAgentflowExecutedData) =>
            redactPublicExecutionErrors(_removeCredentialId(data))
        )
        const stringifiedExecutionData = JSON.stringify(executionDataWithoutCredentialId)
        return { ...res, executionData: stringifiedExecutionData }
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, '读取公开执行记录失败')
    }
}

const getAllExecutions = async (filters: ExecutionFilters = {}): Promise<{ data: Execution[]; total: number }> => {
    try {
        const { id, agentflowId, agentflowName, sessionId, state, startDate, endDate, page = 1, limit = 12, workspaceId } = filters
        const scopedWorkspaceId = typeof workspaceId === 'string' ? workspaceId.trim() : ''
        if (!scopedWorkspaceId) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Workspace ID is required')
        }

        const appServer = getRunningExpressApp()

        // Handle UUID fields properly using raw parameters to avoid type conversion issues
        // This uses the query builder instead of direct objects for compatibility with UUID fields
        const queryBuilder = appServer.AppDataSource.getRepository(Execution)
            .createQueryBuilder('execution')
            .leftJoin('execution.agentflow', 'agentflow', 'agentflow.workspaceId = execution.workspaceId')
            .addSelect(['agentflow.id', 'agentflow.name', 'agentflow.type'])
            .orderBy('execution.updatedDate', 'DESC')
            .skip((page - 1) * limit)
            .take(limit)

        if (id) queryBuilder.andWhere('execution.id = :id', { id })
        if (agentflowId) queryBuilder.andWhere('execution.agentflowId = :agentflowId', { agentflowId })
        if (agentflowName)
            queryBuilder.andWhere('LOWER(agentflow.name) LIKE LOWER(:agentflowName)', { agentflowName: `%${agentflowName}%` })
        if (sessionId) queryBuilder.andWhere('execution.sessionId = :sessionId', { sessionId })
        if (state) queryBuilder.andWhere('execution.state = :state', { state })
        queryBuilder.andWhere('execution.workspaceId = :workspaceId', { workspaceId: scopedWorkspaceId })

        // Date range conditions
        if (startDate && endDate) {
            queryBuilder.andWhere('execution.createdDate BETWEEN :startDate AND :endDate', { startDate, endDate })
        } else if (startDate) {
            queryBuilder.andWhere('execution.createdDate >= :startDate', { startDate })
        } else if (endDate) {
            queryBuilder.andWhere('execution.createdDate <= :endDate', { endDate })
        }

        const [data, total] = await queryBuilder.getManyAndCount()

        return { data: data.map(sanitizeExecutionAgentflow), total }
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: executionsService.getAllExecutions - ${getErrorMessage(error)}`
        )
    }
}

const getExecutionsByIdsForExport = async (executionIds: string[], workspaceId?: string): Promise<Execution[]> => {
    const scopedWorkspaceId = typeof workspaceId === 'string' ? workspaceId.trim() : ''
    if (!scopedWorkspaceId) throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Workspace ID is required')
    if (!Array.isArray(executionIds) || executionIds.length > MAX_EXPORT_EXECUTION_IDS) {
        throw new InternalFlowiseError(StatusCodes.UNPROCESSABLE_ENTITY, '执行记录超过单次可恢复导出的安全上限')
    }
    const normalizedIds = [...new Set(executionIds)]
    if (normalizedIds.some((id) => typeof id !== 'string' || !isValidUUID(id))) {
        throw new InternalFlowiseError(StatusCodes.UNPROCESSABLE_ENTITY, '执行记录包含无效引用，无法导出')
    }
    const repository = getRunningExpressApp().AppDataSource.getRepository(Execution)
    const executions: Execution[] = []
    for (let index = 0; index < normalizedIds.length; index += MAX_EXPORT_EXECUTION_QUERY_IDS) {
        const batch = normalizedIds.slice(index, index + MAX_EXPORT_EXECUTION_QUERY_IDS)
        const rows = await repository.find({
            where: { id: In(batch), workspaceId: scopedWorkspaceId },
            order: { id: 'ASC' },
            take: MAX_EXPORT_EXECUTION_IDS - executions.length + 1
        })
        if (rows.length > MAX_EXPORT_EXECUTION_IDS - executions.length) {
            throw new InternalFlowiseError(StatusCodes.UNPROCESSABLE_ENTITY, '执行记录超过单次可恢复导出的安全上限')
        }
        executions.push(...rows)
    }
    return executions.map(sanitizeExecutionAgentflow)
}

const updateExecution = async (executionId: string, data: Partial<Execution>, workspaceId?: string): Promise<Execution | null> => {
    try {
        const appServer = getRunningExpressApp()
        const scopedWorkspaceId = typeof workspaceId === 'string' ? workspaceId.trim() : ''
        if (!scopedWorkspaceId) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Workspace ID is required')
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, INVALID_EXECUTION_UPDATE_ERROR)
        }
        const updateKeys = Object.keys(data)
        if (updateKeys.length !== 1 || updateKeys[0] !== 'isPublic' || typeof data.isPublic !== 'boolean') {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, INVALID_EXECUTION_UPDATE_ERROR)
        }

        const executionRepository = appServer.AppDataSource.getRepository(Execution)
        const updateResult = await executionRepository.update(
            { id: executionId, workspaceId: scopedWorkspaceId },
            { isPublic: data.isPublic }
        )
        if (updateResult.affected === 0) {
            throw new InternalFlowiseError(StatusCodes.NOT_FOUND, `Execution ${executionId} not found`)
        }
        if (updateResult.affected !== 1) {
            throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Execution update changed concurrently')
        }
        const execution = await executionRepository.findOneBy({ id: executionId, workspaceId: scopedWorkspaceId })
        if (!execution) {
            throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Execution update changed concurrently')
        }
        return execution
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: executionsService.updateExecution - ${getErrorMessage(error)}`
        )
    }
}

/**
 * Delete multiple executions by their IDs
 * @param executionIds Array of execution IDs to delete
 * @param workspaceId Active workspace ID used to resolve the owned execution set
 * @param transactionManager Optional caller-owned transaction manager for atomic cascades
 * @returns Object with success status and count of deleted executions
 */
const deleteExecutions = async (
    executionIds: string[],
    workspaceId?: string,
    transactionManager?: EntityManager
): Promise<{ success: boolean; deletedCount: number }> => {
    try {
        const scopedWorkspaceId = typeof workspaceId === 'string' ? workspaceId.trim() : ''
        if (!scopedWorkspaceId) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Workspace ID is required')
        }

        if (!Array.isArray(executionIds) || executionIds.length > MAX_EXECUTION_DELETE_BATCH_SIZE) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid execution deletion request')
        }
        const normalizedIds: string[] = []
        for (const id of executionIds) {
            const normalizedId = typeof id === 'string' ? id.trim() : ''
            if (!normalizedId || !isValidUUID(normalizedId)) {
                throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid execution deletion request')
            }
            normalizedIds.push(normalizedId)
        }
        const requestedIds = [...new Set(normalizedIds)]
        if (requestedIds.length === 0) return { success: true, deletedCount: 0 }

        const deleteWithManager = async (manager: EntityManager): Promise<{ success: boolean; deletedCount: number }> => {
            const executionRepository = manager.getRepository(Execution)
            const ownedExecutions = await executionRepository.find({
                where: { id: In(requestedIds), workspaceId: scopedWorkspaceId },
                select: ['id']
            })
            const requestedIdSet = new Set(requestedIds)
            const ownedExecutionIds = [
                ...new Set(
                    ownedExecutions
                        .map((execution) => execution.id)
                        .filter((id): id is string => typeof id === 'string' && requestedIdSet.has(id))
                )
            ]

            if (ownedExecutionIds.length === 0) return { success: true, deletedCount: 0 }

            const result = await executionRepository.delete({
                id: In(ownedExecutionIds),
                workspaceId: scopedWorkspaceId
            })
            if (result.affected !== ownedExecutionIds.length) {
                throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Execution deletion changed concurrently')
            }
            await manager.getRepository(ChatMessage).update({ executionId: In(ownedExecutionIds) }, { executionId: null as any })

            return {
                success: true,
                deletedCount: result.affected
            }
        }

        if (transactionManager) return await deleteWithManager(transactionManager)
        const appServer = getRunningExpressApp()
        return await appServer.AppDataSource.transaction(deleteWithManager)
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: executionsService.deleteExecutions - ${getErrorMessage(error)}`
        )
    }
}

export default {
    getExecutionById,
    getAllExecutions,
    getExecutionsByIdsForExport,
    deleteExecutions,
    getPublicExecutionById,
    updateExecution
}
