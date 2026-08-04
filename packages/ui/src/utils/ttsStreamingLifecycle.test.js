import { createTTSStreamResources, disposeTTSStreamResources, ownsTTSStream } from './ttsStreamingLifecycle'

describe('TTS streaming lifecycle', () => {
    it('disposes every browser resource exactly once', () => {
        const resources = createTTSStreamResources(3, 'message-3')
        resources.abortController = { abort: jest.fn() }
        resources.reader = { cancel: jest.fn().mockResolvedValue(undefined) }
        resources.sourceBufferUpdateHandler = jest.fn()
        resources.sourceBuffer = {
            updating: true,
            abort: jest.fn(),
            removeEventListener: jest.fn()
        }
        resources.sourceOpenHandler = jest.fn()
        resources.mediaSource = {
            readyState: 'open',
            endOfStream: jest.fn(),
            removeEventListener: jest.fn()
        }
        resources.audioPlayingHandler = jest.fn()
        resources.audioEndedHandler = jest.fn()
        resources.audioErrorHandler = jest.fn()
        resources.audio = {
            pause: jest.fn(),
            load: jest.fn(),
            removeAttribute: jest.fn(),
            removeEventListener: jest.fn()
        }
        resources.objectUrl = 'blob:tts-test'
        const revokeObjectURL = jest.fn()

        expect(disposeTTSStreamResources(resources, revokeObjectURL)).toBe(true)
        expect(disposeTTSStreamResources(resources, revokeObjectURL)).toBe(false)
        expect(resources.abortController.abort).toHaveBeenCalledTimes(1)
        expect(resources.reader.cancel).toHaveBeenCalledTimes(1)
        expect(resources.sourceBuffer.abort).toHaveBeenCalledTimes(1)
        expect(resources.mediaSource.endOfStream).toHaveBeenCalledTimes(1)
        expect(resources.audio.pause).toHaveBeenCalledTimes(1)
        expect(resources.audio.load).toHaveBeenCalledTimes(1)
        expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    })

    it('continues cleanup when reader cancellation throws synchronously', () => {
        const resources = createTTSStreamResources(4, 'message-4')
        resources.reader = {
            cancel: jest.fn(() => {
                throw new Error('cancel failed')
            })
        }
        resources.audio = {
            pause: jest.fn(),
            load: jest.fn(),
            removeAttribute: jest.fn(),
            removeEventListener: jest.fn()
        }

        expect(() => disposeTTSStreamResources(resources)).not.toThrow()
        expect(resources.audio.pause).toHaveBeenCalledTimes(1)
    })

    it('rejects stale resources after a newer session takes ownership', () => {
        const oldResources = createTTSStreamResources(1, 'old')
        const resourcesRef = { current: oldResources }
        expect(ownsTTSStream(resourcesRef, oldResources, 1)).toBe(true)

        resourcesRef.current = createTTSStreamResources(2, 'new')
        expect(ownsTTSStream(resourcesRef, oldResources, 1)).toBe(false)
        expect(ownsTTSStream(resourcesRef, resourcesRef.current, 2)).toBe(true)
    })
})
