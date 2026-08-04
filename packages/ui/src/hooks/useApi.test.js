/** @jest-environment ./test/canvasless-jsdom-environment.cjs */

import { act, renderHook } from '@testing-library/react'
import useApi from './useApi'

const mockHandleError = jest.fn()
const mockSetError = jest.fn()

jest.mock('@/store/context/ErrorContext', () => ({
    useError: () => ({ handleError: mockHandleError, setError: mockSetError })
}))

const deferred = () => {
    let resolve
    let reject
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

describe('useApi request ordering', () => {
    beforeEach(() => jest.clearAllMocks())

    it('ignores an older response that completes after a newer request starts', async () => {
        const first = deferred()
        const second = deferred()
        const api = jest.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
        const { result } = renderHook(() => useApi(api))

        act(() => {
            void result.current.request('assistant-a')
            void result.current.request('assistant-b')
        })
        await act(async () => first.resolve({ data: { id: 'assistant-a' } }))

        expect(result.current.data).toBeNull()
        expect(result.current.loading).toBe(true)

        await act(async () => second.resolve({ data: { id: 'assistant-b' } }))

        expect(result.current.data).toEqual({ id: 'assistant-b' })
        expect(result.current.loading).toBe(false)
    })

    it('invalidates an in-flight response when reset is called', async () => {
        const pending = deferred()
        const { result } = renderHook(() => useApi(() => pending.promise))

        act(() => {
            void result.current.request('assistant-a')
            result.current.reset()
        })
        await act(async () => pending.resolve({ data: { id: 'assistant-a' } }))

        expect(result.current.data).toBeNull()
        expect(result.current.error).toBeNull()
        expect(result.current.loading).toBe(false)
    })
})
