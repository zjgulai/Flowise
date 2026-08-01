/** @jest-environment ./test/canvasless-jsdom-environment.cjs */

import '@testing-library/jest-dom'
// Jest's current JSX transform requires React in this test module.
// eslint-disable-next-line unused-imports/no-unused-imports
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import ErrorBoundary from './ErrorBoundary'

describe('ErrorBoundary', () => {
    it('does not render or copy untrusted server details', () => {
        const writeText = jest.fn()
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
        const sensitiveSentinel = 'SENSITIVE_SERVER_DETAIL_MUST_NOT_ESCAPE'

        render(<ErrorBoundary error={{ response: { status: 500, data: { message: sensitiveSentinel } } }} />)

        expect(screen.queryByText(sensitiveSentinel)).not.toBeInTheDocument()
        expect(screen.getByText('页面加载失败，请稍后重试')).toBeInTheDocument()

        fireEvent.click(screen.getByLabelText('复制错误详情'))
        expect(writeText).toHaveBeenCalledWith('状态码：500\n页面加载失败，请稍后重试')
        expect(writeText.mock.calls.flat().join(' ')).not.toContain(sensitiveSentinel)
    })
})
