jest.mock('./utils/constants', () => ({
    LICENSE_QUOTAS: {
        PREDICTIONS_LIMIT: 'quota:predictions',
        STORAGE_LIMIT: 'quota:storage',
        FLOWS_LIMIT: 'quota:flows',
        USERS_LIMIT: 'quota:users',
        ADDITIONAL_SEATS_LIMIT: 'quota:additional-seats'
    }
}))

jest.mock('./StripeManager', () => ({
    StripeManager: { getInstance: jest.fn() }
}))

import { UsageCacheManager } from './UsageCacheManager'

describe('UsageCacheManager write completion', () => {
    it('propagates cache set rejection to the caller', async () => {
        const manager = new UsageCacheManager()
        const cacheError = new Error('synthetic-cache-write-failure')
        const cache = { set: jest.fn().mockRejectedValue(cacheError) }
        ;(manager as unknown as { cache: typeof cache }).cache = cache

        await expect(manager.set('key', { value: 1 }, 1000)).rejects.toBe(cacheError)
        expect(cache.set).toHaveBeenCalledWith('key', { value: 1 }, 1000)
    })

    it('does not resolve a subscription cache update before the underlying write completes', async () => {
        const manager = new UsageCacheManager()
        let releaseWrite: (() => void) | undefined
        const cache = {
            get: jest.fn().mockResolvedValue({ quotas: { existing: 1 } }),
            set: jest.fn(
                () =>
                    new Promise<void>((resolve) => {
                        releaseWrite = resolve
                    })
            )
        }
        ;(manager as unknown as { cache: typeof cache }).cache = cache

        let settled = false
        const update = manager.updateSubscriptionDataToCache('subscription-1', { productId: 'product-1' }).then(() => {
            settled = true
        })
        await Promise.resolve()
        await new Promise<void>((resolve) => setImmediate(resolve))

        expect(cache.set).toHaveBeenCalledWith(
            'subscription:subscription-1',
            { quotas: { existing: 1 }, productId: 'product-1' },
            3_600_000
        )
        expect(settled).toBe(false)

        releaseWrite?.()
        await update
        expect(settled).toBe(true)
    })
})
