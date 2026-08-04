/** @jest-environment ./test/canvasless-jsdom-environment.cjs */
/* eslint-disable react/prop-types, react/display-name */
import '@testing-library/jest-dom'
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

global.React = React

const mockNavigate = jest.fn()

jest.mock('react-router-dom', () => ({ useNavigate: () => mockNavigate }))
jest.mock('react-redux', () => ({ useSelector: (selector) => selector({ customization: { isDarkMode: false } }) }))
jest.mock('@/ui-component/cards/MainCard', () => ({ children }) => <main>{children}</main>)
jest.mock('@/layout/MainLayout/ViewHeader', () => ({ title }) => <h1>{title}</h1>)

const Assistants = require('./index').default

describe('Assistants entry cards', () => {
    beforeEach(() => jest.clearAllMocks())

    it('activates both entry cards with Enter and Space from the keyboard', () => {
        render(<Assistants />)
        const custom = screen.getByRole('button', { name: '打开自定义助手' })
        const legacy = screen.getByRole('button', { name: '打开OpenAI 助手' })

        userEvent.tab()
        expect(custom).toHaveFocus()
        userEvent.type(custom, '{enter}', { skipClick: true })
        userEvent.tab()
        expect(legacy).toHaveFocus()
        userEvent.type(legacy, ' ', { skipClick: true })

        expect(mockNavigate).toHaveBeenNthCalledWith(1, '/assistants/custom')
        expect(mockNavigate).toHaveBeenNthCalledWith(2, '/assistants/openai')
        expect(screen.getByText(/保存会同时更新 OpenAI 端助手和 Flowise 本地记录/)).toBeInTheDocument()
    })
})
