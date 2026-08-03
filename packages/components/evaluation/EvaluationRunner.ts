import { v4 as uuidv4 } from 'uuid'
import { ICommonObject } from '../src'
import { FLOWISE_REQUEST_ERROR, requestFlowisePrediction } from '../src/internalFlowRequest'

import { getModelConfigByModelName, MODEL_TYPE } from '../src/modelLoader'

export class EvaluationRunner {
    static metrics = new Map<string, string[]>()

    static getCostMetrics = async (selectedProvider: string, selectedModel: string) => {
        let modelConfig = await getModelConfigByModelName(MODEL_TYPE.CHAT, selectedProvider, selectedModel)
        if (modelConfig) {
            if (modelConfig['cost_values']) {
                return modelConfig.cost_values
            }
            return { cost_values: modelConfig }
        } else {
            modelConfig = await getModelConfigByModelName(MODEL_TYPE.LLM, selectedProvider, selectedModel)
            if (modelConfig) {
                if (modelConfig['cost_values']) {
                    return modelConfig.cost_values
                }
                return { cost_values: modelConfig }
            }
        }
        return undefined
    }

    static async getAndDeleteMetrics(id: string) {
        const val = EvaluationRunner.metrics.get(id)
        if (val) {
            try {
                //first lets get the provider and model
                let selectedModel = undefined
                let selectedProvider = undefined
                if (val && val.length > 0) {
                    let modelName = ''
                    let providerName = ''
                    for (let i = 0; i < val.length; i++) {
                        const metric = val[i]
                        if (typeof metric === 'object') {
                            modelName = metric['model']
                            providerName = metric['provider']
                        } else {
                            modelName = JSON.parse(metric)['model']
                            providerName = JSON.parse(metric)['provider']
                        }

                        if (modelName) {
                            selectedModel = modelName
                        }
                        if (providerName) {
                            selectedProvider = providerName
                        }
                    }
                }
                if (selectedProvider && selectedModel) {
                    const modelConfig = await EvaluationRunner.getCostMetrics(selectedProvider, selectedModel)
                    if (modelConfig) {
                        val.push(JSON.stringify({ cost_values: modelConfig }))
                    }
                }
            } catch (error) {
                //stay silent
            }
        }
        EvaluationRunner.metrics.delete(id)
        return val
    }

    static addMetrics(id: string, metric: string) {
        if (EvaluationRunner.metrics.has(id)) {
            EvaluationRunner.metrics.get(id)?.push(metric)
        } else {
            EvaluationRunner.metrics.set(id, [metric])
        }
    }

    // Keep the constructor signature for server compatibility. Internal calls
    // are always resolved from canonical APP_URL by requestFlowisePrediction.
    constructor(_baseURL: string) {}

    getChatflowApiKey(chatflowId: string, apiKeys: { chatflowId: string; apiKey: string }[] = []) {
        return apiKeys.find((item) => item.chatflowId === chatflowId)?.apiKey || ''
    }

    public async runEvaluations(data: ICommonObject) {
        const chatflowIds = JSON.parse(data.chatflowId)

        if (!Array.isArray(chatflowIds)) {
            throw new Error('chatflowId must be a valid array')
        }

        if (!data.dataset || !Array.isArray(data.dataset.rows)) {
            throw new Error('dataset.rows must be a valid array')
        }

        const returnData: ICommonObject = {}
        returnData.evaluationId = data.evaluationId
        returnData.runDate = new Date()
        returnData.rows = []
        for (let i = 0; i < data.dataset.rows.length; i++) {
            returnData.rows.push({
                input: data.dataset.rows[i].input,
                expectedOutput: data.dataset.rows[i].output,
                itemNo: data.dataset.rows[i].sequenceNo,
                evaluations: [],
                status: 'pending'
            })
        }
        for (let i = 0; i < chatflowIds.length; i++) {
            const chatflowId = chatflowIds[i]
            await this.evaluateChatflow(chatflowId, this.getChatflowApiKey(chatflowId, data.apiKeys), data, returnData)
        }
        return returnData
    }

    async evaluateChatflow(chatflowId: string, apiKey: string, data: any, returnData: any) {
        for (let i = 0; i < data.dataset.rows.length; i++) {
            const item = data.dataset.rows[i]
            const uuid = uuidv4()
            let startTime = performance.now()
            const runData: any = {}
            runData.chatflowId = chatflowId
            runData.startTime = startTime
            const postData: any = { question: item.input, evaluationRunId: uuid, evaluation: true }
            if (data.sessionId) {
                postData.overrideConfig = { sessionId: data.sessionId }
            }
            try {
                const responseData = await requestFlowisePrediction({
                    flowId: chatflowId,
                    apiKey,
                    evaluationRequestId: uuid,
                    body: postData
                })
                let agentFlowMetrics: any[] = []
                if (responseData?.agentFlowExecutedData) {
                    for (let i = 0; i < responseData.agentFlowExecutedData.length; i++) {
                        const agentFlowExecutedData = responseData.agentFlowExecutedData[i]
                        const input_tokens = agentFlowExecutedData?.data?.output?.usageMetadata?.input_tokens || 0
                        const output_tokens = agentFlowExecutedData?.data?.output?.usageMetadata?.output_tokens || 0
                        const total_tokens =
                            agentFlowExecutedData?.data?.output?.usageMetadata?.total_tokens || input_tokens + output_tokens
                        const metrics: any = {
                            promptTokens: input_tokens,
                            completionTokens: output_tokens,
                            totalTokens: total_tokens,
                            provider:
                                agentFlowExecutedData.data?.input?.llmModelConfig?.llmModel ||
                                agentFlowExecutedData.data?.input?.agentModelConfig?.agentModel,
                            model:
                                agentFlowExecutedData.data?.input?.llmModelConfig?.modelName ||
                                agentFlowExecutedData.data?.input?.agentModelConfig?.modelName,
                            nodeLabel: agentFlowExecutedData?.nodeLabel,
                            nodeId: agentFlowExecutedData?.nodeId
                        }
                        if (metrics.provider && metrics.model) {
                            const modelConfig = await EvaluationRunner.getCostMetrics(metrics.provider, metrics.model)
                            if (modelConfig) {
                                metrics.cost_values = {
                                    input_cost: (modelConfig.cost_values.input_cost || 0) * (input_tokens / 1000),
                                    output_cost: (modelConfig.cost_values.output_cost || 0) * (output_tokens / 1000)
                                }
                                metrics.cost_values.total_cost = metrics.cost_values.input_cost + metrics.cost_values.output_cost
                            }
                        }
                        agentFlowMetrics.push(metrics)
                    }
                }
                const endTime = performance.now()
                const timeTaken = (endTime - startTime).toFixed(2)
                if (responseData?.metrics) {
                    runData.metrics = responseData.metrics
                    runData.metrics.push({
                        apiLatency: timeTaken
                    })
                } else {
                    runData.metrics = [
                        {
                            apiLatency: timeTaken
                        }
                    ]
                }
                if (agentFlowMetrics.length > 0) {
                    runData.nested_metrics = agentFlowMetrics
                }
                runData.status = 'complete'
                let resultText = ''
                if (responseData.text) resultText = responseData.text
                else if (responseData.json) resultText = '```json\n' + JSON.stringify(responseData.json, null, 2)
                else resultText = JSON.stringify(responseData, null, 2)

                runData.actualOutput = resultText
                runData.latency = timeTaken
                runData.error = ''
            } catch {
                runData.status = 'error'
                runData.actualOutput = ''
                runData.error = FLOWISE_REQUEST_ERROR
                const endTime = performance.now()
                const timeTaken = (endTime - startTime).toFixed(2)
                runData.metrics = [
                    {
                        apiLatency: timeTaken
                    }
                ]
                runData.latency = timeTaken
            }
            runData.uuid = uuid
            returnData.rows[i].evaluations.push(runData)
        }
        return returnData
    }
}
