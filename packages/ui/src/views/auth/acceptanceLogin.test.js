/** @jest-environment ./test/canvasless-jsdom-environment.cjs */

import '@testing-library/jest-dom'
// Jest's current JSX transform requires React in this test module.
// eslint-disable-next-line unused-imports/no-unused-imports
import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import AcceptanceLoginPage from './acceptanceLogin'

const mockRequest = jest.fn()
const mockDispatch = jest.fn()
const mockNavigate = jest.fn()
let mockApiState

jest.mock('@/hooks/useApi', () => ({
    __esModule: true,
    default: () => mockApiState
}))

jest.mock('@/api/auth', () => ({
    __esModule: true,
    default: { acceptanceLogin: jest.fn() }
}))

jest.mock('@/store', () => ({
    store: { dispatch: (...args) => mockDispatch(...args) }
}))

jest.mock('@/store/reducers/authSlice', () => ({
    loginSuccess: (payload) => ({ type: 'auth/loginSuccess', payload })
}))

jest.mock('react-router-dom', () => ({
    useNavigate: () => mockNavigate
}))

jest.mock('@/ui-component/cards/MainCard', () => ({
    __esModule: true,
    default: ({ children }) => <div>{children}</div>
}))

describe('AcceptanceLoginPage', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        mockApiState = {
            data: undefined,
            error: undefined,
            loading: false,
            request: mockRequest
        }
    })

    it('renders exactly one masked one-time-code field and denies empty submit', () => {
        render(<AcceptanceLoginPage />)

        const input = screen.getByLabelText(/^一次性认证码/)
        expect(document.querySelectorAll('input')).toHaveLength(1)
        expect(input).toHaveAttribute('type', 'password')
        expect(input).toHaveAttribute('autocomplete', 'one-time-code')
        expect(input).toHaveAttribute('maxlength', '43')
        expect(screen.getByRole('button', { name: '进入工作台' })).toBeDisabled()

        fireEvent.submit(screen.getByRole('button', { name: '进入工作台' }).closest('form'))
        expect(mockRequest).not.toHaveBeenCalled()
    })

    it('submits exactly one code-only request while pending', () => {
        const { rerender } = render(<AcceptanceLoginPage />)
        const input = screen.getByLabelText(/^一次性认证码/)
        fireEvent.change(input, { target: { value: 'A'.repeat(43) } })

        fireEvent.click(screen.getByRole('button', { name: '进入工作台' }))
        expect(mockRequest).toHaveBeenCalledWith({ code: 'A'.repeat(43) })

        mockApiState = { ...mockApiState, loading: true }
        rerender(<AcceptanceLoginPage />)
        fireEvent.click(screen.getByRole('button', { name: '进入工作台' }))

        expect(mockRequest).toHaveBeenCalledTimes(1)
        expect(screen.getByRole('button', { name: '进入工作台' })).toBeDisabled()
    })

    it('clears the field, dispatches the existing login action, and replaces navigation on success', () => {
        const { rerender } = render(<AcceptanceLoginPage />)
        fireEvent.change(screen.getByLabelText(/^一次性认证码/), { target: { value: 'A'.repeat(43) } })
        const safeUser = { id: 'synthetic-user', activeWorkspaceId: 'workspace-01' }

        mockApiState = { ...mockApiState, data: safeUser }
        rerender(<AcceptanceLoginPage />)

        expect(screen.getByLabelText(/^一次性认证码/)).toHaveValue('')
        expect(mockDispatch).toHaveBeenCalledWith({ type: 'auth/loginSuccess', payload: safeUser })
        expect(mockNavigate).toHaveBeenCalledWith('/account', { replace: true })
    })

    it('clears the field and shows only fixed feedback on failure', () => {
        const { rerender } = render(<AcceptanceLoginPage />)
        fireEvent.change(screen.getByLabelText(/^一次性认证码/), { target: { value: 'A'.repeat(43) } })

        mockApiState = { ...mockApiState, error: new Error('dynamic-cause-must-not-escape') }
        rerender(<AcceptanceLoginPage />)

        expect(screen.getByLabelText(/^一次性认证码/)).toHaveValue('')
        expect(screen.getByRole('alert')).toHaveTextContent('认证不可用或已失效，请重新生成一次性认证码。')
        expect(screen.getByRole('alert')).not.toHaveTextContent('dynamic-cause')
        expect(mockDispatch).not.toHaveBeenCalled()
        expect(mockNavigate).not.toHaveBeenCalled()
    })
})
