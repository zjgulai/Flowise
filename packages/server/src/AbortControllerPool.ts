import { REQUEST_SCOPED_ABORT_ID_PREFIX } from './utils/predictionCancellation'

/**
 * This pool is to keep track of abort controllers mapped to chatflowid_chatid
 */
export class AbortControllerPool {
    abortControllers: Record<string, AbortController> = {}
    private pendingAbortTimers = new Map<string, ReturnType<typeof setTimeout>>()

    private static readonly PENDING_ABORT_TTL_MS = 60_000
    private static readonly MAX_PENDING_ABORTS = 10_000

    /**
     * Add to the pool
     * @param {string} id
     * @param {AbortController} abortController
     */
    add(id: string, abortController: AbortController) {
        const pendingAbortTimer = this.pendingAbortTimers.get(id)
        if (pendingAbortTimer) {
            clearTimeout(pendingAbortTimer)
            this.pendingAbortTimers.delete(id)
            abortController.abort()
            return
        }
        this.abortControllers[id] = abortController
    }

    /**
     * Remove from the pool
     * @param {string} id
     */
    remove(id: string) {
        if (Object.prototype.hasOwnProperty.call(this.abortControllers, id)) {
            delete this.abortControllers[id]
        }
        const pendingAbortTimer = this.pendingAbortTimers.get(id)
        if (pendingAbortTimer) {
            clearTimeout(pendingAbortTimer)
            this.pendingAbortTimers.delete(id)
        }
    }

    /**
     * Get the abort controller
     * @param {string} id
     */
    get(id: string) {
        return this.abortControllers[id]
    }

    /**
     * Abort
     * @param {string} id
     */
    abort(id: string) {
        const abortController = this.abortControllers[id]
        if (abortController) {
            abortController.abort()
            this.remove(id)
            return
        }

        // Session-scoped chat IDs may be reused by later messages, so only
        // one-shot request IDs are safe to retain as pending tombstones.
        if (!id.startsWith(REQUEST_SCOPED_ABORT_ID_PREFIX)) return

        // Queue abort events can arrive just before PredictionQueue registers
        // its controller. Keep a short-lived, bounded tombstone so add() can
        // consume that event instead of silently losing the cancellation.
        if (this.pendingAbortTimers.has(id)) return

        if (this.pendingAbortTimers.size >= AbortControllerPool.MAX_PENDING_ABORTS) {
            const oldestId = this.pendingAbortTimers.keys().next().value
            if (oldestId) {
                const oldestTimer = this.pendingAbortTimers.get(oldestId)
                if (oldestTimer) clearTimeout(oldestTimer)
                this.pendingAbortTimers.delete(oldestId)
            }
        }

        const timer = setTimeout(() => {
            this.pendingAbortTimers.delete(id)
        }, AbortControllerPool.PENDING_ABORT_TTL_MS)
        timer.unref?.()
        this.pendingAbortTimers.set(id, timer)
    }
}
