import type { Job, QueueEvents, QueueEventsProducer } from 'bullmq'

type QueuedPredictionJob<Result> = Pick<Job<any, Result>, 'remove' | 'waitUntilFinished'>
type PredictionAbortPublisher = Pick<QueueEventsProducer, 'publishEvent'>

export const REQUEST_SCOPED_ABORT_ID_PREFIX = 'request:'

export const createPredictionAbortError = (): Error => {
    const error = new Error('Request aborted')
    error.name = 'AbortError'
    return error
}

export const throwIfPredictionAborted = (signal?: AbortSignal): void => {
    if (signal?.aborted) {
        throw createPredictionAbortError()
    }
}

const cancelQueuedPrediction = async (
    job: QueuedPredictionJob<unknown>,
    publisher: PredictionAbortPublisher,
    abortControllerId: string,
    onCancellationError?: (error: unknown) => void
): Promise<void> => {
    let removeError: unknown
    try {
        // Waiting and delayed jobs can be removed before a worker starts them.
        await job.remove()
        return
    } catch (error) {
        // BullMQ rejects remove() for a locked active job. In that case the
        // existing worker-side abort channel cooperatively cancels execution.
        removeError = error
    }

    try {
        await publisher.publishEvent({
            eventName: 'abort',
            id: abortControllerId
        })
    } catch (error) {
        onCancellationError?.(new AggregateError([removeError, error], 'Failed to cancel queued prediction'))
    }
}

export const waitForQueuedPrediction = async <Result>(
    job: QueuedPredictionJob<Result>,
    queueEvents: QueueEvents,
    publisher: PredictionAbortPublisher,
    abortControllerId: string,
    signal: AbortSignal,
    onCancellationError?: (error: unknown) => void
): Promise<Result> => {
    if (signal.aborted) {
        await cancelQueuedPrediction(job, publisher, abortControllerId, onCancellationError)
        throw createPredictionAbortError()
    }

    let rejectAborted: (reason: Error) => void = () => {}
    const aborted = new Promise<never>((_resolve, reject) => {
        rejectAborted = reject
    })
    const onAbort = () => {
        // Reject the HTTP-side waiter immediately. Cancellation continues in
        // the background so a Redis round trip cannot delay disconnect cleanup.
        rejectAborted(createPredictionAbortError())
        void cancelQueuedPrediction(job, publisher, abortControllerId, onCancellationError)
    }

    signal.addEventListener('abort', onAbort, { once: true })
    try {
        return await Promise.race([job.waitUntilFinished(queueEvents), aborted])
    } finally {
        signal.removeEventListener('abort', onAbort)
    }
}
