const initializationOrder: string[] = []

const mockGetEncryptionKey = jest.fn(async () => {
    initializationOrder.push('getEncryptionKey')
})
const mockInitAuthSecrets = jest.fn(async () => {
    initializationOrder.push('initAuthSecrets')
})
const mockGetTokenHashSecret = jest.fn(() => {
    initializationOrder.push('getTokenHashSecret')
    return 'worker-document-store-version-token-secret-v1'
})
const mockInitializeDocumentStoreVersionTokenKey = jest.fn(() => {
    initializationOrder.push('initializeDocumentStoreVersionTokenKey')
})

let workerNumber = 0
const mockCreateWorker = jest.fn((): { id: string } => {
    initializationOrder.push('createWorker')
    workerNumber += 1
    return { id: `worker-${workerNumber}` }
})
const mockQueue = {
    createWorker: mockCreateWorker,
    getQueueName: jest.fn(() => 'test-prediction'),
    getWorker: jest.fn()
}
const mockQueueManager = {
    setupAllQueues: jest.fn(() => initializationOrder.push('setupAllQueues')),
    getQueue: jest.fn(() => mockQueue),
    getConnection: jest.fn(() => ({}))
}

jest.mock('../utils', () => ({ getEncryptionKey: mockGetEncryptionKey }))
jest.mock('../enterprise/utils/authSecrets', () => ({
    getTokenHashSecret: mockGetTokenHashSecret,
    initAuthSecrets: mockInitAuthSecrets
}))
jest.mock('../services/documentstore/documentStoreVersion', () => ({
    initializeDocumentStoreVersionTokenKey: mockInitializeDocumentStoreVersionTokenKey
}))
jest.mock('../queue/QueueManager', () => ({
    QueueManager: { getInstance: jest.fn(() => mockQueueManager) }
}))
jest.mock('./base', () => ({ BaseCommand: class {} }))
jest.mock('../DataSource', () => ({ getDataSource: jest.fn() }))
jest.mock('../utils/telemetry', () => ({ Telemetry: class {} }))
jest.mock('../NodesPool', () => ({ NodesPool: class {} }))
jest.mock('../CachePool', () => ({ CachePool: class {} }))
jest.mock('../AbortControllerPool', () => ({ AbortControllerPool: class {} }))
jest.mock('../UsageCacheManager', () => ({ UsageCacheManager: class {} }))
jest.mock('../IdentityManager', () => ({ IdentityManager: class {} }))
jest.mock('bullmq', () => ({
    QueueEvents: jest.fn().mockImplementation(() => ({ on: jest.fn() }))
}))
jest.mock('../utils/logger', () => ({
    __esModule: true,
    default: { info: jest.fn(), error: jest.fn() }
}))

import Worker, { initializeWorkerSecuritySecrets } from './worker'

describe('standalone worker security initialization', () => {
    beforeEach(() => {
        initializationOrder.length = 0
        workerNumber = 0
        jest.clearAllMocks()
    })

    it('loads encryption and auth secrets before deriving the Document Store token key', async () => {
        await initializeWorkerSecuritySecrets()

        expect(initializationOrder).toEqual([
            'getEncryptionKey',
            'initAuthSecrets',
            'getTokenHashSecret',
            'initializeDocumentStoreVersionTokenKey'
        ])
    })

    it('completes security initialization before queue setup or worker creation', async () => {
        const command = Object.create(Worker.prototype) as Worker
        jest.spyOn(command, 'prepareData').mockImplementation(async () => {
            initializationOrder.push('prepareData')
            return {
                appDataSource: {},
                telemetry: {},
                componentNodes: {},
                cachePool: {},
                abortControllerPool: { abort: jest.fn() },
                usageCacheManager: {},
                identityManager: {}
            } as never
        })
        const resume = jest.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin)

        try {
            await command.run()
        } finally {
            resume.mockRestore()
        }

        expect(initializationOrder.slice(0, 5)).toEqual([
            'getEncryptionKey',
            'initAuthSecrets',
            'getTokenHashSecret',
            'initializeDocumentStoreVersionTokenKey',
            'prepareData'
        ])
        expect(initializationOrder.indexOf('initializeDocumentStoreVersionTokenKey')).toBeLessThan(
            initializationOrder.indexOf('setupAllQueues')
        )
        expect(initializationOrder.indexOf('initializeDocumentStoreVersionTokenKey')).toBeLessThan(
            initializationOrder.indexOf('createWorker')
        )
        expect(mockCreateWorker).toHaveBeenCalledTimes(3)
    })
})
