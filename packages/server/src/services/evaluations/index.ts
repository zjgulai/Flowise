import { EvaluationRunner, ICommonObject } from 'flowise-components'
import { StatusCodes } from 'http-status-codes'
import { In } from 'typeorm'
import { validate as isUuid, v4 as uuidv4 } from 'uuid'
import { ApiKey } from '../../database/entities/ApiKey'
import { Assistant } from '../../database/entities/Assistant'
import { ChatFlow } from '../../database/entities/ChatFlow'
import { Dataset } from '../../database/entities/Dataset'
import { DatasetRow } from '../../database/entities/DatasetRow'
import { Evaluation } from '../../database/entities/Evaluation'
import { EvaluationRun } from '../../database/entities/EvaluationRun'
import { Evaluator } from '../../database/entities/Evaluator'
import { getWorkspaceSearchOptions } from '../../enterprise/utils/ControllerServiceUtils'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getErrorMessage } from '../../errors/utils'
import { EvaluationStatus, IEvaluationResult } from '../../Interface'
import { getAppVersion } from '../../utils'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import logger from '../../utils/logger'
import evaluatorsService from '../evaluator'
import credentialsService from '../credentials'
import { calculateCost, formatCost } from './CostCalculator'
import { runAdditionalEvaluators } from './EvaluatorRunner'
import { LLMEvaluationRunner, resolveEvaluationChatModelSelection } from './LLMEvaluationRunner'

const MAX_EVALUATION_JSON_BYTES = 64 * 1024
const MAX_EVALUATION_REFERENCES = 100
const MAX_EVALUATION_ID_LENGTH = 256
const MAX_EVALUATION_NAME_LENGTH = 255
const MAX_EVALUATION_LABEL_LENGTH = 512
const MAX_EVALUATION_DELETE_IDS = 500
const EVALUATION_TYPES = new Set(['benchmarking', 'llm'])
const CHATFLOW_TYPES = new Set(['Agentflow v2', 'Chatflow', 'Custom Assistant'])
const UNSAFE_METRIC_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

interface ParsedEvaluationCreateRequest {
    name: string
    evaluationType: 'benchmarking' | 'llm'
    datasetId: string
    datasetName: string
    chatflowIds: string[]
    chatflowNames: string[]
    chatflowTypes: string[]
    simpleEvaluatorIds: string[]
    llmEvaluatorIds: string[]
    datasetAsOneConversation: boolean
    credentialId?: string
    llm?: string
    model?: string
}

const invalidEvaluationRequest = (): InternalFlowiseError => new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid evaluation request')

const invalidEvaluationDeleteRequest = (): InternalFlowiseError =>
    new InternalFlowiseError(StatusCodes.BAD_REQUEST, 'Invalid evaluation deletion request')

const parseEvaluationDeleteRequest = (ids: unknown, isDeleteAllVersion: unknown): { ids: string[]; isDeleteAllVersion: boolean } => {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_EVALUATION_DELETE_IDS || typeof isDeleteAllVersion !== 'boolean') {
        throw invalidEvaluationDeleteRequest()
    }

    const normalizedIds = ids.map((id) => {
        if (typeof id !== 'string' || !isUuid(id)) throw invalidEvaluationDeleteRequest()
        return id.toLowerCase()
    })
    if (new Set(normalizedIds).size !== normalizedIds.length) throw invalidEvaluationDeleteRequest()

    return { ids: normalizedIds, isDeleteAllVersion }
}

const requireBoundedString = (value: unknown, maximumLength: number): string => {
    if (typeof value !== 'string') throw invalidEvaluationRequest()
    const normalized = value.trim()
    if (!normalized || normalized.length > maximumLength || normalized.includes('\0')) throw invalidEvaluationRequest()
    return normalized
}

const requireReferenceLabel = (value: unknown): string => {
    if (typeof value !== 'string') throw new InternalFlowiseError(StatusCodes.UNPROCESSABLE_ENTITY, 'Invalid evaluation reference')
    const normalized = value.trim()
    if (!normalized || normalized.length > MAX_EVALUATION_LABEL_LENGTH || normalized.includes('\0')) {
        throw new InternalFlowiseError(StatusCodes.UNPROCESSABLE_ENTITY, 'Invalid evaluation reference')
    }
    return normalized
}

const getAssistantReferenceName = (assistant: Assistant): string => {
    if (typeof assistant.details !== 'string' || Buffer.byteLength(assistant.details, 'utf8') > MAX_EVALUATION_JSON_BYTES) {
        throw new InternalFlowiseError(StatusCodes.UNPROCESSABLE_ENTITY, 'Invalid evaluation reference')
    }
    try {
        const details = JSON.parse(assistant.details)
        if (!details || typeof details !== 'object' || Array.isArray(details)) {
            throw new Error('Invalid assistant details')
        }
        return requireReferenceLabel(details.name)
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.UNPROCESSABLE_ENTITY, 'Invalid evaluation reference')
    }
}

const parseStringArray = (
    value: unknown,
    { allowEmpty, maximumItemLength, unique }: { allowEmpty: boolean; maximumItemLength: number; unique: boolean }
): string[] => {
    let parsed: unknown = value
    if (typeof value === 'string') {
        if (!value && allowEmpty) return []
        if (Buffer.byteLength(value, 'utf8') > MAX_EVALUATION_JSON_BYTES) throw invalidEvaluationRequest()
        try {
            parsed = JSON.parse(value)
        } catch {
            throw invalidEvaluationRequest()
        }
    }
    if (!Array.isArray(parsed) || (!allowEmpty && parsed.length === 0) || parsed.length > MAX_EVALUATION_REFERENCES) {
        throw invalidEvaluationRequest()
    }
    const normalized = parsed.map((item) => requireBoundedString(item, maximumItemLength))
    if (unique && new Set(normalized).size !== normalized.length) throw invalidEvaluationRequest()
    return normalized
}

const parseEvaluationCreateRequest = (body: ICommonObject): ParsedEvaluationCreateRequest => {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !EVALUATION_TYPES.has(body.evaluationType)) {
        throw invalidEvaluationRequest()
    }
    const evaluationType = body.evaluationType as ParsedEvaluationCreateRequest['evaluationType']
    const chatflowIds = parseStringArray(body.chatflowId, {
        allowEmpty: false,
        maximumItemLength: MAX_EVALUATION_ID_LENGTH,
        unique: true
    })
    const chatflowNames = parseStringArray(body.chatflowName, {
        allowEmpty: false,
        maximumItemLength: MAX_EVALUATION_LABEL_LENGTH,
        unique: false
    })
    const chatflowTypes = parseStringArray(body.chatflowType, { allowEmpty: false, maximumItemLength: 64, unique: false })
    if (
        chatflowNames.length !== chatflowIds.length ||
        chatflowTypes.length !== chatflowIds.length ||
        chatflowTypes.some((type) => !CHATFLOW_TYPES.has(type))
    ) {
        throw invalidEvaluationRequest()
    }

    const simpleEvaluatorIds = parseStringArray(body.selectedSimpleEvaluators ?? '', {
        allowEmpty: true,
        maximumItemLength: MAX_EVALUATION_ID_LENGTH,
        unique: true
    })
    const llmEvaluatorIds = parseStringArray(body.selectedLLMEvaluators ?? '', {
        allowEmpty: true,
        maximumItemLength: MAX_EVALUATION_ID_LENGTH,
        unique: true
    })
    if (simpleEvaluatorIds.some((id) => llmEvaluatorIds.includes(id))) throw invalidEvaluationRequest()
    if (body.datasetAsOneConversation !== undefined && typeof body.datasetAsOneConversation !== 'boolean') {
        throw invalidEvaluationRequest()
    }

    const parsed: ParsedEvaluationCreateRequest = {
        name: requireBoundedString(body.name, MAX_EVALUATION_NAME_LENGTH),
        evaluationType,
        datasetId: requireBoundedString(body.datasetId, MAX_EVALUATION_ID_LENGTH),
        datasetName: requireBoundedString(body.datasetName, MAX_EVALUATION_LABEL_LENGTH),
        chatflowIds,
        chatflowNames,
        chatflowTypes,
        simpleEvaluatorIds,
        llmEvaluatorIds,
        datasetAsOneConversation: body.datasetAsOneConversation === true
    }

    if (evaluationType === 'llm') {
        if (llmEvaluatorIds.length === 0) throw invalidEvaluationRequest()
        parsed.credentialId = requireBoundedString(body.credentialId, MAX_EVALUATION_ID_LENGTH)
        parsed.llm = requireBoundedString(body.llm, 128)
        parsed.model = requireBoundedString(body.model, 512)
    } else if (llmEvaluatorIds.length > 0) {
        throw invalidEvaluationRequest()
    }
    return parsed
}

const assertAllScopedReferences = async (appServer: any, request: ParsedEvaluationCreateRequest, workspaceId: string) => {
    const dataset = await appServer.AppDataSource.getRepository(Dataset).findOneBy({
        id: request.datasetId,
        workspaceId
    })
    if (!dataset) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Evaluation references were not found')

    const flowReferences = request.chatflowIds
        .map((id, index) => ({ id, type: request.chatflowTypes[index] }))
        .filter((reference) => reference.type !== 'Custom Assistant')
    const assistantReferences = request.chatflowIds
        .map((id, index) => ({ id, type: request.chatflowTypes[index] }))
        .filter((reference) => reference.type === 'Custom Assistant')

    const flows = flowReferences.length
        ? await appServer.AppDataSource.getRepository(ChatFlow).find({
              where: { id: In(flowReferences.map((reference) => reference.id)), workspaceId }
          })
        : []
    const flowById = new Map<string, ChatFlow>(flows.map((flow: ChatFlow): [string, ChatFlow] => [flow.id, flow]))
    for (const reference of flowReferences) {
        const flow = flowById.get(reference.id)
        const typeMatches =
            reference.type === 'Agentflow v2' ? flow?.type === 'AGENTFLOW' : flow?.type === undefined || flow?.type === 'CHATFLOW'
        if (!flow || !typeMatches) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Evaluation references were not found')
    }

    const assistants: Assistant[] = assistantReferences.length
        ? await appServer.AppDataSource.getRepository(Assistant).find({
              where: { id: In(assistantReferences.map((reference) => reference.id)), workspaceId }
          })
        : []
    if (assistants.length !== assistantReferences.length) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Evaluation references were not found')
    }
    const assistantById = new Map<string, Assistant>(assistants.map((assistant): [string, Assistant] => [assistant.id, assistant]))
    if (assistantReferences.some((reference) => assistantById.get(reference.id)?.type !== 'CUSTOM')) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Evaluation references were not found')
    }

    const evaluatorIds = [...request.simpleEvaluatorIds, ...request.llmEvaluatorIds]
    const evaluators = evaluatorIds.length
        ? await appServer.AppDataSource.getRepository(Evaluator).find({ where: { id: In(evaluatorIds), workspaceId } })
        : []
    if (evaluators.length !== evaluatorIds.length) {
        throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Evaluation references were not found')
    }
    const evaluatorById = new Map<string, Evaluator>(
        evaluators.map((evaluator: Evaluator): [string, Evaluator] => [evaluator.id, evaluator])
    )
    if (
        request.simpleEvaluatorIds.some((id) => !evaluatorById.has(id) || evaluatorById.get(id)?.type === 'llm') ||
        request.llmEvaluatorIds.some((id) => evaluatorById.get(id)?.type !== 'llm')
    ) {
        throw invalidEvaluationRequest()
    }

    const canonicalChatflowNames = request.chatflowIds.map((id, index) => {
        if (request.chatflowTypes[index] === 'Custom Assistant') return getAssistantReferenceName(assistantById.get(id) as Assistant)
        return requireReferenceLabel(flowById.get(id)?.name)
    })

    return {
        dataset,
        flows,
        canonicalDatasetName: requireReferenceLabel(dataset.name),
        canonicalChatflowNames
    }
}

const updateEvaluationStatus = async (
    appServer: any,
    evaluationId: string,
    workspaceId: string,
    status: EvaluationStatus,
    averageMetrics?: ICommonObject
): Promise<void> => {
    try {
        const evaluationRepository = appServer.AppDataSource.getRepository(Evaluation)
        const evaluation = await evaluationRepository.findOneBy({ id: evaluationId, workspaceId })
        if (!evaluation) throw new Error('Evaluation status target was not found')

        evaluation.status = status
        if (averageMetrics !== undefined) evaluation.average_metrics = JSON.stringify(averageMetrics)
        await evaluationRepository.save(evaluation)
    } catch {
        logger.error('evaluation_status_update_failed', { failedCount: 1 })
    }
}

const runAgain = async (id: string, baseURL: string, orgId: string, workspaceId: string) => {
    try {
        const appServer = getRunningExpressApp()
        const evaluation = await appServer.AppDataSource.getRepository(Evaluation).findOneBy({
            id: id,
            workspaceId: workspaceId
        })
        if (!evaluation) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Evaluation was not found')
        const additionalConfig = evaluation.additionalConfig ? JSON.parse(evaluation.additionalConfig) : {}
        const data: ICommonObject = {
            chatflowId: evaluation.chatflowId,
            chatflowName: evaluation.chatflowName,
            datasetName: evaluation.datasetName,
            datasetId: evaluation.datasetId,
            evaluationType: evaluation.evaluationType,
            selectedSimpleEvaluators: JSON.stringify(additionalConfig.simpleEvaluators),
            datasetAsOneConversation: additionalConfig.datasetAsOneConversation,
            chatflowType: JSON.stringify(additionalConfig.chatflowTypes ? additionalConfig.chatflowTypes : [])
        }
        data.name = evaluation.name
        data.workspaceId = evaluation.workspaceId
        if (evaluation.evaluationType === 'llm') {
            data.selectedLLMEvaluators = JSON.stringify(additionalConfig.lLMEvaluators)
            data.credentialId = additionalConfig.credentialId
            // this is to preserve backward compatibility for evaluations created before the llm/model options were added
            if (!additionalConfig.credentialId && additionalConfig.llmConfig) {
                data.model = additionalConfig.llmConfig.model
                data.llm = additionalConfig.llmConfig.llm
                data.credentialId = additionalConfig.llmConfig.credentialId
            } else {
                data.model = 'gpt-3.5-turbo'
                data.llm = 'OpenAI'
            }
        }
        data.version = true
        return await createEvaluation(data, baseURL, orgId, workspaceId)
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: EvalsService.runAgain - ${getErrorMessage(error)}`)
    }
}

const createEvaluation = async (body: ICommonObject, baseURL: string, orgId: string, workspaceId: string) => {
    try {
        if (!workspaceId) throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Evaluation is not authorized')
        const request = parseEvaluationCreateRequest(body)
        const appServer = getRunningExpressApp()
        const additionalConfig: ICommonObject = {
            chatflowTypes: request.chatflowTypes,
            datasetAsOneConversation: request.datasetAsOneConversation,
            simpleEvaluators: request.simpleEvaluatorIds
        }
        if (request.evaluationType === 'llm') {
            let safeLLMSelection: ReturnType<typeof resolveEvaluationChatModelSelection>
            try {
                safeLLMSelection = resolveEvaluationChatModelSelection(
                    appServer.nodesPool.componentNodes,
                    request.llm,
                    request.model,
                    request.credentialId
                )
            } catch {
                throw invalidEvaluationRequest()
            }
            await credentialsService.assertCredentialInWorkspace(safeLLMSelection.nodeData.credential, workspaceId)
            additionalConfig.lLMEvaluators = request.llmEvaluatorIds
            additionalConfig.llmConfig = {
                credentialId: safeLLMSelection.nodeData.credential,
                llm: safeLLMSelection.nodeData.name,
                model: Object.values(safeLLMSelection.nodeData.inputs)[0]
            }
        }

        const { dataset, flows, canonicalDatasetName, canonicalChatflowNames } = await assertAllScopedReferences(
            appServer,
            request,
            workspaceId
        )
        const items = await appServer.AppDataSource.getRepository(DatasetRow).find({
            where: { datasetId: dataset.id },
            order: { sequenceNo: 'ASC' }
        })
        ;(dataset as any).rows = items

        const apiKeys: { chatflowId: string; apiKey: string }[] = []
        for (const flow of flows) {
            if (!flow.apikeyid) continue
            const apikeyObj = await appServer.AppDataSource.getRepository(ApiKey).findOneBy({
                id: flow.apikeyid,
                workspaceId
            })
            if (!apikeyObj) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Evaluation references were not found')
            apiKeys.push({ chatflowId: flow.id, apiKey: apikeyObj.apiKey })
        }

        const newEval = new Evaluation()
        newEval.name = request.name
        newEval.evaluationType = request.evaluationType
        newEval.datasetId = request.datasetId
        newEval.datasetName = canonicalDatasetName
        newEval.chatflowId = JSON.stringify(request.chatflowIds)
        newEval.chatflowName = JSON.stringify(canonicalChatflowNames)
        newEval.workspaceId = workspaceId
        newEval.status = EvaluationStatus.PENDING
        newEval.additionalConfig = JSON.stringify(additionalConfig)
        newEval.average_metrics = JSON.stringify({})

        const evaluationRepository = appServer.AppDataSource.getRepository(Evaluation)
        const row = evaluationRepository.create(newEval)
        const newEvaluation = await evaluationRepository.save(row)

        try {
            await appServer.telemetry.sendTelemetry(
                'evaluation_created',
                {
                    version: await getAppVersion()
                },
                orgId
            )
        } catch {
            logger.warn('evaluation_create_telemetry_failed', { failedCount: 1 })
        }

        const data: ICommonObject = {
            chatflowId: newEval.chatflowId,
            dataset: dataset,
            evaluationType: request.evaluationType,
            evaluationId: newEvaluation.id,
            credentialId: request.credentialId
        }
        if (request.datasetAsOneConversation) {
            data.sessionId = uuidv4()
        }
        if (apiKeys.length > 0) {
            data.apiKeys = apiKeys
        }

        // save the evaluation with status as pending
        const evalRunner = new EvaluationRunner(baseURL)
        let evalMetrics = { passCount: 0, failCount: 0, errorCount: 0 }
        evalRunner
            .runEvaluations(data)
            .then(async (result) => {
                let totalTime = 0
                // let us assume that the eval is successful
                let allRowsSuccessful = true
                try {
                    const llmEvaluationRunner = new LLMEvaluationRunner(workspaceId)
                    for (const resultRow of result.rows) {
                        const metricsArray: ICommonObject[] = []
                        const actualOutputArray: string[] = []
                        const errorArray: string[] = []
                        for (const evaluationRow of resultRow.evaluations) {
                            if (evaluationRow.status === 'error') {
                                // if a row failed, mark the entire run as failed (error)
                                allRowsSuccessful = false
                            }
                            actualOutputArray.push(evaluationRow.actualOutput)
                            totalTime += parseFloat(evaluationRow.latency)
                            const metricsObjFromRun: ICommonObject = Object.create(null)

                            let nested_metrics = evaluationRow.nested_metrics

                            let promptTokens = 0,
                                completionTokens = 0,
                                totalTokens = 0
                            let inputCost = 0,
                                outputCost = 0,
                                totalCost = 0
                            if (nested_metrics && nested_metrics.length > 0) {
                                for (let i = 0; i < nested_metrics.length; i++) {
                                    const nested_metric = nested_metrics[i]
                                    if (nested_metric.model && nested_metric.promptTokens > 0) {
                                        promptTokens += nested_metric.promptTokens
                                        completionTokens += nested_metric.completionTokens
                                        totalTokens += nested_metric.totalTokens

                                        inputCost += nested_metric.cost_values.input_cost
                                        outputCost += nested_metric.cost_values.output_cost
                                        totalCost += nested_metric.cost_values.total_cost

                                        nested_metric['totalCost'] = formatCost(nested_metric.cost_values.total_cost)
                                        nested_metric['promptCost'] = formatCost(nested_metric.cost_values.input_cost)
                                        nested_metric['completionCost'] = formatCost(nested_metric.cost_values.output_cost)
                                    }
                                }
                                nested_metrics = nested_metrics.filter((metric: any) => {
                                    return metric.model && metric.provider
                                })
                            }
                            const metrics = evaluationRow.metrics
                            if (metrics) {
                                if (nested_metrics && nested_metrics.length > 0) {
                                    metrics.push({
                                        promptTokens: promptTokens,
                                        completionTokens: completionTokens,
                                        totalTokens: totalTokens,
                                        totalCost: formatCost(totalCost),
                                        promptCost: formatCost(inputCost),
                                        completionCost: formatCost(outputCost)
                                    })
                                    metricsObjFromRun.nested_metrics = nested_metrics
                                }
                                metrics.map((metric: any) => {
                                    if (metric) {
                                        const json = typeof metric === 'object' ? metric : JSON.parse(metric)
                                        Object.getOwnPropertyNames(json).map((key) => {
                                            if (UNSAFE_METRIC_KEYS.has(key)) return
                                            metricsObjFromRun[key] = json[key]
                                        })
                                    }
                                })
                                metricsArray.push(metricsObjFromRun)
                            }
                            errorArray.push(evaluationRow.error)
                        }

                        const newRun = new EvaluationRun()
                        newRun.evaluationId = newEvaluation.id
                        newRun.runDate = new Date()
                        newRun.input = resultRow.input
                        newRun.expectedOutput = resultRow.expectedOutput
                        newRun.actualOutput = JSON.stringify(actualOutputArray)
                        newRun.errors = JSON.stringify(errorArray)
                        calculateCost(metricsArray)
                        newRun.metrics = JSON.stringify(metricsArray)

                        const { results, evaluatorMetrics } = await runAdditionalEvaluators(
                            metricsArray,
                            actualOutputArray,
                            errorArray,
                            additionalConfig.simpleEvaluators,
                            workspaceId
                        )

                        newRun.evaluators = JSON.stringify(results)
                        evalMetrics.passCount += evaluatorMetrics.passCount
                        evalMetrics.failCount += evaluatorMetrics.failCount
                        evalMetrics.errorCount += evaluatorMetrics.errorCount

                        if (request.evaluationType === 'llm') {
                            resultRow.llmConfig = additionalConfig.llmConfig
                            resultRow.LLMEvaluators = additionalConfig.lLMEvaluators
                            const llmEvaluatorMap: { evaluatorId: string; evaluator: any }[] = []
                            for (let i = 0; i < resultRow.LLMEvaluators.length; i++) {
                                const evaluatorId = resultRow.LLMEvaluators[i]
                                const evaluator = await evaluatorsService.getEvaluator(evaluatorId, workspaceId)
                                llmEvaluatorMap.push({
                                    evaluatorId: evaluatorId,
                                    evaluator: evaluator
                                })
                            }
                            // iterate over the actualOutputArray and add the actualOutput to the evaluationLineItem object
                            const resultArray = await llmEvaluationRunner.runLLMEvaluators(
                                resultRow,
                                actualOutputArray,
                                errorArray,
                                llmEvaluatorMap
                            )
                            newRun.llmEvaluators = JSON.stringify(resultArray)
                            const row = appServer.AppDataSource.getRepository(EvaluationRun).create(newRun)
                            await appServer.AppDataSource.getRepository(EvaluationRun).save(row)
                        } else {
                            const row = appServer.AppDataSource.getRepository(EvaluationRun).create(newRun)
                            await appServer.AppDataSource.getRepository(EvaluationRun).save(row)
                        }
                    }
                    //update the evaluation with status as completed
                    let passPercent = -1
                    if (evalMetrics.passCount + evalMetrics.failCount + evalMetrics.errorCount > 0) {
                        passPercent =
                            (evalMetrics.passCount / (evalMetrics.passCount + evalMetrics.failCount + evalMetrics.errorCount)) * 100
                    }
                    await updateEvaluationStatus(
                        appServer,
                        newEvaluation.id,
                        workspaceId,
                        allRowsSuccessful ? EvaluationStatus.COMPLETED : EvaluationStatus.ERROR,
                        {
                            averageLatency: (totalTime / result.rows.length).toFixed(3),
                            totalRuns: result.rows.length,
                            ...evalMetrics,
                            passPcnt: passPercent.toFixed(2)
                        }
                    )
                } catch {
                    logger.error('evaluation_result_processing_failed', { failedCount: 1 })
                    //update the evaluation with status as error
                    await updateEvaluationStatus(appServer, newEvaluation.id, workspaceId, EvaluationStatus.ERROR)
                }
            })
            .catch(async () => {
                // Handle errors from runEvaluations
                logger.error('evaluation_execution_failed', { failedCount: 1 })
                await updateEvaluationStatus(appServer, newEvaluation.id, workspaceId, EvaluationStatus.ERROR, {
                    error: 'Evaluation execution failed'
                })
            })

        return getAllEvaluations(workspaceId)
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Failed to create evaluation')
    }
}

const getAllEvaluations = async (workspaceId: string, page: number = -1, limit: number = -1) => {
    try {
        const appServer = getRunningExpressApp()

        // First, get the count of distinct evaluation names for the total
        // needed as the The getCount() method in TypeORM doesn't respect the GROUP BY clause and will return the total count of records
        const countQuery = appServer.AppDataSource.getRepository(Evaluation)
            .createQueryBuilder('ev')
            .select('COUNT(DISTINCT(ev.name))', 'count')
            .where('ev.workspaceId = :workspaceId', { workspaceId: workspaceId })

        const totalResult = await countQuery.getRawOne()
        const total = totalResult ? parseInt(totalResult.count) : 0

        // Then get the distinct evaluation names with their counts and latest run date
        const namesQueryBuilder = appServer.AppDataSource.getRepository(Evaluation)
            .createQueryBuilder('ev')
            .select('DISTINCT(ev.name)', 'name')
            .addSelect('COUNT(ev.name)', 'count')
            .addSelect('MAX(ev.runDate)', 'latestRunDate')
            .andWhere('ev.workspaceId = :workspaceId', { workspaceId: workspaceId })
            .groupBy('ev.name')
            .orderBy('max(ev.runDate)', 'DESC') // Order by the latest run date

        if (page > 0 && limit > 0) {
            namesQueryBuilder.skip((page - 1) * limit)
            namesQueryBuilder.take(limit)
        }

        const evaluationNames = await namesQueryBuilder.getRawMany()
        // Get all evaluations for all names at once in a single query
        const returnResults: IEvaluationResult[] = []

        if (evaluationNames.length > 0) {
            const names = evaluationNames.map((item) => item.name)
            // Fetch all evaluations for these names in a single query
            const allEvaluations = await appServer.AppDataSource.getRepository(Evaluation)
                .createQueryBuilder('ev')
                .where('ev.name IN (:...names)', { names })
                .andWhere('ev.workspaceId = :workspaceId', { workspaceId })
                .orderBy('ev.name', 'ASC')
                .addOrderBy('ev.runDate', 'DESC')
                .getMany()

            // Process the results by name
            const evaluationsByName = new Map<string, Evaluation[]>()
            // Group evaluations by name
            for (const evaluation of allEvaluations) {
                if (!evaluationsByName.has(evaluation.name)) {
                    evaluationsByName.set(evaluation.name, [])
                }
                evaluationsByName.get(evaluation.name)!.push(evaluation)
            }

            // Process each name's evaluations
            for (const item of evaluationNames) {
                const evaluationsForName = evaluationsByName.get(item.name) || []
                for (let i = 0; i < evaluationsForName.length; i++) {
                    const evaluation = evaluationsForName[i] as IEvaluationResult
                    evaluation.latestEval = i === 0
                    evaluation.version = parseInt(item.count) - i
                    returnResults.push(evaluation)
                }
            }
        }

        if (page > 0 && limit > 0) {
            return {
                total: total,
                data: returnResults
            }
        } else {
            return returnResults
        }
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: EvalsService.getAllEvaluations - ${getErrorMessage(error)}`
        )
    }
}

// Delete evaluation and all rows via id
const deleteEvaluation = async (id: string, activeWorkspaceId: string) => {
    return patchDeleteEvaluations([id], activeWorkspaceId, false)
}

// check for outdated evaluations
const isOutdated = async (id: string, workspaceId: string) => {
    try {
        const appServer = getRunningExpressApp()
        const evaluation = await appServer.AppDataSource.getRepository(Evaluation).findOneBy({
            id: id,
            workspaceId: workspaceId
        })
        if (!evaluation) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Evaluation was not found')
        const evaluationRunDate = evaluation.runDate.getTime()
        let isOutdated = false
        const returnObj: ICommonObject = {
            isOutdated: false,
            chatflows: [],
            dataset: '',
            errors: []
        }

        // check if the evaluation is outdated by extracting the runTime and then check with the dataset last updated time as well
        // as the chatflows last updated time. If the evaluation is outdated, then return true else return false
        const dataset = await appServer.AppDataSource.getRepository(Dataset).findOneBy({
            id: evaluation.datasetId,
            workspaceId: workspaceId
        })
        if (dataset) {
            const datasetLastUpdated = dataset.updatedDate.getTime()
            if (datasetLastUpdated > evaluationRunDate) {
                isOutdated = true
                returnObj.dataset = dataset
            }
        } else {
            returnObj.errors.push({
                message: `Dataset ${evaluation.datasetName} not found`,
                id: evaluation.datasetId
            })
            isOutdated = true
        }
        const chatflowIds = evaluation.chatflowId ? JSON.parse(evaluation.chatflowId) : []
        const chatflowNames = evaluation.chatflowName ? JSON.parse(evaluation.chatflowName) : []
        const chatflowTypes = evaluation.additionalConfig ? JSON.parse(evaluation.additionalConfig).chatflowTypes : []
        for (let i = 0; i < chatflowIds.length; i++) {
            // check for backward compatibility, as previous versions did not the types in additionalConfig
            if (chatflowTypes && chatflowTypes.length >= 0) {
                if (chatflowTypes[i] === 'Custom Assistant') {
                    // if the chatflow type is custom assistant, then we should NOT check in the chatflows table
                    continue
                }
            }
            const chatflow = await appServer.AppDataSource.getRepository(ChatFlow).findOneBy({
                id: chatflowIds[i],
                workspaceId: workspaceId
            })
            if (!chatflow) {
                returnObj.errors.push({
                    message: `Chatflow ${chatflowNames[i]} not found`,
                    id: chatflowIds[i]
                })
                isOutdated = true
            } else {
                const chatflowLastUpdated = chatflow.updatedDate.getTime()
                if (chatflowLastUpdated > evaluationRunDate) {
                    isOutdated = true
                    returnObj.chatflows.push({
                        chatflowName: chatflowNames[i],
                        chatflowId: chatflowIds[i],
                        chatflowType: chatflow.type === 'AGENTFLOW' ? 'Agentflow v2' : 'Chatflow',
                        isOutdated: true
                    })
                }
            }
        }
        if (chatflowTypes && chatflowTypes.length > 0) {
            for (let i = 0; i < chatflowIds.length; i++) {
                if (chatflowTypes[i] !== 'Custom Assistant') {
                    // if the chatflow type is NOT custom assistant, then bail out for this item
                    continue
                }
                const assistant = await appServer.AppDataSource.getRepository(Assistant).findOneBy({
                    id: chatflowIds[i],
                    workspaceId: workspaceId
                })
                if (!assistant) {
                    returnObj.errors.push({
                        message: `Custom Assistant ${chatflowNames[i]} not found`,
                        id: chatflowIds[i]
                    })
                    isOutdated = true
                } else {
                    const chatflowLastUpdated = assistant.updatedDate.getTime()
                    if (chatflowLastUpdated > evaluationRunDate) {
                        isOutdated = true
                        returnObj.chatflows.push({
                            chatflowName: chatflowNames[i],
                            chatflowId: chatflowIds[i],
                            chatflowType: 'Custom Assistant',
                            isOutdated: true
                        })
                    }
                }
            }
        }
        returnObj.isOutdated = isOutdated
        return returnObj
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, `Error: EvalsService.isOutdated - ${getErrorMessage(error)}`)
    }
}

const getEvaluation = async (id: string, workspaceId: string) => {
    try {
        const appServer = getRunningExpressApp()
        const evaluation = await appServer.AppDataSource.getRepository(Evaluation).findOneBy({
            id: id,
            workspaceId: workspaceId
        })
        if (!evaluation) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Evaluation was not found')
        const versionCount = await appServer.AppDataSource.getRepository(Evaluation).countBy({
            name: evaluation.name,
            workspaceId
        })
        const items = await appServer.AppDataSource.getRepository(EvaluationRun).find({
            where: { evaluationId: id }
        })
        const versions = (await getVersions(id, workspaceId)).versions
        const versionNo = versions.findIndex((version) => version.id === id) + 1
        return {
            ...evaluation,
            versionCount: versionCount,
            versionNo: versionNo,
            rows: items
        }
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Failed to get evaluation')
    }
}

const getVersions = async (id: string, workspaceId: string) => {
    try {
        const appServer = getRunningExpressApp()
        const evaluation = await appServer.AppDataSource.getRepository(Evaluation).findOneBy({
            id: id,
            workspaceId: workspaceId
        })
        if (!evaluation) throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Evaluation was not found')
        const versions = await appServer.AppDataSource.getRepository(Evaluation).find({
            where: {
                name: evaluation.name,
                workspaceId
            },
            order: {
                runDate: 'ASC'
            }
        })
        const returnResults: { id: string; runDate: Date; version: number }[] = []
        versions.map((version, index) => {
            returnResults.push({
                id: version.id,
                runDate: version.runDate,
                version: index + 1
            })
        })
        return {
            versions: returnResults
        }
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Failed to get evaluation versions')
    }
}

const patchDeleteEvaluations = async (ids: unknown, activeWorkspaceId: string, isDeleteAllVersion: unknown) => {
    try {
        if (!activeWorkspaceId) throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Evaluation deletion is not authorized')
        const request = parseEvaluationDeleteRequest(ids, isDeleteAllVersion)
        const appServer = getRunningExpressApp()
        return await appServer.AppDataSource.transaction(async (manager) => {
            const evaluationRepository = manager.getRepository(Evaluation)
            const evaluationRunRepository = manager.getRepository(EvaluationRun)
            const scopedEvaluations = await evaluationRepository.find({
                where: {
                    id: In(request.ids),
                    workspaceId: activeWorkspaceId
                }
            })
            if (scopedEvaluations.length !== request.ids.length) {
                throw new InternalFlowiseError(StatusCodes.NOT_FOUND, 'Evaluation deletion targets were not found')
            }

            let evaluationsToDelete = scopedEvaluations
            if (request.isDeleteAllVersion) {
                const scopedNames = [...new Set(scopedEvaluations.map((evaluation) => evaluation.name))]
                evaluationsToDelete = await evaluationRepository.find({
                    where: {
                        name: In(scopedNames),
                        workspaceId: activeWorkspaceId
                    }
                })
            }

            const targetIds = [...new Set(evaluationsToDelete.map((evaluation) => evaluation.id))]
            const targetIdSet = new Set(targetIds)
            if (targetIds.length > MAX_EVALUATION_DELETE_IDS) throw invalidEvaluationDeleteRequest()
            if (targetIds.length === 0 || request.ids.some((id) => !targetIdSet.has(id))) {
                throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Evaluation deletion changed concurrently')
            }
            if (evaluationsToDelete.some((evaluation) => evaluation.status === EvaluationStatus.PENDING)) {
                throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Running evaluations cannot be deleted')
            }

            const expectedRunCount = await evaluationRunRepository.countBy({ evaluationId: In(targetIds) })
            const runDeleteResult = await evaluationRunRepository.delete({ evaluationId: In(targetIds) })
            if (runDeleteResult.affected !== expectedRunCount) {
                throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Evaluation deletion changed concurrently')
            }

            const evaluationDeleteResult = await evaluationRepository.delete({
                id: In(targetIds),
                workspaceId: activeWorkspaceId
            })
            if (evaluationDeleteResult.affected !== targetIds.length) {
                throw new InternalFlowiseError(StatusCodes.CONFLICT, 'Evaluation deletion changed concurrently')
            }

            return evaluationRepository.findBy(getWorkspaceSearchOptions(activeWorkspaceId))
        })
    } catch (error) {
        if (error instanceof InternalFlowiseError) throw error
        throw new InternalFlowiseError(StatusCodes.INTERNAL_SERVER_ERROR, 'Failed to delete evaluations')
    }
}

export default {
    createEvaluation,
    getAllEvaluations,
    deleteEvaluation,
    getEvaluation,
    isOutdated,
    runAgain,
    getVersions,
    patchDeleteEvaluations
}
