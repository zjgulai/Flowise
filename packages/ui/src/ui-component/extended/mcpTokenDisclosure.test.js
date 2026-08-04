import {
    clearMcpTokenDisclosure,
    issueMcpTokenDisclosure,
    issueMcpTokenDisclosureIfCurrent,
    retainMcpTokenDisclosureForConfig,
    selectMcpTokenDisclosure
} from './mcpTokenDisclosure'

const deferred = () => {
    let resolve
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise
    })
    return { promise, resolve }
}

describe('MCP one-time token disclosure', () => {
    it('retains an issued token through same-flow store refresh and props churn', () => {
        const issued = issueMcpTokenDisclosure('flow-a', 'one-time-token')
        const afterStoreRefresh = retainMcpTokenDisclosureForConfig(issued, 'flow-a')
        const afterPropsChurn = retainMcpTokenDisclosureForConfig(afterStoreRefresh, 'flow-a')

        expect(afterPropsChurn).toBe(issued)
        expect(afterPropsChurn.token).toBe('one-time-token')
    })

    it('clears the token only on revocation or a real flow switch', () => {
        const issued = issueMcpTokenDisclosure('flow-a', 'one-time-token')
        expect(retainMcpTokenDisclosureForConfig(issued, 'flow-b')).toEqual({ chatflowId: 'flow-b', token: '' })
        expect(clearMcpTokenDisclosure('flow-a')).toEqual({ chatflowId: 'flow-a', token: '' })
    })

    it('never selects a disclosure issued for a different flow', () => {
        const issued = issueMcpTokenDisclosure('flow-a', 'one-time-token')

        expect(selectMcpTokenDisclosure(issued, 'flow-a')).toBe('one-time-token')
        expect(selectMcpTokenDisclosure(issued, 'flow-b')).toBe('')
        expect(issueMcpTokenDisclosureIfCurrent('flow-a', 'flow-a', undefined)).toBeNull()
    })

    it('drops an old request token that resolves after the active flow changes', async () => {
        const pending = deferred()
        let activeChatflowId = 'flow-a'
        const requestedChatflowId = activeChatflowId
        const response = pending.promise.then((token) => issueMcpTokenDisclosureIfCurrent(activeChatflowId, requestedChatflowId, token))

        activeChatflowId = 'flow-b'
        pending.resolve('old-flow-token')

        await expect(response).resolves.toBeNull()
        expect(selectMcpTokenDisclosure(issueMcpTokenDisclosure('flow-a', 'old-flow-token'), activeChatflowId)).toBe('')
    })
})
