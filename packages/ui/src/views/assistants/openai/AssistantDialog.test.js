/** @jest-environment ./test/canvasless-jsdom-environment.cjs */
/* eslint-disable react/prop-types, react/display-name */
import '@testing-library/jest-dom'
import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

global.React = React

const mockDispatch = jest.fn()
const mockHasPermission = jest.fn(() => true)
const mockAssistantVectorStoreDialog = jest.fn(({ show, onCancel }) =>
    show ? (
        <div role='dialog' aria-label='向量库选择已打开'>
            <button onClick={onCancel}>关闭向量库选择</button>
        </div>
    ) : null
)

jest.mock('react-redux', () => ({
    useDispatch: () => mockDispatch,
    useSelector: (selector) => selector({ customization: { borderRadius: 8 } })
}))
jest.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ hasPermission: mockHasPermission }) }))
jest.mock('@/utils/useNotifier', () => () => undefined)
jest.mock('@/store/constant', () => ({ maxScroll: 1000 }))
jest.mock('uuid', () => ({ v4: () => 'fixed-avatar' }))
jest.mock('@/api/assistants', () => ({
    __esModule: true,
    default: {
        createNewAssistant: jest.fn(),
        updateAssistant: jest.fn(),
        deleteAssistant: jest.fn(),
        getAssistantObj: jest.fn(),
        uploadFilesToAssistant: jest.fn(),
        uploadFilesToAssistantVectorStore: jest.fn(),
        deleteFilesFromAssistantVectorStore: jest.fn(),
        deleteAssistantVectorStore: jest.fn()
    }
}))
jest.mock('@/api/client', () => ({ __esModule: true, default: { get: jest.fn() } }))
jest.mock(
    './DeleteConfirmDialog',
    () =>
        ({ show, dialogProps, onCancel, onDelete, onDeleteBoth }) =>
            show ? (
                <div role='dialog' aria-label={dialogProps.title}>
                    <p>{dialogProps.description}</p>
                    <button onClick={onDelete}>仅删除 Flowise 记录</button>
                    <button onClick={onDeleteBoth}>永久删除 OpenAI 与 Flowise 记录</button>
                    <button onClick={onCancel}>取消删除</button>
                </div>
            ) : null
)
jest.mock('./AssistantVectorStoreDialog', () => (props) => mockAssistantVectorStoreDialog(props))
jest.mock('@/ui-component/tooltip/TooltipWithParser', () => ({ TooltipWithParser: () => null }))
jest.mock('@/ui-component/loading/BackdropLoader', () => ({ BackdropLoader: ({ open }) => (open ? <div>正在加载</div> : null) }))
jest.mock('@/views/canvas/CredentialInputHandler', () => ({ disabled }) => <input aria-label='OpenAI 凭据' disabled={disabled} />)
jest.mock('@/ui-component/button/RBACButtons', () => ({
    StyledPermissionButton: ({ permissionId, children, startIcon, sx: _sx, fullWidth: _fullWidth, color: _color, ...props }) =>
        mockHasPermission(permissionId) ? (
            <button {...props}>
                {startIcon}
                {children}
            </button>
        ) : null,
    PermissionIconButton: ({ permissionId, children, sx: _sx, ...props }) =>
        mockHasPermission(permissionId) ? <button {...props}>{children}</button> : null
}))
jest.mock('@/ui-component/dropdown/Dropdown', () => ({
    Dropdown: ({ options, value, onSelect, disabled }) => (
        <select aria-label='助手模型' disabled={disabled} value={value} onChange={(event) => onSelect(event.target.value)}>
            {options.map((option) => (
                <option key={option.name} value={option.name}>
                    {option.label}
                </option>
            ))}
        </select>
    )
}))
jest.mock('@/ui-component/dropdown/MultiDropdown', () => ({
    MultiDropdown: ({ disabled, name }) => (
        <button id={name} disabled={disabled}>
            已选助手工具
        </button>
    )
}))
jest.mock('@mui/material', () => ({
    Alert: ({ children }) => <div>{children}</div>,
    AlertTitle: ({ children }) => <div>{children}</div>,
    Button: ({ children, ...props }) => <button {...props}>{children}</button>,
    Chip: ({ label }) => <span>{label}</span>,
    Card: ({ children }) => <div>{children}</div>,
    CardContent: ({ children }) => <div>{children}</div>,
    Box: ({ children }) => <div>{children}</div>,
    Typography: ({ children, component: Component = 'span', htmlFor, id }) => (
        <Component htmlFor={htmlFor} id={id}>
            {children}
        </Component>
    ),
    Dialog: ({ children, onClose, 'aria-labelledby': labelledBy, 'aria-describedby': describedBy }) => (
        <div role='dialog' aria-labelledby={labelledBy} aria-describedby={describedBy}>
            <button aria-label='关闭助手对话框' onClick={onClose} />
            {children}
        </div>
    ),
    DialogActions: ({ children }) => <div>{children}</div>,
    DialogContent: jest.requireActual('react').forwardRef(({ children, id }, ref) => (
        <div ref={ref} id={id}>
            {children}
        </div>
    )),
    DialogTitle: ({ children, id }) => <div id={id}>{children}</div>,
    Link: ({ children, href }) => <a href={href}>{children}</a>,
    Stack: ({ children }) => <div>{children}</div>,
    OutlinedInput: ({ id, name, value, onChange, disabled, type, placeholder, inputProps }) => (
        <input
            aria-label={id ?? name}
            id={id}
            name={name}
            value={value}
            onChange={onChange}
            disabled={disabled}
            type={type}
            placeholder={placeholder}
            {...inputProps}
        />
    )
}))

import AssistantDialog from './AssistantDialog'

const mockAssistantsApi = jest.requireMock('@/api/assistants').default

const createDeferred = () => {
    let resolve
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise
    })
    return { promise, resolve }
}

const assistantDetails = (overrides = {}) => ({
    id: 'openai-assistant-1',
    name: '初始助手',
    description: '初始描述',
    model: 'gpt-4.1',
    instructions: '初始指令',
    temperature: 1,
    top_p: 1,
    tools: [],
    tool_resources: {},
    ...overrides
})

const storedAssistant = (details = assistantDetails()) => ({
    id: 'stored-assistant-1',
    iconSrc: 'https://example.com/icon.svg',
    credential: 'credential-1',
    type: 'OPENAI',
    details: JSON.stringify(details)
})

const props = () => ({
    show: true,
    dialogProps: {
        type: 'EDIT',
        title: '编辑助手',
        cancelButtonName: '取消',
        confirmButtonName: '保存',
        data: storedAssistant()
    },
    onCancel: jest.fn(),
    onConfirm: jest.fn(),
    setError: jest.fn()
})

describe('AssistantDialog mutation lifecycle', () => {
    let consoleErrorSpy

    beforeEach(() => {
        document.body.innerHTML = '<div id="portal"></div>'
        jest.clearAllMocks()
        mockHasPermission.mockReturnValue(true)
        consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    })

    afterEach(() => {
        expect(consoleErrorSpy).not.toHaveBeenCalled()
        consoleErrorSpy.mockRestore()
    })

    it('locks form editing and close while save is in flight, then accepts the exact response', async () => {
        const pending = createDeferred()
        mockAssistantsApi.updateAssistant.mockReturnValue(pending.promise)
        const dialogProps = props()
        render(<AssistantDialog {...dialogProps} />)
        const nameInput = await screen.findByLabelText('助手名称')
        await waitFor(() => expect(nameInput).toHaveValue('初始助手'))
        expect(screen.getByRole('dialog', { name: '编辑助手' })).not.toHaveAttribute('aria-describedby')

        fireEvent.click(screen.getByRole('button', { name: '保存' }))
        expect(mockAssistantsApi.updateAssistant).toHaveBeenCalledTimes(1)
        await waitFor(() => expect(nameInput).toBeDisabled())
        expect(screen.getByRole('button', { name: '取消' })).toBeDisabled()
        fireEvent.click(screen.getByLabelText('关闭助手对话框'))
        expect(dialogProps.onCancel).not.toHaveBeenCalled()

        pending.resolve({ data: storedAssistant() })
        await waitFor(() => expect(dialogProps.onConfirm).toHaveBeenCalledWith('stored-assistant-1'))
    })

    it('suppresses stale save callbacks and notifications after unmount', async () => {
        const pending = createDeferred()
        mockAssistantsApi.updateAssistant.mockReturnValue(pending.promise)
        const dialogProps = props()
        const { unmount } = render(<AssistantDialog {...dialogProps} />)
        await screen.findByLabelText('助手名称')
        fireEvent.click(screen.getByRole('button', { name: '保存' }))
        const requestConfig = mockAssistantsApi.updateAssistant.mock.calls[0][2]
        mockDispatch.mockClear()
        unmount()

        expect(requestConfig.signal.aborted).toBe(true)

        pending.resolve({ data: storedAssistant() })
        await Promise.resolve()
        await Promise.resolve()

        expect(dialogProps.onConfirm).not.toHaveBeenCalled()
        expect(dialogProps.setError).not.toHaveBeenCalled()
        expect(mockDispatch.mock.calls.some(([action]) => action?.notification?.options?.variant === 'success')).toBe(false)
    })

    it('keeps every direct ADD entry point disabled and shows the sunset notice', async () => {
        const dialogProps = props()
        dialogProps.dialogProps = {
            type: 'ADD',
            title: '添加新助手',
            confirmButtonName: '添加'
        }

        render(<AssistantDialog {...dialogProps} />)

        expect(await screen.findByText('OpenAI 助手 API 将于 2026 年 8 月 26 日停止服务')).toBeInTheDocument()
        expect(screen.getByText(/已停用新建旧版 OpenAI 助手及新增 OpenAI 端资源/)).toBeInTheDocument()
        expect(screen.getByText(/保存会同时更新 OpenAI 端助手和 Flowise 本地记录/)).toBeInTheDocument()
        expect(screen.getByLabelText('助手名称')).toBeDisabled()
        expect(screen.getByRole('button', { name: '添加' })).toBeDisabled()
        fireEvent.click(screen.getByRole('button', { name: '添加' }))
        expect(mockAssistantsApi.createNewAssistant).not.toHaveBeenCalled()
        expect(screen.queryByText('上传文件')).not.toBeInTheDocument()
        expect(mockAssistantsApi.uploadFilesToAssistant).not.toHaveBeenCalled()
        expect(mockAssistantsApi.uploadFilesToAssistantVectorStore).not.toHaveBeenCalled()
    })

    it('keeps an existing assistant read-only for a create-only user', async () => {
        mockHasPermission.mockImplementation((permission) => permission === 'assistants:create' || permission === 'assistants:view')
        const dialogProps = props()

        render(<AssistantDialog {...dialogProps} />)
        const nameInput = await screen.findByLabelText('助手名称')
        await waitFor(() => expect(nameInput).toHaveValue('初始助手'))

        expect(nameInput).toBeDisabled()
        expect(screen.getByLabelText('OpenAI 凭据')).toBeDisabled()
        expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: '取消' })).toBeEnabled()
        fireEvent.click(screen.getByRole('button', { name: '取消' }))
        expect(dialogProps.onCancel).toHaveBeenCalledTimes(1)
        expect(mockAssistantsApi.updateAssistant).not.toHaveBeenCalled()
        expect(mockAssistantsApi.uploadFilesToAssistantVectorStore).not.toHaveBeenCalled()
    })

    it('keeps form fields read-only but preserves delete for a delete-only maintainer', async () => {
        mockHasPermission.mockImplementation((permission) => permission === 'assistants:view' || permission === 'assistants:delete')

        render(<AssistantDialog {...props()} />)
        const nameInput = await screen.findByLabelText('助手名称')
        await waitFor(() => expect(nameInput).toHaveValue('初始助手'))

        expect(nameInput).toBeDisabled()
        expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: '删除' })).toBeEnabled()
    })

    it('keeps an unknown existing model visible and preserves its machine value when saving', async () => {
        const futureDetails = assistantDetails({ model: 'gpt-6-future' })
        const dialogProps = props()
        dialogProps.dialogProps.data = storedAssistant(futureDetails)
        mockAssistantsApi.updateAssistant.mockResolvedValueOnce({ data: storedAssistant(futureDetails) })

        render(<AssistantDialog {...dialogProps} />)

        const modelSelect = await screen.findByLabelText('助手模型')
        expect(modelSelect).toHaveValue('gpt-6-future')
        expect(screen.getByRole('option', { name: 'gpt-6-future（现有模型）' })).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: '保存' }))

        await waitFor(() => expect(mockAssistantsApi.updateAssistant).toHaveBeenCalledTimes(1))
        const requestBody = mockAssistantsApi.updateAssistant.mock.calls[0][1]
        expect(JSON.parse(requestBody.details).model).toBe('gpt-6-future')
    })

    it('keeps nullable sampling inputs controlled and saves them as null without console warnings', async () => {
        const nullableDetails = assistantDetails({ temperature: null, top_p: null })
        const dialogProps = props()
        dialogProps.dialogProps.data = storedAssistant(nullableDetails)
        mockAssistantsApi.updateAssistant.mockResolvedValueOnce({ data: storedAssistant(nullableDetails) })

        render(<AssistantDialog {...dialogProps} />)

        expect(await screen.findByLabelText('助手温度')).toHaveValue(null)
        expect(screen.getByLabelText('助手核采样概率')).toHaveValue(null)
        fireEvent.click(screen.getByRole('button', { name: '保存' }))

        await waitFor(() => expect(dialogProps.onConfirm).toHaveBeenCalledWith('stored-assistant-1'))
        const savedDetails = JSON.parse(mockAssistantsApi.updateAssistant.mock.calls[0][1].details)
        expect(savedDetails.temperature).toBeNull()
        expect(savedDetails.top_p).toBeNull()
    })

    it('allows clearing the optional name and accepts the exact unnamed response', async () => {
        const unnamedDetails = assistantDetails({ name: '' })
        mockAssistantsApi.updateAssistant.mockResolvedValueOnce({ data: storedAssistant(unnamedDetails) })
        const dialogProps = props()
        render(<AssistantDialog {...dialogProps} />)
        const nameInput = await screen.findByLabelText('助手名称')
        await waitFor(() => expect(nameInput).toHaveValue('初始助手'))

        fireEvent.change(nameInput, { target: { value: '' } })
        fireEvent.click(screen.getByRole('button', { name: '保存' }))

        await waitFor(() => expect(dialogProps.onConfirm).toHaveBeenCalledWith('stored-assistant-1'))
        expect(JSON.parse(mockAssistantsApi.updateAssistant.mock.calls[0][1].details).name).toBe('')
    })

    it('labels both file removal controls with their concrete file names', async () => {
        const detailsWithFiles = assistantDetails({
            tools: ['code_interpreter', 'file_search'],
            tool_resources: {
                code_interpreter: {
                    file_ids: ['code-file-1'],
                    files: [{ id: 'code-file-1', filename: '计算表.csv' }]
                },
                file_search: {
                    vector_store_ids: ['vs-1'],
                    vector_store_object: { id: 'vs-1', name: '知识库' },
                    files: [{ id: 'search-file-1', filename: '制度.pdf' }]
                }
            }
        })

        const dialogProps = props()
        dialogProps.dialogProps.data = storedAssistant(detailsWithFiles)
        render(<AssistantDialog {...dialogProps} />)

        expect(await screen.findByRole('button', { name: '移除代码解释器文件 计算表.csv' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: '永久移除向量库文件 制度.pdf' })).not.toBeInTheDocument()
        expect(screen.getByLabelText('助手工具')).toBeInTheDocument()
        expect(screen.queryByText('上传文件')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: '取消' }))
        expect(dialogProps.onCancel).toHaveBeenCalledTimes(1)
        expect(mockAssistantsApi.deleteFilesFromAssistantVectorStore).not.toHaveBeenCalled()
        expect(mockAssistantsApi.deleteAssistantVectorStore).not.toHaveBeenCalled()
    })

    it.each([
        ['Enter', '{enter}'],
        ['Space', ' ']
    ])('opens the existing-vector-store picker with %s on its native button', async (_label, key) => {
        const detailsWithoutVectorStore = assistantDetails({
            tools: ['file_search'],
            tool_resources: {
                file_search: { vector_store_ids: [], vector_store_object: null, files: [] }
            }
        })
        const dialogProps = props()
        dialogProps.dialogProps.data = storedAssistant(detailsWithoutVectorStore)
        render(<AssistantDialog {...dialogProps} />)

        const pickerButton = await screen.findByRole('button', { name: '选择既有向量库' })
        expect(pickerButton.tagName).toBe('BUTTON')
        pickerButton.focus()
        userEvent.type(pickerButton, key, { skipClick: true })

        expect(await screen.findByRole('dialog', { name: '向量库选择已打开' })).toBeInTheDocument()
        expect(mockAssistantsApi.uploadFilesToAssistantVectorStore).not.toHaveBeenCalled()
    })

    it.each([
        ['Enter', '{enter}'],
        ['Space', ' ']
    ])('unbinds a vector store locally with %s and explains that Save is required', async (_label, key) => {
        const detailsWithVectorStore = assistantDetails({
            tools: ['file_search'],
            tool_resources: {
                file_search: {
                    vector_store_ids: ['vs-1'],
                    vector_store_object: { id: 'vs-1', name: '知识库' },
                    files: [{ id: 'search-file-1', filename: '制度.pdf' }]
                }
            }
        })
        const dialogProps = props()
        dialogProps.dialogProps.data = storedAssistant(detailsWithVectorStore)
        render(<AssistantDialog {...dialogProps} />)

        const unbindButton = await screen.findByRole('button', { name: '解绑向量库' })
        const helpText = screen.getByText(/关联或解绑只修改当前表单，需保存主助手后生效/)
        expect(helpText).toHaveTextContent('保存会同时更新 OpenAI 端助手和 Flowise 本地记录')
        expect(unbindButton).toHaveAttribute('aria-describedby', helpText.id)
        unbindButton.focus()
        userEvent.type(unbindButton, key, { skipClick: true })

        await waitFor(() => expect(screen.queryByRole('button', { name: '解绑向量库' })).not.toBeInTheDocument())
        expect(screen.getByRole('button', { name: '选择既有向量库' })).toBeInTheDocument()
        expect(mockAssistantsApi.deleteFilesFromAssistantVectorStore).not.toHaveBeenCalled()
    })

    it('uses vector_store_ids as the association source when optional display metadata is absent', async () => {
        const detailsWithIdOnlyVectorStore = assistantDetails({
            tools: ['file_search'],
            tool_resources: {
                file_search: {
                    vector_store_ids: ['vs-id-only'],
                    vector_store_object: null,
                    files: []
                }
            }
        })
        const dialogProps = props()
        dialogProps.dialogProps.data = storedAssistant(detailsWithIdOnlyVectorStore)

        render(<AssistantDialog {...dialogProps} />)

        expect(await screen.findByText('vs-id-only')).toBeInTheDocument()
        expect(screen.getByRole('button', { name: '解绑向量库' })).toBeInTheDocument()
        expect(screen.queryByRole('button', { name: '选择既有向量库' })).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: '解绑向量库' }))
        expect(screen.getByRole('button', { name: '选择既有向量库' })).toBeInTheDocument()
    })

    it('keeps the parent canvas lock while the nested vector-store picker closes', async () => {
        const detailsWithoutVectorStore = assistantDetails({
            tools: ['file_search'],
            tool_resources: {
                file_search: { vector_store_ids: [], vector_store_object: null, files: [] }
            }
        })
        const dialogProps = props()
        dialogProps.dialogProps.data = storedAssistant(detailsWithoutVectorStore)
        const { rerender } = render(<AssistantDialog {...dialogProps} />)

        fireEvent.click(await screen.findByRole('button', { name: '选择既有向量库' }))
        expect(screen.getByRole('dialog', { name: '向量库选择已打开' })).toBeInTheDocument()
        mockDispatch.mockClear()

        fireEvent.click(screen.getByRole('button', { name: '关闭向量库选择' }))

        expect(screen.queryByRole('dialog', { name: '向量库选择已打开' })).not.toBeInTheDocument()
        expect(mockDispatch).not.toHaveBeenCalledWith({ type: '@canvas/HIDE_CANVAS_DIALOG' })

        rerender(<AssistantDialog {...dialogProps} show={false} />)
        expect(mockDispatch).toHaveBeenCalledWith({ type: '@canvas/HIDE_CANVAS_DIALOG' })
    })

    it('shows exact local and OpenAI IDs and irreversible deletion scopes', async () => {
        render(<AssistantDialog {...props()} />)
        await screen.findByLabelText('助手名称')

        fireEvent.click(screen.getByRole('button', { name: '删除' }))

        expect(screen.getByRole('dialog', { name: '删除旧版 OpenAI 助手' })).toHaveTextContent('Flowise 本地 ID：stored-assistant-1')
        expect(screen.getByRole('dialog', { name: '删除旧版 OpenAI 助手' })).toHaveTextContent('OpenAI 助手 ID：openai-assistant-1')
        expect(screen.getByRole('button', { name: '仅删除 Flowise 记录' })).toBeInTheDocument()
        expect(screen.getByRole('button', { name: '永久删除 OpenAI 与 Flowise 记录' })).toBeInTheDocument()
        expect(screen.getByText(/操作无法恢复/)).toBeInTheDocument()
    })
})
