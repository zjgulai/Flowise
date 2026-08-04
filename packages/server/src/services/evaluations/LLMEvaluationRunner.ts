import { convertSchemaToZod, ICommonObject } from 'flowise-components'
import { z } from 'zod/v3'
import { RunnableSequence } from '@langchain/core/runnables'
import { PromptTemplate } from '@langchain/core/prompts'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { databaseEntities } from '../../utils'
import credentialsService from '../credentials'
import { createWorkspaceOAuth2RefreshCapability } from '../oauth2CredentialRefresh'

const MAX_LLM_COMPONENT_NAME_LENGTH = 128
const MAX_LLM_MODEL_LENGTH = 512
const MAX_CREDENTIAL_ID_LENGTH = 256
const MAX_COMPONENT_FILE_PATH_LENGTH = 4096
const MODEL_INPUT_NAMES = new Set(['model', 'modelName'])
const MODEL_INPUT_TYPES = new Set(['asyncOptions', 'options', 'string'])

const isPlainRecord = (value: unknown): value is Record<string, any> => typeof value === 'object' && value !== null && !Array.isArray(value)

const requireBoundedString = (value: unknown, maximumLength: number): string => {
    if (typeof value !== 'string') throw new Error('Invalid evaluation chat model selection')
    const normalized = value.trim()
    if (!normalized || normalized.length > maximumLength || normalized.includes('\0')) {
        throw new Error('Invalid evaluation chat model selection')
    }
    return normalized
}

export interface EvaluationChatModelSelection {
    component: Record<string, any>
    nodeData: {
        id: string
        name: string
        inputs: Record<string, string>
        credential: string
    }
}

/**
 * Resolves an evaluation model only from the authoritative NodesPool entry.
 * This is deliberately side-effect free so callers can run it before any
 * dynamic import, model initialization, provider call, or evaluation write.
 */
export const resolveEvaluationChatModelSelection = (
    componentNodes: Record<string, any>,
    llmInput: unknown,
    modelInput: unknown,
    credentialIdInput: unknown
): EvaluationChatModelSelection => {
    const llm = requireBoundedString(llmInput, MAX_LLM_COMPONENT_NAME_LENGTH)
    if (!/^[A-Za-z0-9_-]+$/.test(llm) || !isPlainRecord(componentNodes) || !Object.prototype.hasOwnProperty.call(componentNodes, llm)) {
        throw new Error('Invalid evaluation chat model selection')
    }

    const component = componentNodes[llm]
    if (
        !isPlainRecord(component) ||
        component.name !== llm ||
        component.category !== 'Chat Models' ||
        !Array.isArray(component.baseClasses) ||
        !component.baseClasses.includes('BaseChatModel') ||
        !isPlainRecord(component.credential) ||
        component.credential.name !== 'credential' ||
        component.credential.type !== 'credential' ||
        !Array.isArray(component.credential.credentialNames) ||
        component.credential.credentialNames.length === 0 ||
        component.credential.credentialNames.some((name: unknown) => typeof name !== 'string' || !name.trim()) ||
        !Array.isArray(component.inputs)
    ) {
        throw new Error('Invalid evaluation chat model selection')
    }

    const filePath = requireBoundedString(component.filePath, MAX_COMPONENT_FILE_PATH_LENGTH)
    if (filePath !== component.filePath) throw new Error('Invalid evaluation chat model selection')

    const declaredModelInputs = component.inputs.filter(
        (input: unknown) =>
            isPlainRecord(input) &&
            typeof input.name === 'string' &&
            MODEL_INPUT_NAMES.has(input.name) &&
            typeof input.type === 'string' &&
            MODEL_INPUT_TYPES.has(input.type)
    )
    if (declaredModelInputs.length !== 1) throw new Error('Invalid evaluation chat model selection')

    const declaredModelInput = declaredModelInputs[0]
    const model = requireBoundedString(modelInput, MAX_LLM_MODEL_LENGTH)
    if (declaredModelInput.type === 'options') {
        if (
            !Array.isArray(declaredModelInput.options) ||
            !declaredModelInput.options.some(
                (option: unknown) =>
                    (typeof option === 'string' && option === model) ||
                    (isPlainRecord(option) && typeof option.name === 'string' && option.name === model)
            )
        ) {
            throw new Error('Invalid evaluation chat model selection')
        }
    }

    const credentialId = requireBoundedString(credentialIdInput, MAX_CREDENTIAL_ID_LENGTH)
    return {
        component,
        nodeData: {
            id: `${llm}_0`,
            name: llm,
            inputs: { [declaredModelInput.name]: model },
            credential: credentialId
        }
    }
}

export class LLMEvaluationRunner {
    private llm: any

    constructor(private readonly workspaceId: string) {}

    async runLLMEvaluators(data: ICommonObject, actualOutputArray: string[], errorArray: string[], llmEvaluatorMap: any[]) {
        const evaluationResults: any[] = []
        if (this.llm === undefined) {
            this.llm = await this.createLLM(data)
        }

        for (let j = 0; j < actualOutputArray.length; j++) {
            const actualOutput = actualOutputArray[j]
            for (let i = 0; i < llmEvaluatorMap.length; i++) {
                if (errorArray[j] !== '') {
                    evaluationResults.push({
                        error: 'Not Graded!'
                    })
                    continue
                }
                try {
                    const llmEvaluator = llmEvaluatorMap[i]
                    let evaluator = llmEvaluator.evaluator
                    const schema = z.object(convertSchemaToZod(JSON.stringify(evaluator.outputSchema)))
                    const modelWithStructuredOutput = this.llm.withStructuredOutput(schema, {
                        method: 'functionCalling'
                    })
                    const llmExecutor = RunnableSequence.from([
                        PromptTemplate.fromTemplate(evaluator.prompt as string),
                        modelWithStructuredOutput
                    ])
                    const response = await llmExecutor.invoke({
                        question: data.input,
                        actualOutput: actualOutput,
                        expectedOutput: data.expectedOutput
                    })
                    evaluationResults.push(response)
                } catch (error) {
                    evaluationResults.push({
                        error: 'error'
                    })
                }
            }
        }
        return evaluationResults
    }

    async createLLM(data: ICommonObject): Promise<any> {
        try {
            if (!this.workspaceId) throw new Error('Workspace is required')
            const appServer = getRunningExpressApp()
            if (!isPlainRecord(data) || !isPlainRecord(data.llmConfig)) throw new Error('Invalid evaluation chat model selection')
            const { component, nodeData } = resolveEvaluationChatModelSelection(
                appServer.nodesPool.componentNodes,
                data.llmConfig.llm,
                data.llmConfig.model,
                data.llmConfig.credentialId
            )
            await credentialsService.assertCredentialInWorkspace(nodeData.credential, this.workspaceId)
            const refreshOAuth2Credential = createWorkspaceOAuth2RefreshCapability(this.workspaceId)
            const nodeModule = await import(component.filePath)
            if (typeof nodeModule?.nodeClass !== 'function') throw new Error('Invalid evaluation chat model component')
            const newNodeInstance = new nodeModule.nodeClass()
            const options: ICommonObject = {
                appDataSource: appServer.AppDataSource,
                databaseEntities: databaseEntities,
                workspaceId: this.workspaceId,
                refreshOAuth2Credential
            }
            return await newNodeInstance.init(nodeData, undefined, options)
        } catch (error) {
            throw new Error('Error creating LLM')
        }
    }
}
