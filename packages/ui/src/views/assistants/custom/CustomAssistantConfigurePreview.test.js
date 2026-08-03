/** @jest-environment ./test/canvasless-jsdom-environment.cjs */
/* eslint-disable react/prop-types */

import '@testing-library/jest-dom'
// Jest's current JSX transform requires React in this test module.
import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { cloneDeep } from 'lodash'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate, useParams } from 'react-router-dom'

import useApi from '@/hooks/useApi'
import useConfirm from '@/hooks/useConfirm'
import assistantsApi from '@/api/assistants'
import chatflowsApi from '@/api/chatflows'
import nodesApi from '@/api/nodes'
import documentstoreApi from '@/api/documentstore'
import { initNode, showHideInputParams } from '@/utils/genericHelper'
import CustomAssistantConfigurePreview from './CustomAssistantConfigurePreview'
import { CUSTOM_ASSISTANT_DEFAULT_INSTRUCTION } from './customAssistantDetails'
import { toolAgentFlow } from './toolAgentFlow'

global.React = React

jest.mock('lodash', () => {
    const actual = jest.requireActual('lodash')
    return { ...actual, cloneDeep: jest.fn(actual.cloneDeep) }
})

jest.mock('react-redux', () => ({
    useDispatch: jest.fn(),
    useSelector: jest.fn()
}))

jest.mock('react-router-dom', () => ({
    useNavigate: jest.fn(),
    useParams: jest.fn()
}))

jest.mock('flowise-embed-react', () => ({
    FullPageChat: ({ chatflowid, chatflow }) => (
        <div data-testid='full-page-chat' data-flow-id={chatflowid} data-chatflow-id={chatflow?.id ?? ''} />
    )
}))

jest.mock('@mui/material', () => {
    const React = jest.requireActual('react')
    const div = ({ children, sx: _sx, ...props }) => React.createElement('div', props, children)
    const layout = ({ children, sx: _sx, direction: _direction, flexDirection: _flexDirection, ...props }) =>
        React.createElement('div', props, children)
    const grid = ({ children, sx: _sx, item: _item, container: _container, xs: _xs, sm: _sm, md: _md, lg: _lg, spacing: _spacing }) =>
        React.createElement('div', null, children)
    const button = React.forwardRef(
        ({ children, sx: _sx, startIcon, fullWidth: _fullWidth, variant: _variant, size: _size, color: _color, ...props }, ref) =>
            React.createElement('button', { ...props, ref }, startIcon, children)
    )
    button.displayName = 'MockButton'

    return {
        IconButton: button,
        Avatar: div,
        ButtonBase: button,
        Toolbar: ({ children }) => React.createElement('div', null, children),
        Box: div,
        Button: button,
        Grid: grid,
        OutlinedInput: ({ sx: _sx, multiline: _multiline, ...props }) => React.createElement('textarea', props),
        Stack: layout,
        Typography: ({ children, sx: _sx, variant: _variant, color: _color, ...props }) => React.createElement('div', props, children)
    }
})

jest.mock('@mui/material/styles', () => ({
    useTheme: () => ({
        typography: { commonAvatar: {}, mediumAvatar: {} },
        palette: {
            canvasHeader: {
                deployLight: '#fff',
                deployDark: '#000',
                saveLight: '#fff',
                saveDark: '#000',
                settingsLight: '#fff',
                settingsDark: '#000'
            },
            error: { light: '#fff', dark: '#000' },
            grey: { 900: '#000' }
        }
    })
}))

jest.mock('@tabler/icons-react', () => {
    const Icon = () => null
    return {
        IconCode: Icon,
        IconArrowLeft: Icon,
        IconDeviceFloppy: Icon,
        IconSettings: Icon,
        IconX: Icon,
        IconTrash: Icon,
        IconWand: Icon,
        IconArrowsMaximize: Icon
    }
})

jest.mock('@/hooks/useApi', () => ({ __esModule: true, default: jest.fn() }))
jest.mock('@/hooks/useConfirm', () => ({ __esModule: true, default: jest.fn() }))
jest.mock('@/utils/useNotifier', () => ({ __esModule: true, default: jest.fn() }))

jest.mock('@/api/assistants', () => ({
    __esModule: true,
    default: {
        getSpecificAssistant: jest.fn(),
        getCustomAssistantFlow: jest.fn(),
        getChatModels: jest.fn(),
        getDocStores: jest.fn(),
        getTools: jest.fn(),
        updateAssistant: jest.fn(),
        saveCustomAssistant: jest.fn(),
        deleteCustomAssistant: jest.fn(),
        deleteAssistant: jest.fn()
    }
}))

jest.mock('@/api/chatflows', () => ({
    __esModule: true,
    default: {
        getSpecificChatflow: jest.fn(),
        createNewChatflow: jest.fn(),
        updateChatflow: jest.fn(),
        deleteChatflow: jest.fn()
    }
}))

jest.mock('@/api/nodes', () => ({
    __esModule: true,
    default: { getSpecificNode: jest.fn() }
}))

jest.mock('@/api/documentstore', () => ({
    __esModule: true,
    default: { generateDocStoreToolDesc: jest.fn() }
}))

jest.mock('@/utils/genericHelper', () => ({
    initNode: jest.fn(),
    showHideInputParams: jest.fn()
}))

jest.mock('@/utils/getErrorMessage', () => ({ getErrorMessage: () => '转换失败' }))

jest.mock('@/store/constant', () => ({ baseURL: 'https://flowise.example.invalid' }))
jest.mock('@/store/actions', () => ({
    SET_CHATFLOW: 'SET_CHATFLOW',
    closeSnackbar: (key) => ({ type: 'closeSnackbar', key }),
    enqueueSnackbar: (payload) => ({ type: 'enqueueSnackbar', payload })
}))

jest.mock('./toolAgentFlow', () => ({
    toolAgentFlow: { nodes: [], edges: [] }
}))

jest.mock('@/ui-component/cards/MainCard', () => ({ __esModule: true, default: ({ children }) => <div>{children}</div> }))
jest.mock('@/ui-component/loading/BackdropLoader', () => ({
    BackdropLoader: ({ open }) => (open ? <div role='status'>saving</div> : null)
}))
jest.mock('@/views/docstore/DocStoreInputHandler', () => ({ __esModule: true, default: () => null }))
jest.mock('@/ui-component/dropdown/Dropdown', () => ({
    Dropdown: ({ value }) => <div data-testid='dropdown-value'>{value}</div>
}))
jest.mock('@/ui-component/dropdown/MultiDropdown', () => ({ MultiDropdown: () => null }))
jest.mock('@/ui-component/button/StyledFab', () => ({ StyledFab: ({ children, ...props }) => <button {...props}>{children}</button> }))
jest.mock('@/ErrorBoundary', () => ({ __esModule: true, default: ({ error }) => <div role='alert'>{String(error)}</div> }))
jest.mock('@/ui-component/tooltip/TooltipWithParser', () => ({ TooltipWithParser: () => null }))
jest.mock('@/views/chatflows/APICodeDialog', () => ({
    __esModule: true,
    default: ({ show, dialogProps }) =>
        show ? (
            <div data-testid='api-dialog' data-flow-id={dialogProps.chatflowid} data-api-key-id={dialogProps.chatflowApiKeyId ?? ''} />
        ) : null
}))
jest.mock('@/ui-component/dialog/ViewMessagesDialog', () => ({ __esModule: true, default: () => null }))
jest.mock('@/ui-component/dialog/ChatflowConfigurationDialog', () => ({ __esModule: true, default: () => null }))
jest.mock('@/ui-component/dialog/ViewLeadsDialog', () => ({ __esModule: true, default: () => null }))
jest.mock('@/views/settings', () => ({
    __esModule: true,
    default: ({ chatflow }) => <div data-testid='assistant-settings' data-flow-id={chatflow?.id ?? ''} />
}))
jest.mock('@/ui-component/dialog/ConfirmDialog', () => ({ __esModule: true, default: () => null }))
jest.mock('@/ui-component/dialog/PromptGeneratorDialog', () => ({ __esModule: true, default: () => null }))
jest.mock('@/ui-component/dialog/ExpandTextDialog', () => ({ __esModule: true, default: () => null }))
jest.mock('@/ui-component/rbac/available', () => ({ Available: ({ children }) => <>{children}</> }))
jest.mock('@/ui-component/switch/Switch', () => ({ SwitchInput: () => null }))

const validChatModel = {
    name: 'chatModel',
    label: 'Chat model',
    credential: 'credential-1',
    inputParams: [],
    inputs: {}
}

const validTool = {
    id: 'failing-tool_0',
    name: 'failing-tool',
    label: 'Failing tool',
    credential: 'credential-2',
    inputParams: [],
    inputs: {}
}

const validDocumentStore = {
    id: 'store-1',
    name: 'Knowledge Base',
    description: 'Current retained description',
    returnSourceDocuments: false
}

const validDetails = (overrides = {}) =>
    JSON.stringify({
        name: 'Existing assistant',
        chatModel: validChatModel,
        instruction: 'Existing instruction',
        documentStores: [],
        tools: [],
        ...overrides
    })

const createApiState = (data) => ({ data, error: undefined, loading: false, request: jest.fn(), reset: jest.fn() })

let apiStates
let reduxState

const setToolAgentFlow = ({ invalidEdge = false } = {}) => {
    toolAgentFlow.nodes = [
        { id: 'old-model', data: { category: 'Chat Models', name: 'oldModel', inputs: {} } },
        { id: 'tool-agent', data: { category: 'Agents', name: 'toolAgent', inputs: {} } }
    ]
    toolAgentFlow.edges = [
        {
            source: invalidEdge ? undefined : 'old-model',
            sourceHandle: 'old-model-output',
            target: 'tool-agent',
            targetHandle: 'tool-agent-input',
            type: 'buttonedge',
            id: 'old-model-tool-agent'
        }
    ]
}

const setAssistantDetails = (details) => {
    apiStates.get(assistantsApi.getSpecificAssistant).data = {
        id: 'assistant-1',
        details,
        type: 'CUSTOM',
        updatedDate: '2026-08-02T08:00:00.000Z'
    }
}

const renderAssistant = async () => {
    const result = render(<CustomAssistantConfigurePreview />)
    await waitFor(() => expect(screen.getByRole('button', { name: '保存助手' })).toBeInTheDocument())
    return result
}

const expectConversionFailure = async () => {
    fireEvent.click(screen.getByRole('button', { name: '保存助手' }))

    await waitFor(() =>
        expect(useDispatch()).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'enqueueSnackbar',
                payload: expect.objectContaining({ message: '保存助手失败：转换失败' })
            })
        )
    )
    expect(chatflowsApi.createNewChatflow).not.toHaveBeenCalled()
    expect(chatflowsApi.updateChatflow).not.toHaveBeenCalled()
    expect(assistantsApi.updateAssistant).not.toHaveBeenCalled()
    expect(assistantsApi.saveCustomAssistant).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
}

describe('CustomAssistantConfigurePreview failure handling', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        setToolAgentFlow()

        const dispatch = jest.fn()
        useDispatch.mockReturnValue(dispatch)
        reduxState = { canvas: { chatflow: {} }, customization: { isDarkMode: false } }
        useSelector.mockImplementation((selector) => selector(reduxState))
        useNavigate.mockReturnValue(jest.fn())
        useParams.mockReturnValue({ id: 'assistant-1' })
        useConfirm.mockReturnValue({ confirm: jest.fn() })

        showHideInputParams.mockImplementation((node) => node?.inputParams ?? [])
        initNode.mockImplementation((node, id) => ({
            ...node,
            id,
            inputs: { ...(node.inputs ?? {}) },
            outputs: { ...(node.outputs ?? {}) }
        }))
        cloneDeep.mockImplementation(jest.requireActual('lodash').cloneDeep)

        apiStates = new Map([
            [
                assistantsApi.getSpecificAssistant,
                createApiState({
                    id: 'assistant-1',
                    details: validDetails(),
                    type: 'CUSTOM',
                    updatedDate: '2026-08-02T08:00:00.000Z'
                })
            ],
            [assistantsApi.getChatModels, createApiState([validChatModel])],
            [assistantsApi.getDocStores, createApiState([{ label: 'Knowledge Base', name: 'store-1', description: 'Store description' }])],
            [assistantsApi.getTools, createApiState([validTool])],
            [assistantsApi.getCustomAssistantFlow, createApiState(undefined)]
        ])
        useApi.mockImplementation((api) => apiStates.get(api))

        nodesApi.getSpecificNode.mockImplementation((name) => Promise.resolve({ data: { name, inputs: {}, outputs: {}, inputParams: [] } }))
        chatflowsApi.createNewChatflow.mockImplementation(() => new Promise(() => {}))
    })

    it('delegates snapshot-bound custom assistant deletion to one server operation and keeps conflicts on-page', () => {
        const source = require('fs').readFileSync(`${__dirname}/CustomAssistantConfigurePreview.jsx`, 'utf8')

        expect(source).toContain('assistantsApi.deleteCustomAssistant(targetAssistantId, deleteSnapshot')
        expect(source).toContain('expectedAssistant: assistantSnapshot')
        expect(source).toContain('expectedChatflow: chatflowSnapshot')
        expect(source).toContain('error?.response?.status === 409')
        expect(source).toContain('助手或关联流程已发生变化，请重新加载后重试。')
        expect(source).not.toContain('chatflowsApi.deleteChatflow')
    })

    it('aborts the whole save when a tool cannot be converted', async () => {
        setAssistantDetails(validDetails({ tools: [validTool] }))
        cloneDeep.mockImplementation((value) => {
            if (value?.name === validTool.name) throw new Error('tool conversion failed')
            return jest.requireActual('lodash').cloneDeep(value)
        })

        await renderAssistant()
        await expectConversionFailure()
    })

    it('aborts the whole save when a document store cannot be converted', async () => {
        setAssistantDetails(validDetails({ documentStores: [validDocumentStore] }))
        initNode.mockImplementation(() => {
            throw new Error('document store conversion failed')
        })

        await renderAssistant()
        await expectConversionFailure()
    })

    it('clears the loading state when prepareConfig returns undefined', async () => {
        setToolAgentFlow({ invalidEdge: true })

        await renderAssistant()
        fireEvent.click(screen.getByRole('button', { name: '保存助手' }))

        await waitFor(() => expect(useDispatch()).toHaveBeenCalledWith(expect.objectContaining({ type: 'enqueueSnackbar' })))
        expect(screen.queryByRole('status')).not.toBeInTheDocument()
        expect(chatflowsApi.createNewChatflow).not.toHaveBeenCalled()
        expect(assistantsApi.saveCustomAssistant).not.toHaveBeenCalled()
    })

    it('preserves loaded data, shows an explicit error, and disables save when details JSON becomes invalid', async () => {
        setAssistantDetails(validDetails({ documentStores: [validDocumentStore], tools: [validTool] }))
        const { rerender } = await renderAssistant()

        expect(screen.getByText('Knowledge Base')).toBeInTheDocument()
        expect(screen.getByDisplayValue('Current retained description')).toBeInTheDocument()
        expect(screen.getAllByTestId('dropdown-value').some((element) => element.textContent === validTool.name)).toBe(true)

        setAssistantDetails('{not-valid-json')
        rerender(<CustomAssistantConfigurePreview />)

        expect(await screen.findByRole('alert')).toHaveTextContent('助手详情格式无效，已保留当前数据。请重新加载后再保存。')
        expect(screen.getByText('Knowledge Base')).toBeInTheDocument()
        expect(screen.getByDisplayValue('Current retained description')).toBeInTheDocument()
        expect(screen.getAllByTestId('dropdown-value').some((element) => element.textContent === validTool.name)).toBe(true)
        expect(screen.getByTitle('保存')).toBeDisabled()
        expect(screen.getByRole('button', { name: '保存助手' })).toBeDisabled()

        fireEvent.click(screen.getByRole('button', { name: '保存助手' }))
        expect(chatflowsApi.createNewChatflow).not.toHaveBeenCalled()
        expect(documentstoreApi.generateDocStoreToolDesc).not.toHaveBeenCalled()
    })

    it('preserves the current form instead of rendering malformed nested input metadata', async () => {
        setAssistantDetails(validDetails({ documentStores: [validDocumentStore], tools: [validTool] }))
        const { rerender } = await renderAssistant()

        setAssistantDetails(
            validDetails({
                chatModel: { ...validChatModel, inputParams: [null] },
                documentStores: [],
                tools: []
            })
        )
        rerender(<CustomAssistantConfigurePreview />)

        expect(await screen.findByRole('alert')).toHaveTextContent('助手详情格式无效')
        expect(screen.getByText('Knowledge Base')).toBeInTheDocument()
        expect(screen.getByDisplayValue('Current retained description')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: '保存助手' })).toBeDisabled()
    })

    it('clears optional state when a valid minimal assistant replaces the current details', async () => {
        setAssistantDetails(validDetails({ documentStores: [validDocumentStore], tools: [validTool] }))
        const { rerender } = await renderAssistant()

        expect(screen.getByText('Knowledge Base')).toBeInTheDocument()
        expect(screen.getByDisplayValue('Existing instruction')).toBeInTheDocument()

        setAssistantDetails(JSON.stringify({ name: 'Fresh assistant' }))
        rerender(<CustomAssistantConfigurePreview />)

        await waitFor(() => expect(screen.getByText('Fresh assistant')).toBeInTheDocument())
        expect(screen.queryByDisplayValue('Current retained description')).not.toBeInTheDocument()
        expect(screen.queryByText('Knowledge Base')).not.toBeInTheDocument()
        expect(screen.getByDisplayValue(CUSTOM_ASSISTANT_DEFAULT_INSTRUCTION)).toBeInTheDocument()
        expect(screen.getByTestId('dropdown-value')).toHaveTextContent('')
    })

    it('saves the backing flow and assistant in one aggregate request with exact snapshots', async () => {
        const savedDetails = validDetails({ flowId: 'flow-1' })
        assistantsApi.saveCustomAssistant.mockImplementation((_assistantId, body) =>
            Promise.resolve({
                data: {
                    assistant: {
                        id: 'assistant-1',
                        details: savedDetails,
                        type: 'CUSTOM',
                        updatedDate: '2026-08-02T08:01:00.000Z'
                    },
                    chatflow: {
                        id: 'flow-1',
                        name: 'Existing assistant',
                        flowData: body.flowData,
                        type: 'ASSISTANT',
                        updatedDate: '2026-08-02T08:01:00.000Z'
                    }
                }
            })
        )

        await renderAssistant()
        fireEvent.click(screen.getByRole('button', { name: '保存助手' }))

        await waitFor(() => expect(assistantsApi.saveCustomAssistant).toHaveBeenCalledTimes(1))
        expect(assistantsApi.saveCustomAssistant).toHaveBeenCalledWith(
            'assistant-1',
            expect.objectContaining({
                expectedAssistant: {
                    details: validDetails(),
                    type: 'CUSTOM',
                    updatedDate: '2026-08-02T08:00:00.000Z'
                },
                expectedChatflow: null,
                details: expect.any(String),
                flowData: expect.any(String)
            }),
            expect.objectContaining({ signal: expect.any(AbortSignal) })
        )
        expect(chatflowsApi.createNewChatflow).not.toHaveBeenCalled()
        expect(chatflowsApi.updateChatflow).not.toHaveBeenCalled()
        expect(assistantsApi.updateAssistant).not.toHaveBeenCalled()
        await waitFor(() =>
            expect(useDispatch()).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'SET_CHATFLOW', chatflow: expect.objectContaining({ id: 'flow-1' }) })
            )
        )
        expect(useDispatch()).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'enqueueSnackbar',
                payload: expect.objectContaining({ message: '助手保存成功。' })
            })
        )
    })

    it('loads an existing backing flow through the assistant-scoped endpoint and sends its exact snapshot', async () => {
        const existingFlow = {
            id: 'flow-1',
            name: 'Existing assistant',
            flowData: JSON.stringify({ nodes: [], edges: [] }),
            type: 'ASSISTANT',
            updatedDate: '2026-08-02T08:00:30.000Z'
        }
        setAssistantDetails(validDetails({ flowId: 'flow-1' }))
        apiStates.get(assistantsApi.getCustomAssistantFlow).data = existingFlow
        assistantsApi.saveCustomAssistant.mockImplementation((_assistantId, body) =>
            Promise.resolve({
                data: {
                    assistant: {
                        id: 'assistant-1',
                        details: validDetails({ flowId: 'flow-1' }),
                        type: 'CUSTOM',
                        updatedDate: '2026-08-02T08:01:00.000Z'
                    },
                    chatflow: { ...existingFlow, flowData: body.flowData, updatedDate: '2026-08-02T08:01:00.000Z' }
                }
            })
        )

        await renderAssistant()
        expect(apiStates.get(assistantsApi.getCustomAssistantFlow).request).toHaveBeenCalledWith(
            'assistant-1',
            expect.objectContaining({ signal: expect.any(AbortSignal) })
        )

        fireEvent.click(screen.getByRole('button', { name: '保存助手' }))
        await waitFor(() => expect(assistantsApi.saveCustomAssistant).toHaveBeenCalledTimes(1))

        expect(assistantsApi.saveCustomAssistant).toHaveBeenCalledWith(
            'assistant-1',
            expect.objectContaining({
                expectedChatflow: existingFlow
            }),
            expect.objectContaining({ signal: expect.any(AbortSignal) })
        )
    })

    it.each([
        ['wrong id', { id: 'flow-other', type: 'ASSISTANT' }],
        ['wrong type', { id: 'flow-1', type: 'CHATFLOW' }]
    ])('rejects a custom-flow response with %s before dispatch or exposing backing-flow actions', async (_label, identity) => {
        setAssistantDetails(validDetails({ flowId: 'flow-1' }))
        apiStates.get(assistantsApi.getCustomAssistantFlow).data = {
            ...identity,
            name: 'Untrusted flow',
            flowData: JSON.stringify({ nodes: [], edges: [] }),
            updatedDate: '2026-08-02T08:00:30.000Z'
        }

        render(<CustomAssistantConfigurePreview />)

        expect(await screen.findByRole('alert')).toHaveTextContent('关联流程响应与当前助手不匹配，请重新加载后重试。')
        expect(screen.queryByTitle('API 端点')).not.toBeInTheDocument()
        expect(screen.queryByTitle('设置')).not.toBeInTheDocument()
        expect(screen.queryByTestId('full-page-chat')).not.toBeInTheDocument()
        expect(useDispatch()).not.toHaveBeenCalledWith(
            expect.objectContaining({ type: 'SET_CHATFLOW', chatflow: expect.objectContaining({ id: identity.id }) })
        )
    })

    it('keeps backing-flow actions isolated while the expected flow snapshot is absent', async () => {
        setAssistantDetails(validDetails({ flowId: 'flow-1' }))
        apiStates.get(assistantsApi.getCustomAssistantFlow).data = undefined

        await renderAssistant()

        expect(screen.getByTitle('保存')).toBeDisabled()
        expect(screen.getByRole('button', { name: '保存助手' })).toBeDisabled()
        expect(screen.queryByTitle('API 端点')).not.toBeInTheDocument()
        expect(screen.queryByTitle('设置')).not.toBeInTheDocument()
        expect(screen.queryByTestId('full-page-chat')).not.toBeInTheDocument()
    })

    it.each([
        ['null canvas', null],
        ['stale canvas', { id: 'stale-flow', type: 'CHATFLOW', apikeyid: 'stale-key' }]
    ])('uses the validated backing response without crashing for %s Redux state', async (_label, canvasChatflow) => {
        reduxState.canvas.chatflow = canvasChatflow
        const existingFlow = {
            id: 'flow-1',
            name: 'Existing assistant',
            flowData: JSON.stringify({ nodes: [], edges: [] }),
            type: 'ASSISTANT',
            apikeyid: 'flow-api-key',
            updatedDate: '2026-08-02T08:00:30.000Z'
        }
        setAssistantDetails(validDetails({ flowId: 'flow-1' }))
        apiStates.get(assistantsApi.getCustomAssistantFlow).data = existingFlow

        await renderAssistant()

        const preview = await screen.findByTestId('full-page-chat')
        expect(preview).toHaveAttribute('data-flow-id', 'flow-1')
        expect(preview).toHaveAttribute('data-chatflow-id', 'flow-1')
        expect(useDispatch()).toHaveBeenCalledWith({ type: 'SET_CHATFLOW', chatflow: null })
        expect(useDispatch()).toHaveBeenCalledWith({ type: 'SET_CHATFLOW', chatflow: existingFlow })

        fireEvent.click(screen.getByTitle('API 端点'))
        expect(screen.getByTestId('api-dialog')).toHaveAttribute('data-flow-id', 'flow-1')
        expect(screen.getByTestId('api-dialog')).toHaveAttribute('data-api-key-id', 'flow-api-key')

        fireEvent.click(screen.getByTitle('设置'))
        expect(screen.getByTestId('assistant-settings')).toHaveAttribute('data-flow-id', 'flow-1')
    })

    it('preserves the draft and blocks repeat saves after a version conflict', async () => {
        assistantsApi.saveCustomAssistant.mockRejectedValue({ response: { status: 409 } })

        await renderAssistant()
        fireEvent.click(screen.getByRole('button', { name: '保存助手' }))

        expect(await screen.findByRole('alert')).toHaveTextContent(
            '助手或关联流程已在其他会话中更新。当前未保存内容已保留，请重新加载后再保存。'
        )
        expect(screen.getByRole('button', { name: '保存助手' })).toBeDisabled()
        expect(screen.queryByRole('status')).not.toBeInTheDocument()
        expect(assistantsApi.saveCustomAssistant).toHaveBeenCalledTimes(1)
        expect(useDispatch()).not.toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'enqueueSnackbar',
                payload: expect.objectContaining({ message: '助手保存成功。' })
            })
        )
    })

    it('rejects an inconsistent aggregate response without publishing it as saved state', async () => {
        assistantsApi.saveCustomAssistant.mockResolvedValue({
            data: {
                assistant: {
                    id: 'assistant-1',
                    details: validDetails({ flowId: 'flow-1' }),
                    type: 'CUSTOM',
                    updatedDate: '2026-08-02T08:01:00.000Z'
                },
                chatflow: {
                    id: 'flow-1',
                    name: 'Existing assistant',
                    flowData: JSON.stringify({ nodes: [], edges: [] }),
                    type: 'ASSISTANT',
                    updatedDate: '2026-08-02T08:01:00.000Z'
                }
            }
        })

        await renderAssistant()
        fireEvent.click(screen.getByRole('button', { name: '保存助手' }))

        await waitFor(() =>
            expect(useDispatch()).toHaveBeenCalledWith(
                expect.objectContaining({
                    type: 'enqueueSnackbar',
                    payload: expect.objectContaining({ message: '保存助手失败：转换失败' })
                })
            )
        )
        expect(useDispatch()).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'SET_CHATFLOW', chatflow: expect.anything() }))
        expect(useDispatch()).not.toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'enqueueSnackbar',
                payload: expect.objectContaining({ message: '助手保存成功。' })
            })
        )
        expect(screen.queryByRole('status')).not.toBeInTheDocument()
    })

    it('rebuilds tool references from the current order instead of a stale persisted id', async () => {
        setAssistantDetails(validDetails({ tools: [{ ...validTool, id: 'stale-tool-id' }] }))
        assistantsApi.saveCustomAssistant.mockImplementation((_assistantId, body) =>
            Promise.resolve({
                data: {
                    assistant: {
                        id: 'assistant-1',
                        details: validDetails({ flowId: 'flow-1', tools: [{ ...validTool, id: 'stale-tool-id' }] }),
                        type: 'CUSTOM',
                        updatedDate: '2026-08-02T08:01:00.000Z'
                    },
                    chatflow: {
                        id: 'flow-1',
                        name: 'Existing assistant',
                        flowData: body.flowData,
                        type: 'ASSISTANT',
                        updatedDate: '2026-08-02T08:01:00.000Z'
                    }
                }
            })
        )

        await renderAssistant()
        fireEvent.click(screen.getByRole('button', { name: '保存助手' }))
        await waitFor(() => expect(assistantsApi.saveCustomAssistant).toHaveBeenCalledTimes(1))

        const request = assistantsApi.saveCustomAssistant.mock.calls[0][1]
        const flowData = JSON.parse(request.flowData)
        expect(flowData.nodes.some((node) => node.id === 'failing-tool_0')).toBe(true)
        expect(flowData.nodes.some((node) => node.id === 'stale-tool-id')).toBe(false)
        expect(flowData.nodes.find((node) => node.data.name === 'toolAgent').data.inputs.tools).toContain('{{failing-tool_0}}')
    })

    it('coalesces same-tick save attempts into one aggregate request', async () => {
        let resolveSave
        assistantsApi.saveCustomAssistant.mockReturnValue(
            new Promise((resolve) => {
                resolveSave = resolve
            })
        )

        await renderAssistant()
        const saveButton = screen.getByRole('button', { name: '保存助手' })
        fireEvent.click(saveButton)
        fireEvent.click(saveButton)

        await waitFor(() => expect(assistantsApi.saveCustomAssistant).toHaveBeenCalledTimes(1))
        const requestedFlowData = assistantsApi.saveCustomAssistant.mock.calls[0][1].flowData
        resolveSave({
            data: {
                assistant: {
                    id: 'assistant-1',
                    details: validDetails({ flowId: 'flow-1' }),
                    type: 'CUSTOM',
                    updatedDate: '2026-08-02T08:01:00.000Z'
                },
                chatflow: {
                    id: 'flow-1',
                    name: 'Existing assistant',
                    flowData: requestedFlowData,
                    type: 'ASSISTANT',
                    updatedDate: '2026-08-02T08:01:00.000Z'
                }
            }
        })
        await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    })
})
