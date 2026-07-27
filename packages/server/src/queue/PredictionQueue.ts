import { DataSource } from 'typeorm'
import { executeFlow } from '../utils/buildChatflow'
import { IComponentNodes, IExecuteFlowParams } from '../Interface'
import { Telemetry } from '../utils/telemetry'
import { CachePool } from '../CachePool'
import { RedisEventPublisher } from './RedisEventPublisher'
import { AbortControllerPool } from '../AbortControllerPool'
import { BaseQueue } from './BaseQueue'
import { RedisOptions } from 'bullmq'
import { UsageCacheManager } from '../UsageCacheManager'
import logger from '../utils/logger'
import { generateAgentflowv2 as generateAgentflowv2_json } from 'flowise-components'
import { databaseEntities } from '../utils'
import { executeCustomNodeFunction } from '../utils/executeCustomNodeFunction'

interface PredictionQueueOptions {
    appDataSource: DataSource
    telemetry: Telemetry
    cachePool: CachePool
    componentNodes: IComponentNodes
    abortControllerPool: AbortControllerPool
    usageCacheManager: UsageCacheManager
}

interface IGenerateAgentflowv2Params extends IExecuteFlowParams {
    prompt: string
    componentNodes: IComponentNodes
    toolNodes: IComponentNodes
    selectedChatModel: Record<string, any>
    question: string
    isAgentFlowGenerator: boolean
}

export class PredictionQueue extends BaseQueue {
    private componentNodes: IComponentNodes
    private telemetry: Telemetry
    private cachePool: CachePool
    private appDataSource: DataSource
    private abortControllerPool: AbortControllerPool
    private usageCacheManager: UsageCacheManager
    private redisPublisher: RedisEventPublisher
    private queueName: string

    constructor(name: string, connection: RedisOptions, options: PredictionQueueOptions) {
        super(name, connection)
        this.queueName = name
        this.componentNodes = options.componentNodes || {}
        this.telemetry = options.telemetry
        this.cachePool = options.cachePool
        this.appDataSource = options.appDataSource
        this.abortControllerPool = options.abortControllerPool
        this.usageCacheManager = options.usageCacheManager
        this.redisPublisher = new RedisEventPublisher()
        this.redisPublisher.connect()
    }

    public getQueueName() {
        return this.queueName
    }

    public getQueue() {
        return this.queue
    }

    async processJob(data: IExecuteFlowParams | IGenerateAgentflowv2Params) {
        const isAgentFlowGenerator = Object.prototype.hasOwnProperty.call(data, 'isAgentFlowGenerator')
        const isExecuteCustomFunction = Object.prototype.hasOwnProperty.call(data, 'isExecuteCustomFunction')
        const abortControllerId =
            !isAgentFlowGenerator && !isExecuteCustomFunction && data.chatflow?.id && data.chatId
                ? data.abortControllerId || `${data.chatflow.id}_${data.chatId}`
                : undefined

        // Register before the first await so an already-delivered queue abort
        // tombstone is consumed before any provider or database work starts.
        if (this.abortControllerPool && abortControllerId) {
            const signal = new AbortController()
            this.abortControllerPool.add(abortControllerId, signal)
            data.signal = signal
        }

        try {
            if (this.redisPublisher) {
                await this.redisPublisher.connect()
            }
            if (this.appDataSource) data.appDataSource = this.appDataSource
            if (this.telemetry) data.telemetry = this.telemetry
            if (this.cachePool) data.cachePool = this.cachePool
            if (this.usageCacheManager) data.usageCacheManager = this.usageCacheManager
            if (this.componentNodes) data.componentNodes = this.componentNodes
            if (this.redisPublisher) data.sseStreamer = this.redisPublisher

            if (isAgentFlowGenerator) {
                logger.info(`Generating Agentflow...`)
                const { prompt, componentNodes, toolNodes, selectedChatModel, question } = data as IGenerateAgentflowv2Params
                const options: Record<string, any> = {
                    appDataSource: this.appDataSource,
                    databaseEntities: databaseEntities,
                    logger: logger
                }
                return await generateAgentflowv2_json({ prompt, componentNodes, toolNodes, selectedChatModel }, question, options)
            }

            if (isExecuteCustomFunction) {
                const executeCustomFunctionData = data as any
                logger.info(`[${executeCustomFunctionData.orgId}]: Executing Custom Function...`)
                return await executeCustomNodeFunction({
                    appDataSource: this.appDataSource,
                    componentNodes: this.componentNodes,
                    data: executeCustomFunctionData.data,
                    workspaceId: executeCustomFunctionData.workspaceId,
                    orgId: executeCustomFunctionData.orgId,
                    canViewVariables: executeCustomFunctionData.canViewVariables
                })
            }

            return await executeFlow(data)
        } finally {
            if (this.abortControllerPool && abortControllerId) {
                this.abortControllerPool.remove(abortControllerId)
            }
        }
    }
}
