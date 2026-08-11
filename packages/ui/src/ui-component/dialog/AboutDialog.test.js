/** @jest-environment ./test/canvasless-jsdom-environment.cjs */
/* eslint-disable react/prop-types, unused-imports/no-unused-vars */

import '@testing-library/jest-dom'
// Jest's current JSX transform requires React in this test module.
import React from 'react'
import { render, screen } from '@testing-library/react'
import axios from 'axios'
import AboutDialog from './AboutDialog'

global.React = React

jest.mock('axios', () => ({
    __esModule: true,
    default: { get: jest.fn() }
}))

jest.mock('@/store/constant', () => ({
    baseURL: 'http://localhost'
}))

jest.mock('@mui/material', () => {
    const React = require('react')
    const Container = ({ children, component: _component, sx: _sx, ...props }) => <div {...props}>{children}</div>
    const Dialog = ({ children, open, 'aria-labelledby': labelledBy, 'aria-describedby': describedBy }) =>
        open ? (
            <div role='dialog' aria-labelledby={labelledBy} aria-describedby={describedBy}>
                {children}
            </div>
        ) : null
    const Table = ({ children, ...props }) => <table {...props}>{children}</table>
    const TableHead = ({ children }) => <thead>{children}</thead>
    const TableBody = ({ children }) => <tbody>{children}</tbody>
    const TableRow = ({ children }) => <tr>{children}</tr>
    const TableCell = ({ children, component, ...props }) => {
        const Cell = component === 'th' ? 'th' : 'td'
        return <Cell {...props}>{children}</Cell>
    }
    const Typography = ({ children, ...props }) => <p {...props}>{children}</p>

    return {
        Dialog,
        DialogContent: Container,
        DialogTitle: Container,
        TableContainer: Container,
        Table,
        TableHead,
        TableRow,
        TableCell,
        TableBody,
        Paper: Container,
        Typography
    }
})

const mockSuccessfulRequest = (currentData = { version: '3.1.3' }) => {
    axios.get.mockResolvedValueOnce({ data: currentData })
}

describe('AboutDialog version states', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        const portal = document.createElement('div')
        portal.id = 'portal'
        document.body.appendChild(portal)
    })

    afterEach(() => {
        document.getElementById('portal')?.remove()
    })

    it('shows a loading state before the current-version request settles', () => {
        axios.get.mockImplementation(() => new Promise(() => {}))

        render(<AboutDialog show onCancel={jest.fn()} />)

        expect(screen.getByRole('status')).toHaveTextContent('正在加载版本信息…')
        expect(screen.queryByRole('table')).not.toBeInTheDocument()
    })

    it('uses unique dialog ids whose accessible references point to real elements', () => {
        axios.get.mockImplementation(() => new Promise(() => {}))

        render(
            <>
                <AboutDialog show onCancel={jest.fn()} />
                <AboutDialog show onCancel={jest.fn()} />
            </>
        )

        const dialogs = screen.getAllByRole('dialog', { name: 'Flowise 版本' })
        expect(dialogs).toHaveLength(2)
        const titleIds = dialogs.map((dialog) => dialog.getAttribute('aria-labelledby'))
        const contentIds = dialogs.map((dialog) => dialog.getAttribute('aria-describedby'))
        expect(new Set(titleIds).size).toBe(2)
        expect(new Set(contentIds).size).toBe(2)
        for (const id of [...titleIds, ...contentIds]) {
            expect(id).toBeTruthy()
            expect(document.getElementById(id)).toBeInTheDocument()
        }
    })

    it('loads only the same-origin current version and renders it', async () => {
        mockSuccessfulRequest()

        render(<AboutDialog show onCancel={jest.fn()} />)

        const table = await screen.findByRole('table', { name: 'Flowise 版本信息表' })
        expect(table).toHaveTextContent('3.1.3')
        expect(table).not.toHaveTextContent('最新版本')
        expect(axios.get).toHaveBeenCalledTimes(1)
        expect(axios.get).toHaveBeenCalledWith('http://localhost/api/v1/version', {
            withCredentials: true,
            headers: { 'Content-type': 'application/json', 'x-request-from': 'internal' }
        })
        expect(axios.get.mock.calls.flat().join(' ')).not.toContain('api.github.com')
    })

    it('shows a distinct no-data state when successful responses are incomplete', async () => {
        mockSuccessfulRequest({ version: '' })

        render(<AboutDialog show onCancel={jest.fn()} />)

        expect(await screen.findByText('暂无可用版本信息。')).toHaveAttribute('role', 'status')
        expect(screen.queryByRole('table')).not.toBeInTheDocument()
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('clears prior data and shows only fixed safe feedback after a later failure', async () => {
        mockSuccessfulRequest()
        const { rerender } = render(<AboutDialog show onCancel={jest.fn()} />)
        expect(await screen.findByRole('table', { name: 'Flowise 版本信息表' })).toBeInTheDocument()

        rerender(<AboutDialog show={false} onCancel={jest.fn()} />)
        axios.get.mockRejectedValueOnce(new Error('RAW_VERSION_FAILURE_MUST_NOT_ESCAPE'))
        rerender(<AboutDialog show onCancel={jest.fn()} />)

        expect(await screen.findByRole('alert')).toHaveTextContent('版本信息加载失败，请稍后重试。')
        expect(screen.queryByRole('table')).not.toBeInTheDocument()
        expect(document.body).not.toHaveTextContent('RAW_VERSION_FAILURE_MUST_NOT_ESCAPE')
    })
})
