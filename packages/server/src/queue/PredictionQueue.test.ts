const mockRedisConnect = jest.fn()
const mockExecuteFlow = jest.fn()

jest.mock('./BaseQueue', () => ({
    BaseQueue: class {
        protected queue = {}

        constructor(_queueName: string, _connection: unknown) {}
    }
}))

jest.mock('./RedisEventPublisher', () => ({
    RedisEventPublisher: jest.fn().mockImplementation(() => ({
        connect: (...args: any[]) => mockRedisConnect(...args)
    }))
}))

jest.mock('../utils/buildChatflow', () => ({
    executeFlow: (...args: any[]) => mockExecuteFlow(...args)
}))

jest.mock('../utils/logger', () => ({
    __esModule: true,
    default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}))

jest.mock('flowise-components', () => ({
    generateAgentflowv2: jest.fn()
}))

jest.mock('../utils', () => ({
    databaseEntities: {}
}))

jest.mock('../utils/executeCustomNodeFunction', () => ({
    executeCustomNodeFunction: jest.fn()
}))

import { AbortControllerPool } from '../AbortControllerPool'
import { PredictionQueue } from './PredictionQueue'

const makeQueue = (abortControllerPool: AbortControllerPool) => {
    const queue = new PredictionQueue('test-prediction', {} as any, {
        appDataSource: {} as any,
        telemetry: {} as any,
        cachePool: {} as any,
        componentNodes: {},
        abortControllerPool,
        usageCacheManager: {} as any
    })
    mockRedisConnect.mockClear()
    return queue
}

const makeData = (abortControllerId: string) =>
    ({
        abortControllerId,
        chatflow: { id: 'flow-123' },
        chatId: 'chat-123'
    } as any)

beforeEach(() => {
    jest.clearAllMocks()
    mockRedisConnect.mockResolvedValue(undefined)
})

describe('PredictionQueue request-scoped cancellation', () => {
    it('consumes a pending abort before the first await and reaches executeFlow already aborted', async () => {
        const pool = new AbortControllerPool()
        const abortControllerId = 'request:mcp:flow-123_chat-123'
        const data = makeData(abortControllerId)
        pool.abort(abortControllerId)
        const queue = makeQueue(pool)

        mockRedisConnect.mockImplementation(async () => {
            expect(data.signal.signal.aborted).toBe(true)
        })
        mockExecuteFlow.mockImplementation(async (executeData) => {
            expect(executeData.signal.signal.aborted).toBe(true)
            throw new Error('Request aborted')
        })

        await expect(queue.processJob(data)).rejects.toThrow('Request aborted')
        expect(mockExecuteFlow).toHaveBeenCalledTimes(1)
        expect(pool.get(abortControllerId)).toBeUndefined()
    })

    it('removes the registered controller after normal completion', async () => {
        const pool = new AbortControllerPool()
        const abortControllerId = 'request:mcp:normal'
        const data = makeData(abortControllerId)
        const queue = makeQueue(pool)
        mockExecuteFlow.mockResolvedValue({ text: 'done' })

        await expect(queue.processJob(data)).resolves.toEqual({ text: 'done' })
        expect(data.signal.signal.aborted).toBe(false)
        expect(pool.get(abortControllerId)).toBeUndefined()
    })

    it('removes the registered controller after execution failure', async () => {
        const pool = new AbortControllerPool()
        const abortControllerId = 'request:mcp:failure'
        const data = makeData(abortControllerId)
        const queue = makeQueue(pool)
        mockExecuteFlow.mockRejectedValue(new Error('provider failed'))

        await expect(queue.processJob(data)).rejects.toThrow('provider failed')
        expect(pool.get(abortControllerId)).toBeUndefined()
    })
})
