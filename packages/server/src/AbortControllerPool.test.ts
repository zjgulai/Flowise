import { AbortControllerPool } from './AbortControllerPool'

describe('AbortControllerPool', () => {
    it('aborts and removes an already registered controller', () => {
        const pool = new AbortControllerPool()
        const controller = new AbortController()

        pool.add('flow_chat', controller)
        pool.abort('flow_chat')

        expect(controller.signal.aborted).toBe(true)
        expect(pool.get('flow_chat')).toBeUndefined()
    })

    it('consumes an abort that arrives before the controller is registered', () => {
        const pool = new AbortControllerPool()
        const controller = new AbortController()

        pool.abort('request:mcp:flow_chat')
        pool.add('request:mcp:flow_chat', controller)

        expect(controller.signal.aborted).toBe(true)
        expect(pool.get('request:mcp:flow_chat')).toBeUndefined()
    })

    it('allows a removed pending abort id to be reused safely', () => {
        const pool = new AbortControllerPool()
        const controller = new AbortController()

        pool.abort('request:mcp:flow_chat')
        pool.remove('request:mcp:flow_chat')
        pool.add('request:mcp:flow_chat', controller)

        expect(controller.signal.aborted).toBe(false)
        expect(pool.get('request:mcp:flow_chat')).toBe(controller)
    })

    it('does not retain reusable session-scoped chat IDs as pending aborts', () => {
        const pool = new AbortControllerPool()
        const controller = new AbortController()

        pool.abort('flow_chat')
        pool.add('flow_chat', controller)

        expect(controller.signal.aborted).toBe(false)
        expect(pool.get('flow_chat')).toBe(controller)
    })

    it('expires an unconsumed request tombstone after the bounded TTL', () => {
        jest.useFakeTimers()
        try {
            const pool = new AbortControllerPool()
            const controller = new AbortController()

            pool.abort('request:mcp:expired')
            jest.advanceTimersByTime(60_000)
            pool.add('request:mcp:expired', controller)

            expect(controller.signal.aborted).toBe(false)
        } finally {
            jest.useRealTimers()
        }
    })

    it('evicts the oldest tombstone when the bounded capacity is reached', () => {
        jest.useFakeTimers()
        try {
            const pool = new AbortControllerPool()
            for (let index = 0; index <= 10_000; index += 1) {
                pool.abort(`request:mcp:${index}`)
            }

            const oldestController = new AbortController()
            const newestController = new AbortController()
            pool.add('request:mcp:0', oldestController)
            pool.add('request:mcp:10000', newestController)

            expect(oldestController.signal.aborted).toBe(false)
            expect(newestController.signal.aborted).toBe(true)
        } finally {
            jest.useRealTimers()
        }
    })
})
