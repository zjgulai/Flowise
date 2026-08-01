export const createChatStreamGuard = (expectedContentType = 'text/event-stream') => {
    let terminalReceived = false

    return {
        assertOpenResponse(response) {
            if (!response.ok) throw new Error('stream_http_error')
            const contentType = response.headers.get('content-type') || ''
            if (!contentType.toLowerCase().startsWith(expectedContentType)) throw new Error('stream_content_type_error')
        },
        markTerminal() {
            terminalReceived = true
        },
        assertTerminalClose() {
            if (!terminalReceived) throw new Error('stream_closed')
        },
        fail() {
            throw new Error('stream_failed')
        }
    }
}
