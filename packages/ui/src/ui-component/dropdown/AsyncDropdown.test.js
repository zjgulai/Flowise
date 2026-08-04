/** @jest-environment ./test/canvasless-jsdom-environment.cjs */
/* eslint-disable react/prop-types, unused-imports/no-unused-vars */

import '@testing-library/jest-dom'
// Jest's current JSX transform requires React in this test module.
import React from 'react'
import { render, screen } from '@testing-library/react'
import axios from 'axios'
import credentialsApi from '@/api/credentials'
import { AsyncDropdown, buildNodeLoadMethodUrl, parseAsyncMultiValue } from './AsyncDropdown'

global.React = React

jest.mock('react-redux', () => ({
    useSelector: () => ({ isDarkMode: false })
}))

jest.mock('axios', () => ({
    __esModule: true,
    default: { post: jest.fn() }
}))

jest.mock('@/api/credentials', () => ({
    __esModule: true,
    default: { getCredentialsByName: jest.fn() }
}))

jest.mock('@/store/constant', () => ({
    baseURL: 'http://localhost'
}))

jest.mock('@mui/material/styles', () => ({
    useTheme: () => ({ palette: { grey: { 900: '#111' } } }),
    styled: (Component) => () => Component
}))

jest.mock('@mui/material/Autocomplete', () => {
    const React = require('react')

    const MockAutocomplete = ({ renderInput, noOptionsText, options, loading, value }) => (
        <div
            data-testid='autocomplete'
            data-loading={loading ? 'true' : 'false'}
            data-value-count={Array.isArray(value) ? String(value.length) : 'invalid'}
        >
            {renderInput({
                InputProps: { startAdornment: null, endAdornment: null },
                inputProps: {},
                FormHelperTextProps: {}
            })}
            {!loading && options.length === 0 && <div data-testid='no-options'>{noOptionsText}</div>}
            {!loading && options.map((option) => <div key={option.name}>{option.label}</div>)}
        </div>
    )

    return {
        __esModule: true,
        default: MockAutocomplete,
        autocompleteClasses: { listbox: 'listbox' },
        createFilterOptions: () => () => []
    }
})

jest.mock('@mui/material', () => {
    const React = require('react')
    const Passthrough = ({ children }) => <div>{children}</div>
    const TextField = ({ helperText, FormHelperTextProps = {}, error }) => (
        <div>
            <input aria-label='异步选项' />
            {helperText && (
                <span {...FormHelperTextProps} data-error={error ? 'true' : 'false'}>
                    {helperText}
                </span>
            )}
        </div>
    )

    return {
        Popper: Passthrough,
        CircularProgress: () => <span>loading</span>,
        TextField,
        Box: Passthrough,
        Typography: Passthrough,
        Tooltip: Passthrough
    }
})

const nodeData = {
    id: 'node-1',
    name: 'syntheticNode',
    inputParams: [{ name: 'model', type: 'asyncOptions', loadMethod: 'listModels' }],
    inputs: {}
}

const renderDropdown = (props = {}) =>
    render(<AsyncDropdown name='model' nodeData={nodeData} value='' onSelect={jest.fn()} onCreateNew={jest.fn()} {...props} />)

describe('AsyncDropdown load states', () => {
    beforeEach(() => {
        jest.clearAllMocks()
    })

    it('shows the fixed nearby failure state for a rejected node load without raw details', async () => {
        axios.post.mockRejectedValueOnce(new Error('RAW_NODE_LOAD_DETAIL_MUST_NOT_ESCAPE'))

        renderDropdown()

        expect(await screen.findByRole('alert')).toHaveTextContent('加载选项失败，请稍后重试')
        expect(screen.getByTestId('no-options')).toHaveTextContent('加载选项失败，请稍后重试')
        expect(document.body).not.toHaveTextContent('RAW_NODE_LOAD_DETAIL_MUST_NOT_ESCAPE')
        expect(credentialsApi.getCredentialsByName).not.toHaveBeenCalled()
    })

    it('uses the same safe failure state for a rejected credential load', async () => {
        credentialsApi.getCredentialsByName.mockRejectedValueOnce(new Error('RAW_CREDENTIAL_DETAIL_MUST_NOT_ESCAPE'))

        renderDropdown({ credentialNames: ['syntheticCredential'] })

        expect(await screen.findByRole('alert')).toHaveTextContent('加载选项失败，请稍后重试')
        expect(screen.getByTestId('no-options')).toHaveTextContent('加载选项失败，请稍后重试')
        expect(document.body).not.toHaveTextContent('RAW_CREDENTIAL_DETAIL_MUST_NOT_ESCAPE')
        expect(axios.post).not.toHaveBeenCalled()
    })

    it('keeps the create-new action available after a credential load failure', async () => {
        credentialsApi.getCredentialsByName.mockRejectedValueOnce(new Error('RAW_CREDENTIAL_DETAIL_MUST_NOT_ESCAPE'))

        renderDropdown({ credentialNames: ['syntheticCredential'], isCreateNewOption: true })

        expect(await screen.findByRole('alert')).toHaveTextContent('加载选项失败，请稍后重试')
        expect(screen.getByText('- 新建 -')).toBeInTheDocument()
        expect(screen.queryByTestId('no-options')).not.toBeInTheDocument()
        expect(document.body).not.toHaveTextContent('RAW_CREDENTIAL_DETAIL_MUST_NOT_ESCAPE')
    })

    it('distinguishes a successful empty response from a load failure', async () => {
        axios.post.mockResolvedValueOnce({ data: [] })

        renderDropdown()

        expect(await screen.findByRole('status')).toHaveTextContent('暂无可用选项')
        expect(screen.getByTestId('no-options')).toHaveTextContent('暂无可用选项')
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it.each(['{broken', '{}', { unexpected: true }])('fails closed for malformed multi-select value %p', async (value) => {
        axios.post.mockResolvedValueOnce({ data: [{ label: '模型一', name: 'model-one' }] })

        renderDropdown({ multiple: true, value })

        expect(await screen.findByText('模型一')).toBeInTheDocument()
        expect(screen.getByTestId('autocomplete')).toHaveAttribute('data-value-count', '0')
    })

    it('accepts only array-shaped persisted multi-select values', () => {
        expect(parseAsyncMultiValue('["model-one"]')).toEqual(['model-one'])
        expect(parseAsyncMultiValue(['model-two'])).toEqual(['model-two'])
        expect(parseAsyncMultiValue('"model-three"')).toEqual([])
    })

    it.each(['../chatflows', '/prediction/x', '..%2Finternal-prediction%2Fx', 'node.name', '', 'a'.repeat(129)])(
        'rejects unsafe persisted component name %p before any authenticated request',
        async (name) => {
            renderDropdown({ nodeData: { ...nodeData, name } })

            expect(await screen.findByRole('alert')).toHaveTextContent('加载选项失败，请稍后重试')
            expect(axios.post).not.toHaveBeenCalled()
        }
    )

    it('builds the node-load URL only for a registered-name-shaped path segment', () => {
        expect(buildNodeLoadMethodUrl('chatDeepseek_2')).toBe('http://localhost/api/v1/node-load-method/chatDeepseek_2')
        expect(() => buildNodeLoadMethodUrl('../assistants?x#')).toThrow('invalid component name')
    })
})
