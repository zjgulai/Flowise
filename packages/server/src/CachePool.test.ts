import { CachePool } from './CachePool'

describe('CachePool MCP cache lifecycle', () => {
    const originalMode = process.env.MODE

    beforeEach(() => {
        delete process.env.MODE
    })

    afterAll(() => {
        if (originalMode === undefined) delete process.env.MODE
        else process.env.MODE = originalMode
    })

    it('removes and returns an MCP cache entry', async () => {
        const cachePool = new CachePool()
        const cached = { configFingerprint: 'fingerprint' }
        await cachePool.addMCPCache('workspace:server', cached)

        await expect(cachePool.removeMCPCache('workspace:server')).resolves.toBe(cached)
        await expect(cachePool.getMCPCache('workspace:server')).resolves.toBeUndefined()
    })

    it('serializes operations for the same MCP cache key', async () => {
        const cachePool = new CachePool()
        const events: string[] = []
        let releaseFirst!: () => void
        const firstGate = new Promise<void>((resolve) => {
            releaseFirst = resolve
        })

        const first = cachePool.withMCPCacheLock('workspace:server', async () => {
            events.push('first:start')
            await firstGate
            events.push('first:end')
        })
        await Promise.resolve()
        const second = cachePool.withMCPCacheLock('workspace:server', async () => {
            events.push('second:start')
            events.push('second:end')
        })
        await Promise.resolve()

        expect(events).toEqual(['first:start'])
        releaseFirst()
        await Promise.all([first, second])
        expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
    })
})
