/** @jest-environment ./test/canvasless-jsdom-environment.cjs */
/* eslint-disable react/prop-types, react/display-name */
import '@testing-library/jest-dom'
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createTheme, ThemeProvider } from '@mui/material/styles'

global.React = React

jest.mock('react-redux', () => ({ useSelector: (selector) => selector({ customization: { isDarkMode: false } }) }))
jest.mock('@/ui-component/cards/MainCard', () => {
    const React = jest.requireActual('react')
    return React.forwardRef(({ children }, ref) => <div ref={ref}>{children}</div>)
})
jest.mock('@/ui-component/extended/ScheduleStatusBadge', () => () => null)
jest.mock('../tooltip/MoreItemsTooltip', () => ({ children }) => <>{children}</>)

import ItemCard, { getSafeItemCardIconSrc } from './ItemCard'

const theme = createTheme({ palette: { card: { hover: '#f5f5f5', main: '#ffffff' } }, darkTextPrimary: '#111111' })
const renderCard = (component) => render(<ThemeProvider theme={theme}>{component}</ThemeProvider>)

describe('ItemCard accessibility and icon safety', () => {
    it('uses a native keyboard-action surface for clickable cards', () => {
        const onClick = jest.fn()
        renderCard(<ItemCard data={{ name: '工单助手', description: '处理工单' }} onClick={onClick} />)
        const action = screen.getByRole('button', { name: '打开工单助手' })

        userEvent.tab()
        expect(action).toHaveFocus()
        userEvent.type(action, '{enter}', { skipClick: true })
        userEvent.type(action, ' ', { skipClick: true })

        expect(onClick).toHaveBeenCalledTimes(2)
    })

    it('rejects CSS multi-URL injection and never emits the attacker URL', () => {
        const malicious = '/icon.png),url(https://attacker.example/track'
        expect(getSafeItemCardIconSrc(malicious, 'https://flowagentic.example')).not.toContain('attacker.example')

        const { container } = renderCard(<ItemCard data={{ name: '安全卡片', iconSrc: malicious }} onClick={() => undefined} />)
        expect(container.innerHTML).not.toContain('attacker.example')
        expect(container.querySelector('[style*="background-image"]')).toBeNull()
    })
})
