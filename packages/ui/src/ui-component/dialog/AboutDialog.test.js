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

const latestRelease = {
    name: 'v9.9.9',
    html_url: 'https://github.com/FlowiseAI/Flowise/releases/tag/v9.9.9',
    published_at: '2026-08-01T00:00:00.000Z'
}

const mockSuccessfulRequests = (releaseData = latestRelease, currentData = { version: '3.1.3' }) => {
    axios.get.mockResolvedValueOnce({ data: releaseData }).mockResolvedValueOnce({ data: currentData })
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

    it('shows a loading state before either version request settles', () => {
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

    it('renders the version table only for complete valid data', async () => {
        mockSuccessfulRequests()

        render(<AboutDialog show onCancel={jest.fn()} />)

        const table = await screen.findByRole('table', { name: 'Flowise 版本信息表' })
        expect(table).toHaveTextContent('3.1.3')
        expect(table).toHaveTextContent('v9.9.9')
        expect(screen.getByRole('link', { name: 'v9.9.9' })).toHaveAttribute('href', latestRelease.html_url)
    })

    it('shows a distinct no-data state when successful responses are incomplete', async () => {
        mockSuccessfulRequests({ name: '', html_url: '', published_at: '' }, { version: '' })

        render(<AboutDialog show onCancel={jest.fn()} />)

        expect(await screen.findByText('暂无可用版本信息。')).toHaveAttribute('role', 'status')
        expect(screen.queryByRole('table')).not.toBeInTheDocument()
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('clears prior data and shows only fixed safe feedback after a later failure', async () => {
        mockSuccessfulRequests()
        const { rerender } = render(<AboutDialog show onCancel={jest.fn()} />)
        expect(await screen.findByRole('table', { name: 'Flowise 版本信息表' })).toBeInTheDocument()

        rerender(<AboutDialog show={false} onCancel={jest.fn()} />)
        axios.get
            .mockRejectedValueOnce(new Error('RAW_GITHUB_FAILURE_MUST_NOT_ESCAPE'))
            .mockResolvedValueOnce({ data: { version: '3.1.3' } })
        rerender(<AboutDialog show onCancel={jest.fn()} />)

        expect(await screen.findByRole('alert')).toHaveTextContent('版本信息加载失败，请稍后重试。')
        expect(screen.queryByRole('table')).not.toBeInTheDocument()
        expect(document.body).not.toHaveTextContent('RAW_GITHUB_FAILURE_MUST_NOT_ESCAPE')
    })
})
