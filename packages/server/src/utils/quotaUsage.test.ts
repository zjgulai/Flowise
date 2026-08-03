import { UsageCacheManager } from '../UsageCacheManager'
import logger from './logger'
import { checkPredictions, updatePredictionsUsage, updateStorageUsage } from './quotaUsage'

jest.mock('./logger', () => ({ __esModule: true, default: { error: jest.fn() } }))
jest.mock('./constants', () => ({
    LICENSE_QUOTAS: {
        STORAGE_LIMIT: 'storage',
        PREDICTIONS_LIMIT: 'predictions',
        FLOWS_LIMIT: 'flows',
        USERS_LIMIT: 'users',
        ADDITIONAL_SEATS_LIMIT: 'additionalSeats'
    }
}))

describe('storage usage cache reconciliation', () => {
    beforeEach(() => jest.clearAllMocks())

    it('does not reject or expose the cache error and allows the next absolute reconciliation', async () => {
        const set = jest.fn().mockRejectedValueOnce(new Error('RAW_CACHE_SECRET')).mockResolvedValueOnce(undefined)
        const usageCacheManager = { set } as unknown as UsageCacheManager

        await expect(updateStorageUsage('organization-1', 'workspace-1', 10, usageCacheManager)).resolves.toBeUndefined()
        await expect(updateStorageUsage('organization-1', 'workspace-1', 11, usageCacheManager)).resolves.toBeUndefined()

        expect(set).toHaveBeenNthCalledWith(1, 'storage:organization-1', 10)
        expect(set).toHaveBeenNthCalledWith(2, 'storage:organization-1', 11)
        expect(logger.error).toHaveBeenCalledWith('[server]: Storage usage cache update failed', { failedCount: 1 })
        expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('RAW_CACHE_SECRET')
    })

    it('does not turn a successful prediction into a failure when the post-success cache set rejects', async () => {
        const set = jest.fn().mockRejectedValueOnce(new Error('RAW_PREDICTION_CACHE_SECRET')).mockResolvedValueOnce(undefined)
        const usageCacheManager = {
            getQuotas: jest.fn().mockResolvedValue({ predictions: 100 }),
            get: jest.fn().mockResolvedValue(4),
            getTTL: jest.fn().mockResolvedValue(Date.now() + 60_000),
            set
        } as unknown as UsageCacheManager

        await expect(updatePredictionsUsage('organization-1', 'subscription-1', '', usageCacheManager)).resolves.toBeUndefined()
        await expect(updatePredictionsUsage('organization-1', 'subscription-1', '', usageCacheManager)).resolves.toBeUndefined()

        expect(set).toHaveBeenCalledTimes(2)
        expect(logger.error).toHaveBeenCalledWith('[server]: Predictions usage cache update failed', { failedCount: 1 })
        expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('RAW_PREDICTION_CACHE_SECRET')
    })

    it.each(['getQuotas', 'get', 'getTTL', 'getSubscriptionDetails'])(
        'keeps a post-success %s rejection best-effort and redacted',
        async (method) => {
            const usageCacheManager = {
                getQuotas: jest.fn().mockResolvedValue({ predictions: 100 }),
                get: jest.fn().mockResolvedValue(4),
                getTTL: jest.fn().mockResolvedValue(undefined),
                getSubscriptionDetails: jest.fn().mockResolvedValue({ created: 1_700_000_000 }),
                set: jest.fn().mockResolvedValue(undefined)
            }
            usageCacheManager[method as keyof typeof usageCacheManager].mockRejectedValue(new Error(`RAW_${method}_SECRET`))

            await expect(
                updatePredictionsUsage('organization-1', 'subscription-1', '', usageCacheManager as unknown as UsageCacheManager)
            ).resolves.toBeUndefined()
            expect(logger.error).toHaveBeenCalledWith('[server]: Predictions usage cache update failed', { failedCount: 1 })
            expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain(`RAW_${method}_SECRET`)
        }
    )

    it('keeps prediction preflight cache reads fail-closed', async () => {
        const usageCacheManager = {
            get: jest.fn().mockRejectedValue(new Error('cache unavailable')),
            getQuotas: jest.fn(),
            set: jest.fn()
        } as unknown as UsageCacheManager

        await expect(checkPredictions('organization-1', 'subscription-1', usageCacheManager)).rejects.toThrow('cache unavailable')
        expect(usageCacheManager.getQuotas).not.toHaveBeenCalled()
        expect(usageCacheManager.set).not.toHaveBeenCalled()
    })
})
