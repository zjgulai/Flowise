/** @jest-environment ./test/canvasless-jsdom-environment.cjs */
/* eslint-disable react/prop-types */
import '@testing-library/jest-dom'
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'

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

import DeleteConfirmDialog from './DeleteConfirmDialog'

describe('DeleteConfirmDialog accessibility', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="portal"></div>'
    })

    it('links a unique title and description and exposes an explicit cancel action', () => {
        const onCancel = jest.fn()
        render(
            <DeleteConfirmDialog
                show
                dialogProps={{ title: '删除旧版 OpenAI 助手', description: '不可恢复', cancelButtonName: '取消' }}
                onCancel={onCancel}
                onDelete={jest.fn()}
                onDeleteBoth={jest.fn()}
            />
        )

        const dialog = screen.getByRole('dialog', { name: '删除旧版 OpenAI 助手' })
        const titleId = dialog.getAttribute('aria-labelledby')
        const descriptionId = dialog.getAttribute('aria-describedby')
        expect(titleId).toBeTruthy()
        expect(descriptionId).toBeTruthy()
        expect(titleId).not.toBe(descriptionId)
        expect(document.getElementById(descriptionId)).toHaveTextContent('不可恢复')
        expect(screen.getByRole('button', { name: '仅删除 Flowise 记录' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: '永久删除 OpenAI 与 Flowise 记录' })).toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: '取消' }))
        expect(onCancel).toHaveBeenCalledTimes(1)
    })
})
