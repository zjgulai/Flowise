import { createChatStreamGuard } from './createChatStreamGuard'

const response = (ok, contentType = 'text/event-stream; charset=utf-8') => ({
    ok,
    headers: { get: () => contentType }
})

describe('createChatStreamGuard', () => {
    it('rejects HTTP and content-type failures before consuming the stream', () => {
        expect(() => createChatStreamGuard().assertOpenResponse(response(false))).toThrow('stream_http_error')
        expect(() => createChatStreamGuard().assertOpenResponse(response(true, 'application/json'))).toThrow('stream_content_type_error')
    })

    it('treats an unexpected close as failure and an explicit terminal event as success', () => {
        const interrupted = createChatStreamGuard()
        expect(() => interrupted.assertTerminalClose()).toThrow('stream_closed')

        const completed = createChatStreamGuard()
        completed.markTerminal()
        expect(() => completed.assertTerminalClose()).not.toThrow()
    })

    it('throws synchronously from the retry callback', () => {
        const guard = createChatStreamGuard()
        expect(() => guard.fail()).toThrow('stream_failed')
    })
})
