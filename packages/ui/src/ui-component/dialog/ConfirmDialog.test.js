/** @jest-environment ./test/canvasless-jsdom-environment.cjs */
/* eslint-disable react/prop-types */
import '@testing-library/jest-dom'
import React, { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

global.React = React

jest.mock('@mui/material', () => ({
    Button: ({ children, ...props }) => <button {...props}>{children}</button>,
    Dialog: ({ children, open, 'aria-labelledby': labelledBy, 'aria-describedby': describedBy }) =>
        open ? (
            <div role='dialog' aria-labelledby={labelledBy} aria-describedby={describedBy}>
                {children}
            </div>
        ) : null,
    DialogActions: ({ children }) => <div>{children}</div>,
    DialogContent: ({ children, id }) => <div id={id}>{children}</div>,
    DialogTitle: ({ children, id }) => <h2 id={id}>{children}</h2>
}))
jest.mock('@/ui-component/button/StyledButton', () => ({
    StyledButton: ({ children, ...props }) => <button {...props}>{children}</button>
}))

import useConfirm from '@/hooks/useConfirm'
import ConfirmContextProvider from '@/store/context/ConfirmContextProvider'
import ConfirmDialog from './ConfirmDialog'

const Requester = ({ label = '打开确认', onPromise }) => {
    const { confirm } = useConfirm()
    return (
        <button
            onClick={() => {
                const result = confirm({
                    title: label,
                    description: `${label}说明`,
                    confirmButtonName: '确认',
                    cancelButtonName: '取消'
                })
                onPromise?.(result)
            }}
        >
            {label}
        </button>
    )
}

describe('ConfirmDialog request lifecycle', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="portal"></div>'
    })

    it('renders only one modal when multiple renderer instances are mounted', async () => {
        render(
            <ConfirmContextProvider>
                <Requester />
                <ConfirmDialog />
                <ConfirmDialog />
            </ConfirmContextProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: '打开确认' }))

        const dialogs = await screen.findAllByRole('dialog')
        expect(dialogs).toHaveLength(1)
        const titleId = dialogs[0].getAttribute('aria-labelledby')
        const descriptionId = dialogs[0].getAttribute('aria-describedby')
        expect(titleId).toBeTruthy()
        expect(descriptionId).toBeTruthy()
        expect(titleId).not.toBe(descriptionId)
        expect(document.getElementById(titleId)).toHaveTextContent('打开确认')
        expect(document.getElementById(descriptionId)).toHaveTextContent('打开确认说明')
    })

    it('fails closed when a newer request replaces the active request', async () => {
        const firstResult = jest.fn()
        const secondResult = jest.fn()
        render(
            <ConfirmContextProvider>
                <Requester label='第一项' onPromise={(promise) => promise.then(firstResult)} />
                <Requester label='第二项' onPromise={(promise) => promise.then(secondResult)} />
                <ConfirmDialog />
            </ConfirmContextProvider>
        )

        fireEvent.click(screen.getByRole('button', { name: '第一项' }))
        await screen.findByRole('dialog', { name: '第一项' })
        fireEvent.click(screen.getByRole('button', { name: '第二项' }))

        await waitFor(() => expect(firstResult).toHaveBeenCalledWith(false))
        expect(screen.getAllByRole('dialog')).toHaveLength(1)
        expect(screen.getByRole('dialog', { name: '第二项' })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: '取消' }))
        await waitFor(() => expect(secondResult).toHaveBeenCalledWith(false))
    })

    it('settles false and removes the modal when the requesting subtree unmounts', async () => {
        const settled = jest.fn()
        const Host = () => {
            const [showRequester, setShowRequester] = useState(true)
            return (
                <ConfirmContextProvider>
                    {showRequester && <Requester label='助手内确认' onPromise={(promise) => promise.then(settled)} />}
                    <button onClick={() => setShowRequester(false)}>卸载助手对话框</button>
                    <ConfirmDialog />
                </ConfirmContextProvider>
            )
        }
        render(<Host />)

        fireEvent.click(screen.getByRole('button', { name: '助手内确认' }))
        await screen.findByRole('dialog', { name: '助手内确认' })
        fireEvent.click(screen.getByRole('button', { name: '卸载助手对话框' }))

        await waitFor(() => expect(settled).toHaveBeenCalledWith(false))
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    })

    it('settles false if the active renderer or provider unmounts', async () => {
        const rendererSettled = jest.fn()
        const RendererHost = () => {
            const [showRenderer, setShowRenderer] = useState(true)
            return (
                <ConfirmContextProvider>
                    <Requester label='渲染器确认' onPromise={(promise) => promise.then(rendererSettled)} />
                    <button onClick={() => setShowRenderer(false)}>卸载渲染器</button>
                    {showRenderer && <ConfirmDialog />}
                </ConfirmContextProvider>
            )
        }
        render(<RendererHost />)
        fireEvent.click(screen.getByRole('button', { name: '渲染器确认' }))
        await screen.findByRole('dialog')
        fireEvent.click(screen.getByRole('button', { name: '卸载渲染器' }))
        await waitFor(() => expect(rendererSettled).toHaveBeenCalledWith(false))
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

        const providerSettled = jest.fn()
        const view = render(
            <ConfirmContextProvider>
                <Requester label='Provider 确认' onPromise={(promise) => promise.then(providerSettled)} />
                <ConfirmDialog />
            </ConfirmContextProvider>
        )
        fireEvent.click(screen.getByRole('button', { name: 'Provider 确认' }))
        await screen.findByRole('dialog')
        view.unmount()
        await waitFor(() => expect(providerSettled).toHaveBeenCalledWith(false))
    })
})
