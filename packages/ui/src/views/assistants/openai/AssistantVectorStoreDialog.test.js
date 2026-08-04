/** @jest-environment ./test/canvasless-jsdom-environment.cjs */
/* eslint-disable react/prop-types */
import '@testing-library/jest-dom'
import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

global.React = React

const mockDispatch = jest.fn()
const mockHasPermission = jest.fn(() => true)

jest.mock('react-redux', () => ({ useDispatch: () => mockDispatch }))
jest.mock('@/utils/useNotifier', () => () => undefined)
jest.mock('@/api/assistants', () => ({
    __esModule: true,
    default: {
        listAssistantVectorStore: jest.fn(),
        getAssistantVectorStore: jest.fn(),
        createAssistantVectorStore: jest.fn(),
        updateAssistantVectorStore: jest.fn(),
        deleteAssistantVectorStore: jest.fn()
    }
}))
jest.mock('@/utils/genericHelper', () => ({ formatBytes: (value) => `${value} B` }))
jest.mock('@/ui-component/loading/BackdropLoader', () => ({ BackdropLoader: ({ open }) => (open ? <div>正在加载</div> : null) }))
jest.mock('@/ui-component/button/RBACButtons', () => ({
    StyledPermissionButton: ({ permissionId, children, ...props }) =>
        mockHasPermission(permissionId) ? <button {...props}>{children}</button> : null
}))
jest.mock('@/ui-component/switch/Switch', () => ({
    SwitchInput: ({ value, onChange, disabled, label }) => (
        <button aria-label={label} disabled={disabled} onClick={() => onChange(!value)}>
            {label}
        </button>
    )
}))
jest.mock('@/ui-component/dropdown/Dropdown', () => ({
    Dropdown: ({ options, value, onSelect, disabled }) => (
        <select aria-label='选择向量库' disabled={disabled} value={value} onChange={(event) => onSelect(event.target.value)}>
            <option value=''>请选择</option>
            {options.map((option) => (
                <option key={option.name} value={option.name}>
                    {option.label}
                </option>
            ))}
        </select>
    )
}))
jest.mock('@mui/material', () => ({
    Button: ({ children, ...props }) => <button {...props}>{children}</button>,
    Dialog: ({ children, onClose, 'aria-labelledby': labelledBy, 'aria-describedby': describedBy }) => (
        <div role='dialog' aria-labelledby={labelledBy} aria-describedby={describedBy}>
            <button aria-label='关闭对话框' onClick={onClose} />
            {children}
        </div>
    ),
    DialogActions: ({ children }) => <div>{children}</div>,
    DialogContent: ({ children, id }) => <div id={id}>{children}</div>,
    DialogTitle: ({ children, id }) => <div id={id}>{children}</div>,
    Box: ({ children }) => <div>{children}</div>,
    Stack: ({ children }) => <div>{children}</div>,
    OutlinedInput: ({ id, value, onChange, disabled, type, placeholder, inputProps }) => (
        <input id={id} value={value} onChange={onChange} disabled={disabled} type={type} placeholder={placeholder} {...inputProps} />
    ),
    Typography: ({ children, component: Component = 'span', htmlFor }) => <Component htmlFor={htmlFor}>{children}</Component>
}))

import AssistantVectorStoreDialog from './AssistantVectorStoreDialog'

const mockAssistantApi = jest.requireMock('@/api/assistants').default

const createDeferred = () => {
    let resolve
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise
    })
    return { promise, resolve }
}

const vectorStore = (id, name = id, overrides = {}) => ({
    id,
    object: 'vector_store',
    name,
    status: 'completed',
    expires_after: null,
    file_counts: { in_progress: 0, completed: 0, failed: 0, cancelled: 0, total: 0 },
    usage_bytes: 0,
    ...overrides
})

const props = (overrides = {}) => ({
    show: true,
    dialogProps: {
        type: 'ADD',
        title: '选择既有向量库',
        cancelButtonName: '取消',
        confirmButtonName: '关联',
        credential: 'credential-a',
        assistantScope: { id: 'assistant-a', key: 'assistant-a', generation: 1 },
        vectorStoreGeneration: 1,
        assistantMutationPermissionId: 'assistants:update'
    },
    onCancel: jest.fn(),
    onConfirm: jest.fn(),
    ...overrides
})

describe('AssistantVectorStoreDialog attach-existing lifecycle', () => {
    let consoleErrorSpy

    beforeEach(() => {
        document.body.innerHTML = '<div id="portal"></div>'
        jest.clearAllMocks()
        mockHasPermission.mockReturnValue(true)
        mockAssistantApi.listAssistantVectorStore.mockResolvedValue({ data: [] })
        consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    })

    afterEach(() => {
        expect(consoleErrorSpy).not.toHaveBeenCalled()
        consoleErrorSpy.mockRestore()
    })

    it('ignores an older credential load after the scope changes', async () => {
        const older = createDeferred()
        const latest = createDeferred()
        mockAssistantApi.listAssistantVectorStore.mockImplementation((credential) =>
            credential === 'credential-a' ? older.promise : latest.promise
        )
        const initialProps = props()
        const { rerender } = render(<AssistantVectorStoreDialog {...initialProps} />)
        const nextProps = props({
            dialogProps: { ...initialProps.dialogProps, credential: 'credential-b', vectorStoreGeneration: 2 }
        })
        rerender(<AssistantVectorStoreDialog {...nextProps} />)

        latest.resolve({ data: [vectorStore('vs-b', '新版向量库')] })
        await waitFor(() => expect(screen.getByRole('option', { name: '新版向量库' })).toBeInTheDocument())
        older.resolve({ data: [vectorStore('vs-a', '旧版向量库')] })

        await waitFor(() => expect(screen.queryByRole('option', { name: '旧版向量库' })).not.toBeInTheDocument())
        expect(nextProps.onConfirm).not.toHaveBeenCalled()
    })

    it('aborts a pending read on explicit cancel and suppresses stale effects', async () => {
        const pending = createDeferred()
        mockAssistantApi.listAssistantVectorStore.mockReturnValue(pending.promise)
        const dialogProps = props()
        render(<AssistantVectorStoreDialog {...dialogProps} />)

        await waitFor(() => expect(mockAssistantApi.listAssistantVectorStore).toHaveBeenCalledTimes(1))
        const requestOptions = mockAssistantApi.listAssistantVectorStore.mock.calls[0][1]
        fireEvent.click(screen.getByRole('button', { name: '取消' }))

        expect(requestOptions.signal.aborted).toBe(true)
        expect(dialogProps.onCancel).toHaveBeenCalledTimes(1)
        pending.resolve({ data: [vectorStore('vs-stale')] })
        await waitFor(() => expect(screen.queryByRole('option', { name: 'vs-stale' })).not.toBeInTheDocument())
        expect(dialogProps.onConfirm).not.toHaveBeenCalled()
    })

    it('leaves global canvas locking exclusively to the parent assistant dialog', async () => {
        const dialogProps = props()
        const { unmount } = render(<AssistantVectorStoreDialog {...dialogProps} />)
        await waitFor(() => expect(mockAssistantApi.listAssistantVectorStore).toHaveBeenCalledTimes(1))

        fireEvent.click(screen.getByRole('button', { name: '取消' }))
        unmount()

        expect(mockDispatch).not.toHaveBeenCalledWith({ type: '@canvas/SHOW_CANVAS_DIALOG' })
        expect(mockDispatch).not.toHaveBeenCalledWith({ type: '@canvas/HIDE_CANVAS_DIALOG' })
    })

    it('attaches an existing vector store without issuing any OpenAI-side mutation', async () => {
        const existing = vectorStore('vs-existing', '现有向量库')
        mockAssistantApi.listAssistantVectorStore.mockResolvedValueOnce({ data: [existing] })
        const dialogProps = props()
        render(<AssistantVectorStoreDialog {...dialogProps} />)
        await waitFor(() => expect(screen.getByRole('option', { name: '现有向量库' })).toBeInTheDocument())

        fireEvent.change(screen.getByLabelText('选择向量库'), { target: { value: 'vs-existing' } })
        fireEvent.click(screen.getByRole('button', { name: '关联' }))

        expect(dialogProps.onConfirm).toHaveBeenCalledWith(existing)
        expect(mockAssistantApi.getAssistantVectorStore).not.toHaveBeenCalled()
        expect(mockAssistantApi.createAssistantVectorStore).not.toHaveBeenCalled()
        expect(mockAssistantApi.updateAssistantVectorStore).not.toHaveBeenCalled()
        expect(mockAssistantApi.deleteAssistantVectorStore).not.toHaveBeenCalled()
    })

    it('allows an update-only maintainer to attach an existing vector store', async () => {
        mockHasPermission.mockImplementation((permission) => permission === 'assistants:update')
        const existing = vectorStore('vs-existing', '现有向量库')
        mockAssistantApi.listAssistantVectorStore.mockResolvedValueOnce({ data: [existing] })
        const dialogProps = props()

        render(<AssistantVectorStoreDialog {...dialogProps} />)
        await waitFor(() => expect(screen.getByRole('option', { name: '现有向量库' })).toBeInTheDocument())
        fireEvent.change(screen.getByLabelText('选择向量库'), { target: { value: 'vs-existing' } })
        fireEvent.click(screen.getByRole('button', { name: '关联' }))

        expect(dialogProps.onConfirm).toHaveBeenCalledWith(existing)
        expect(mockAssistantApi.updateAssistantVectorStore).not.toHaveBeenCalled()
    })

    it('does not expose creation and requires an existing selection', async () => {
        render(<AssistantVectorStoreDialog {...props()} />)
        await waitFor(() => expect(screen.getByLabelText('选择向量库')).not.toBeDisabled())

        expect(screen.queryByRole('option', { name: '- 新建 -' })).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: '关联' })).toBeDisabled()
        expect(mockAssistantApi.createAssistantVectorStore).not.toHaveBeenCalled()
    })

    it('fails closed for a direct legacy edit context', async () => {
        const existing = vectorStore('vs-existing', '现有向量库')
        const dialogProps = props({
            dialogProps: {
                ...props().dialogProps,
                type: 'EDIT',
                title: '编辑向量库',
                confirmButtonName: '保存',
                data: existing
            }
        })

        render(<AssistantVectorStoreDialog {...dialogProps} />)
        await waitFor(() => expect(JSON.stringify(mockDispatch.mock.calls)).toContain('向量库上下文无效'))

        expect(screen.getByLabelText('选择向量库')).toBeDisabled()
        expect(screen.getByRole('button', { name: '保存' })).toBeDisabled()
        expect(mockAssistantApi.listAssistantVectorStore).not.toHaveBeenCalled()
        expect(mockAssistantApi.getAssistantVectorStore).not.toHaveBeenCalled()
        expect(mockAssistantApi.updateAssistantVectorStore).not.toHaveBeenCalled()
        expect(mockAssistantApi.deleteAssistantVectorStore).not.toHaveBeenCalled()
    })

    it('labels selected metadata without describing the whole form and cancel never mutates OpenAI resources', async () => {
        const existing = vectorStore('vs-existing', '现有向量库', {
            expires_after: { anchor: 'last_active_at', days: 7 }
        })
        mockAssistantApi.listAssistantVectorStore.mockResolvedValueOnce({ data: [existing] })
        const dialogProps = props()

        render(<AssistantVectorStoreDialog {...dialogProps} />)
        await waitFor(() => expect(screen.getByRole('option', { name: '现有向量库' })).toBeInTheDocument())
        fireEvent.change(screen.getByLabelText('选择向量库'), { target: { value: 'vs-existing' } })

        expect(screen.getByRole('dialog', { name: '选择既有向量库' })).not.toHaveAttribute('aria-describedby')
        expect(screen.getByLabelText('向量库名称')).toHaveValue('现有向量库')
        expect(screen.getByLabelText('向量库名称')).toBeDisabled()
        expect(screen.getByRole('button', { name: '启用向量库过期设置' })).toBeDisabled()
        expect(screen.getByLabelText('有效天数')).toHaveValue(7)
        expect(screen.getByLabelText('有效天数')).toBeDisabled()

        fireEvent.click(screen.getByRole('button', { name: '取消' }))
        expect(dialogProps.onCancel).toHaveBeenCalledTimes(1)
        expect(mockAssistantApi.createAssistantVectorStore).not.toHaveBeenCalled()
        expect(mockAssistantApi.updateAssistantVectorStore).not.toHaveBeenCalled()
        expect(mockAssistantApi.deleteAssistantVectorStore).not.toHaveBeenCalled()
    })
})
