export const clearMcpTokenDisclosure = (chatflowId = null) => ({ chatflowId, token: '' })

export const issueMcpTokenDisclosure = (chatflowId, token) => ({
    chatflowId,
    token: typeof token === 'string' ? token : ''
})

export const retainMcpTokenDisclosureForConfig = (current, chatflowId) =>
    current.chatflowId === chatflowId ? current : clearMcpTokenDisclosure(chatflowId)

export const selectMcpTokenDisclosure = (current, chatflowId) =>
    current?.chatflowId === chatflowId && typeof current.token === 'string' ? current.token : ''

export const issueMcpTokenDisclosureIfCurrent = (activeChatflowId, requestedChatflowId, token) =>
    activeChatflowId === requestedChatflowId && typeof token === 'string' && token.length > 0
        ? issueMcpTokenDisclosure(requestedChatflowId, token)
        : null
