export const createTTSStreamResources = (sessionId = 0, chatMessageId = null) => ({
    sessionId,
    chatMessageId,
    disposed: false,
    ended: false,
    abortController: null,
    reader: null,
    mediaSource: null,
    sourceBuffer: null,
    audio: null,
    objectUrl: null,
    sourceOpenHandler: null,
    initializationWatchdog: null,
    sourceBufferUpdateHandler: null,
    audioPlayingHandler: null,
    audioEndedHandler: null,
    audioErrorHandler: null,
    chunkQueue: []
})

export const ownsTTSStream = (resourcesRef, resources, sessionId = resources?.sessionId) =>
    resourcesRef.current === resources && resources?.sessionId === sessionId && !resources.disposed

export const disposeTTSStreamResources = (resources, revokeObjectURL = (url) => URL.revokeObjectURL(url)) => {
    if (!resources || resources.disposed) return false
    resources.disposed = true

    if (resources.initializationWatchdog) clearTimeout(resources.initializationWatchdog)
    resources.abortController?.abort()
    if (resources.reader) {
        try {
            Promise.resolve(resources.reader.cancel()).catch(() => {})
        } catch {
            // Continue releasing the remaining resources.
        }
    }

    if (resources.sourceBuffer && resources.sourceBufferUpdateHandler) {
        resources.sourceBuffer.removeEventListener('updateend', resources.sourceBufferUpdateHandler)
    }
    if (resources.sourceBuffer?.updating) {
        try {
            resources.sourceBuffer.abort()
        } catch {
            // The SourceBuffer may already be detached.
        }
    }
    if (resources.mediaSource && resources.sourceOpenHandler) {
        resources.mediaSource.removeEventListener('sourceopen', resources.sourceOpenHandler)
    }
    if (resources.audio) {
        if (resources.audioPlayingHandler) resources.audio.removeEventListener('playing', resources.audioPlayingHandler)
        if (resources.audioEndedHandler) resources.audio.removeEventListener('ended', resources.audioEndedHandler)
        if (resources.audioErrorHandler) resources.audio.removeEventListener('error', resources.audioErrorHandler)
        resources.audio.pause()
        resources.audio.removeAttribute('src')
        resources.audio.load()
    }
    if (resources.mediaSource?.readyState === 'open') {
        try {
            resources.mediaSource.endOfStream()
        } catch {
            // The browser may have already closed the stream.
        }
    }
    if (resources.objectUrl) revokeObjectURL(resources.objectUrl)

    return true
}
