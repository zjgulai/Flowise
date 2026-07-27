import type { QueueEvents, QueueEventsProducer } from 'bullmq'
import { waitForQueuedPrediction } from './predictionCancellation'

const flushAsyncCancellation = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('waitForQueuedPrediction', () => {
    const queueEvents = {} as QueueEvents

    it('returns the completed queue result when the request remains connected', async () => {
        const job = {
            remove: jest.fn(),
            waitUntilFinished: jest.fn().mockResolvedValue({ text: 'done' })
        }
        const publisher = { publishEvent: jest.fn() } as unknown as QueueEventsProducer
        const controller = new AbortController()

        await expect(waitForQueuedPrediction(job as any, queueEvents, publisher, 'flow_chat', controller.signal)).resolves.toEqual({
            text: 'done'
        })
        expect(job.remove).not.toHaveBeenCalled()
        expect(publisher.publishEvent).not.toHaveBeenCalled()
    })

    it('removes a waiting job when the request was already aborted', async () => {
        const job = {
            remove: jest.fn().mockResolvedValue(undefined),
            waitUntilFinished: jest.fn()
        }
        const publisher = { publishEvent: jest.fn() } as unknown as QueueEventsProducer
        const controller = new AbortController()
        controller.abort()

        await expect(waitForQueuedPrediction(job as any, queueEvents, publisher, 'flow_chat', controller.signal)).rejects.toMatchObject({
            name: 'AbortError'
        })
        expect(job.remove).toHaveBeenCalledTimes(1)
        expect(job.waitUntilFinished).not.toHaveBeenCalled()
        expect(publisher.publishEvent).not.toHaveBeenCalled()
    })

    it('publishes an active-job abort when BullMQ cannot remove the locked job', async () => {
        const job = {
            remove: jest.fn().mockRejectedValue(new Error('Job is locked')),
            waitUntilFinished: jest.fn()
        }
        const publisher = { publishEvent: jest.fn().mockResolvedValue(undefined) } as unknown as QueueEventsProducer
        const controller = new AbortController()
        controller.abort()

        await expect(waitForQueuedPrediction(job as any, queueEvents, publisher, 'flow_chat', controller.signal)).rejects.toMatchObject({
            name: 'AbortError'
        })
        expect(publisher.publishEvent).toHaveBeenCalledWith({ eventName: 'abort', id: 'flow_chat' })
    })

    it('rejects the HTTP waiter immediately and cancels the queued job after a later disconnect', async () => {
        const neverFinishes = new Promise<never>(() => {})
        const job = {
            remove: jest.fn().mockResolvedValue(undefined),
            waitUntilFinished: jest.fn().mockReturnValue(neverFinishes)
        }
        const publisher = { publishEvent: jest.fn() } as unknown as QueueEventsProducer
        const controller = new AbortController()
        const waiting = waitForQueuedPrediction(job as any, queueEvents, publisher, 'flow_chat', controller.signal)

        controller.abort()

        await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
        await flushAsyncCancellation()
        expect(job.remove).toHaveBeenCalledTimes(1)
    })

    it('reports both removal and publish failures without delaying the abort result', async () => {
        const removeError = new Error('remove failed')
        const publishError = new Error('publish failed')
        const job = {
            remove: jest.fn().mockRejectedValue(removeError),
            waitUntilFinished: jest.fn()
        }
        const publisher = { publishEvent: jest.fn().mockRejectedValue(publishError) } as unknown as QueueEventsProducer
        const controller = new AbortController()
        const onCancellationError = jest.fn()
        controller.abort()

        await expect(
            waitForQueuedPrediction(job as any, queueEvents, publisher, 'flow_chat', controller.signal, onCancellationError)
        ).rejects.toMatchObject({ name: 'AbortError' })
        expect(onCancellationError).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'AggregateError',
                errors: [removeError, publishError]
            })
        )
    })
})
