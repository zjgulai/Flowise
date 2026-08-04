/** @jest-environment ./test/canvasless-jsdom-environment.cjs */
/* eslint-disable react/prop-types, react/display-name */
import '@testing-library/jest-dom'
import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

global.React = React

const mockGetAllAssistants = jest.fn()

jest.mock('react-router-dom', () => ({ useNavigate: () => jest.fn() }))
jest.mock('@/api/assistants', () => ({
    __esModule: true,
    default: { getAllAssistants: (...args) => mockGetAllAssistants(...args) }
}))
jest.mock('@/ui-component/cards/MainCard', () => ({ children }) => <main>{children}</main>)
jest.mock('@/ui-component/cards/ItemCard', () => ({ data, onClick }) => <button onClick={onClick}>{data.name}</button>)
jest.mock('./AssistantDialog', () => ({ show, dialogProps, onConfirm }) => (
    <>
        {show && <div>正在编辑 {dialogProps.data?.id}</div>}
        <button onClick={onConfirm}>触发刷新</button>
    </>
))
jest.mock('@/layout/MainLayout/ViewHeader', () => ({ children, title }) => (
    <header>
        <h1>{title}</h1>
        {children}
    </header>
))
jest.mock('@/store/constant', () => ({ gridSpacing: 3 }))
jest.mock('@mui/material', () => ({
    Alert: ({ children, action }) => (
        <div>
            {children}
            {action}
        </div>
    ),
    AlertTitle: ({ children }) => <div>{children}</div>,
    Box: ({ children }) => <div>{children}</div>,
    Button: ({ children, onClick }) => <button onClick={onClick}>{children}</button>,
    Link: ({ children, href }) => <a href={href}>{children}</a>,
    Stack: ({ children }) => <div>{children}</div>,
    Skeleton: () => <div>正在加载</div>
}))

import OpenAIAssistantLayout from './OpenAIAssistantLayout'

const createDeferred = () => {
    let resolve
    let reject
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise
        reject = rejectPromise
    })
    return { promise, resolve, reject }
}

const storedAssistant = (id, name) => ({
    id: `stored-${id}`,
    iconSrc: 'https://example.com/icon.svg',
    credential: 'credential-1',
    type: 'OPENAI',
    details: JSON.stringify({
        id,
        name,
        description: '',
        model: 'gpt-4.1',
        instructions: `${name} 指令`,
        temperature: 1,
        top_p: 1,
        tools: [],
        tool_resources: {}
    })
})

describe('OpenAIAssistantLayout request lifecycle', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it('aborts an older list request and ignores its late response after refresh', async () => {
        const older = createDeferred()
        const latest = createDeferred()
        mockGetAllAssistants.mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise)
        render(<OpenAIAssistantLayout />)
        await waitFor(() => expect(mockGetAllAssistants).toHaveBeenCalledTimes(1))
        const olderSignal = mockGetAllAssistants.mock.calls[0][1].signal

        fireEvent.click(screen.getByRole('button', { name: '触发刷新' }))
        await waitFor(() => expect(mockGetAllAssistants).toHaveBeenCalledTimes(2))
        expect(olderSignal.aborted).toBe(true)

        latest.resolve({ data: [storedAssistant('assistant-new', '新版助手')] })
        expect(await screen.findByText('新版助手')).toBeInTheDocument()
        older.resolve({ data: [storedAssistant('assistant-old', '旧版助手')] })
        await Promise.resolve()
        await Promise.resolve()

        expect(screen.queryByText('旧版助手')).not.toBeInTheDocument()
        expect(screen.getByText('新版助手')).toBeInTheDocument()
    })

    it('aborts the current list request on unmount', async () => {
        const pending = createDeferred()
        mockGetAllAssistants.mockReturnValueOnce(pending.promise)
        const { unmount } = render(<OpenAIAssistantLayout />)
        await waitFor(() => expect(mockGetAllAssistants).toHaveBeenCalledTimes(1))
        const signal = mockGetAllAssistants.mock.calls[0][1].signal

        unmount()

        expect(signal.aborted).toBe(true)
        pending.resolve({ data: [storedAssistant('assistant-late', '迟到助手')] })
    })

    it('keeps the sunset and migration notice visible when list loading fails', async () => {
        mockGetAllAssistants.mockRejectedValueOnce(new Error('private Provider response'))
        render(<OpenAIAssistantLayout />)

        expect(screen.getByText('OpenAI 助手 API 将于 2026 年 8 月 26 日停止服务')).toBeInTheDocument()
        expect(screen.getByText(/保存会同时更新 OpenAI 端助手和 Flowise 本地记录/)).toBeInTheDocument()
        expect(screen.getByRole('link', { name: '查看 OpenAI 官方迁移指南' })).toHaveAttribute(
            'href',
            'https://developers.openai.com/api/docs/assistants/migration'
        )
        expect(await screen.findByText('加载 OpenAI 助手失败，请稍后重试。')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument()
        expect(screen.getByRole('heading', { name: 'OpenAI 助手' })).toBeInTheDocument()
        expect(screen.queryByText('private Provider response')).not.toBeInTheDocument()
    })

    it('keeps an unnamed assistant visible and opens the original record for migration', async () => {
        const unnamed = storedAssistant('provider-unnamed-1234567890', '')
        mockGetAllAssistants.mockResolvedValueOnce({ data: [unnamed] })
        render(<OpenAIAssistantLayout />)

        const card = await screen.findByRole('button', { name: /未命名助手/ })
        expect(card).toHaveTextContent('provider-unnamed-1234567…')
        fireEvent.click(card)

        expect(screen.getByText(`正在编辑 ${unnamed.id}`)).toBeInTheDocument()
    })
})
