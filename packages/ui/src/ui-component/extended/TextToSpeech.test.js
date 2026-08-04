/** @jest-environment ./test/canvasless-jsdom-environment.cjs */

import { replaceOwnedAudioUrl, runLatestTtsTestRequest, runLatestVoiceRequest } from './TextToSpeech'

jest.mock('@/views/canvas/CredentialInputHandler', () => ({
    __esModule: true,
    default: () => null
}))

jest.mock('@/store/constant', () => ({
    baseURL: 'http://localhost',
    FLOWISE_CREDENTIAL_ID: 'FLOWISE_CREDENTIAL_ID',
    ErrorMessage: { TOKEN_EXPIRED: 'TOKEN_EXPIRED' }
}))

const createDeferred = () => {
    let resolve
    let reject
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

const createRequestHarness = () => {
    let latestRequestId = 0
    let voices = ['initial']
    let loading = true
    const failures = []
    const settlements = []

    const run = (requestId, requestPromise) =>
        runLatestVoiceRequest({
            requestId,
            isLatestRequest: (candidateRequestId) => candidateRequestId === latestRequestId,
            request: () => requestPromise,
            onSuccess: (nextVoices) => {
                voices = nextVoices
            },
            onFailure: (error) => {
                voices = []
                failures.push(error)
            },
            onSettled: () => {
                loading = false
                settlements.push(requestId)
            }
        })

    return {
        setLatestRequestId: (requestId) => {
            latestRequestId = requestId
            loading = true
        },
        run,
        getState: () => ({ voices, loading, failures, settlements })
    }
}

describe('runLatestVoiceRequest', () => {
    it('keeps the latest success when an older provider request fails later', async () => {
        const olderRequest = createDeferred()
        const latestRequest = createDeferred()
        const harness = createRequestHarness()

        harness.setLatestRequestId(1)
        const olderRun = harness.run(1, olderRequest.promise)
        harness.setLatestRequestId(2)
        const latestRun = harness.run(2, latestRequest.promise)

        latestRequest.resolve({ data: [{ id: 'latest-voice', name: '最新语音' }] })
        await latestRun
        olderRequest.reject(new Error('STALE_PROVIDER_FAILURE_MUST_NOT_SURFACE'))
        await olderRun

        expect(harness.getState()).toEqual({
            voices: [{ id: 'latest-voice', name: '最新语音' }],
            loading: false,
            failures: [],
            settlements: [2]
        })
    })

    it('keeps the latest failure when an older credential request succeeds later', async () => {
        const olderRequest = createDeferred()
        const latestRequest = createDeferred()
        const harness = createRequestHarness()
        const latestError = new Error('LATEST_SAFE_FAILURE')

        harness.setLatestRequestId(1)
        const olderRun = harness.run(1, olderRequest.promise)
        harness.setLatestRequestId(2)
        const latestRun = harness.run(2, latestRequest.promise)

        latestRequest.reject(latestError)
        await latestRun
        olderRequest.resolve({ data: [{ id: 'stale-voice', name: '过期语音' }] })
        await olderRun

        expect(harness.getState()).toEqual({
            voices: [],
            loading: false,
            failures: [latestError],
            settlements: [2]
        })
    })
})

describe('runLatestTtsTestRequest', () => {
    it('discards and cleans up a stale audio result without changing current state', async () => {
        const deferred = createDeferred()
        const onSuccess = jest.fn()
        const onFailure = jest.fn()
        const onSettled = jest.fn()
        const onStale = jest.fn()
        let latestRequestId = 1

        const run = runLatestTtsTestRequest({
            requestId: 1,
            isLatestRequest: (requestId) => requestId === latestRequestId,
            request: () => deferred.promise,
            onSuccess,
            onFailure,
            onSettled,
            onStale
        })
        latestRequestId = 2
        deferred.resolve('blob:stale-audio')
        await run

        expect(onStale).toHaveBeenCalledWith('blob:stale-audio')
        expect(onSuccess).not.toHaveBeenCalled()
        expect(onFailure).not.toHaveBeenCalled()
        expect(onSettled).not.toHaveBeenCalled()
    })

    it('applies and settles only the latest audio result', async () => {
        const onSuccess = jest.fn()
        const onFailure = jest.fn()
        const onSettled = jest.fn()

        await runLatestTtsTestRequest({
            requestId: 2,
            isLatestRequest: (requestId) => requestId === 2,
            request: async () => 'blob:latest-audio',
            onSuccess,
            onFailure,
            onSettled,
            onStale: jest.fn()
        })

        expect(onSuccess).toHaveBeenCalledWith('blob:latest-audio')
        expect(onFailure).not.toHaveBeenCalled()
        expect(onSettled).toHaveBeenCalledTimes(1)
    })

    it('ignores a stale failure', async () => {
        const deferred = createDeferred()
        const onFailure = jest.fn()
        const onSettled = jest.fn()
        let latestRequestId = 1

        const run = runLatestTtsTestRequest({
            requestId: 1,
            isLatestRequest: (requestId) => requestId === latestRequestId,
            request: () => deferred.promise,
            onSuccess: jest.fn(),
            onFailure,
            onSettled,
            onStale: jest.fn()
        })
        latestRequestId = 2
        deferred.reject(new Error('STALE_TTS_FAILURE_MUST_NOT_SURFACE'))
        await run

        expect(onFailure).not.toHaveBeenCalled()
        expect(onSettled).not.toHaveBeenCalled()
    })
})

describe('replaceOwnedAudioUrl', () => {
    it('revokes the previous owned URL when a newer result replaces it', () => {
        const ownedAudioUrlRef = { current: 'blob:previous' }
        const revokeObjectURL = jest.fn()

        expect(replaceOwnedAudioUrl({ ownedAudioUrlRef, nextAudioUrl: 'blob:latest', revokeObjectURL })).toBe('blob:latest')
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:previous')
        expect(ownedAudioUrlRef.current).toBe('blob:latest')
    })

    it('revokes the latest owned URL during reset or unmount and clears ownership', () => {
        const ownedAudioUrlRef = { current: 'blob:latest' }
        const revokeObjectURL = jest.fn()

        expect(replaceOwnedAudioUrl({ ownedAudioUrlRef, nextAudioUrl: null, revokeObjectURL })).toBeNull()
        expect(revokeObjectURL).toHaveBeenCalledWith('blob:latest')
        expect(ownedAudioUrlRef.current).toBeNull()
    })

    it('does not revoke a URL when ownership is unchanged', () => {
        const ownedAudioUrlRef = { current: 'blob:same' }
        const revokeObjectURL = jest.fn()

        replaceOwnedAudioUrl({ ownedAudioUrlRef, nextAudioUrl: 'blob:same', revokeObjectURL })
        expect(revokeObjectURL).not.toHaveBeenCalled()
    })
})
