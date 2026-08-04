import { createPortal } from 'react-dom'
import PropTypes from 'prop-types'
import { useState, useEffect, useId, useRef } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { enqueueSnackbar as enqueueSnackbarAction, closeSnackbar as closeSnackbarAction } from '@/store/actions'
import { v4 as uuidv4 } from 'uuid'

import {
    Chip,
    Alert,
    AlertTitle,
    Card,
    CardContent,
    Box,
    Typography,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Link,
    Stack,
    OutlinedInput
} from '@mui/material'

import { TooltipWithParser } from '@/ui-component/tooltip/TooltipWithParser'
import { Dropdown } from '@/ui-component/dropdown/Dropdown'
import { MultiDropdown } from '@/ui-component/dropdown/MultiDropdown'
import CredentialInputHandler from '@/views/canvas/CredentialInputHandler'
import { BackdropLoader } from '@/ui-component/loading/BackdropLoader'
import DeleteConfirmDialog from './DeleteConfirmDialog'
import AssistantVectorStoreDialog from './AssistantVectorStoreDialog'
import {
    createAssistantScopeKey,
    hasProviderBoundAssistantState,
    INVALID_ASSISTANT_MUTATION_RESPONSE_MESSAGE,
    INVALID_ASSISTANT_RESOURCE_MESSAGE,
    isAssistantOperationCurrent,
    MAX_ASSISTANT_DESCRIPTION_LENGTH,
    MAX_ASSISTANT_INSTRUCTIONS_LENGTH,
    MAX_ASSISTANT_NAME_LENGTH,
    parseAssistantDetails,
    parseAssistantSamplingParams,
    parseAssistantToolResources,
    parseStoredAssistantResource,
    removeCodeInterpreterFile,
    validateAssistantDeletionResponse,
    validateAssistantMutationResponse,
    validateAssistantTextFields
} from './assistantResourceState'
import { PermissionIconButton, StyledPermissionButton } from '@/ui-component/button/RBACButtons'

// Icons
import { IconX, IconPlus } from '@tabler/icons-react'

// API
import assistantsApi from '@/api/assistants'
import client from '@/api/client'

// utils
import useNotifier from '@/utils/useNotifier'
import { useAuth } from '@/hooks/useAuth'
import { getErrorMessage } from '@/utils/getErrorMessage'
import { HIDE_CANVAS_DIALOG, SHOW_CANVAS_DIALOG } from '@/store/actions'
import { maxScroll } from '@/store/constant'

const assistantAvailableModels = [
    {
        label: 'gpt-4.1',
        name: 'gpt-4.1'
    },
    {
        label: 'gpt-4.1-mini',
        name: 'gpt-4.1-mini'
    },
    {
        label: 'gpt-4.1-nano',
        name: 'gpt-4.1-nano'
    },
    {
        label: 'gpt-4.5-preview',
        name: 'gpt-4.5-preview'
    },
    {
        label: 'gpt-4o-mini',
        name: 'gpt-4o-mini'
    },
    {
        label: 'gpt-4o',
        name: 'gpt-4o'
    },
    {
        label: 'gpt-4-turbo',
        name: 'gpt-4-turbo'
    },
    {
        label: 'gpt-4-turbo-preview',
        name: 'gpt-4-turbo-preview'
    },
    {
        label: 'gpt-4-1106-preview',
        name: 'gpt-4-1106-preview'
    },
    {
        label: 'gpt-4-0613',
        name: 'gpt-4-0613'
    },
    {
        label: 'gpt-4',
        name: 'gpt-4'
    },
    {
        label: 'gpt-3.5-turbo',
        name: 'gpt-3.5-turbo'
    },
    {
        label: 'gpt-3.5-turbo-0125',
        name: 'gpt-3.5-turbo-0125'
    },
    {
        label: 'gpt-3.5-turbo-1106',
        name: 'gpt-3.5-turbo-1106'
    },
    {
        label: 'gpt-3.5-turbo-0613',
        name: 'gpt-3.5-turbo-0613'
    },
    {
        label: 'gpt-3.5-turbo-16k',
        name: 'gpt-3.5-turbo-16k'
    },
    {
        label: 'gpt-3.5-turbo-16k-0613',
        name: 'gpt-3.5-turbo-16k-0613'
    }
]

const AssistantDialog = ({ show, dialogProps, onCancel, onConfirm }) => {
    const portalElement = document.getElementById('portal')
    useNotifier()
    const dispatch = useDispatch()
    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))
    const customization = useSelector((state) => state.customization)
    const { hasPermission } = useAuth()
    const dialogId = `openai-assistant-${useId()}`
    const titleId = `${dialogId}-title`
    const contentId = `${dialogId}-content`
    const dialogRef = useRef()
    const assistantScopeRef = useRef(null)
    const assistantScopeGenerationRef = useRef(0)
    const currentRequestedScopeKeyRef = useRef('')
    const currentShowRef = useRef(show)
    const operationGenerationRef = useRef(0)
    const operationInFlightRef = useRef(false)
    const operationAbortControllerRef = useRef(null)
    const vectorStoreGenerationRef = useRef(0)
    const assistantVectorStoreDialogOpenRef = useRef(false)
    const loadAbortControllerRef = useRef(null)

    // Sanitize image URL to prevent XSS attacks via javascript:, data:, or blob: schemes
    const sanitizeImageUrl = (url) => {
        const fallbackUrl = `https://api.dicebear.com/7.x/bottts/svg?seed=fallback`
        if (!url || typeof url !== 'string') {
            return fallbackUrl
        }
        try {
            const parsed = new URL(url, window.location.origin)
            // Only allow http and https protocols
            if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
                return url
            }
        } catch (e) {
            // Invalid URL
        }
        // Return default avatar if URL is invalid or uses disallowed protocol
        return fallbackUrl
    }

    const [assistantName, setAssistantName] = useState('')
    const [assistantDesc, setAssistantDesc] = useState('')
    const [assistantIcon, setAssistantIcon] = useState(`https://api.dicebear.com/7.x/bottts/svg?seed=${uuidv4()}`)
    const [assistantModel, setAssistantModel] = useState('')
    const [assistantCredential, setAssistantCredential] = useState('')
    const [assistantInstructions, setAssistantInstructions] = useState('')
    const [assistantTools, setAssistantTools] = useState(['code_interpreter', 'file_search'])
    const [toolResources, setToolResources] = useState({})
    const [temperature, setTemperature] = useState(1)
    const [topP, setTopP] = useState(1)
    const [loading, setLoading] = useState(false)
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
    const [deleteDialogProps, setDeleteDialogProps] = useState({})
    const [assistantVectorStoreDialogOpen, setAssistantVectorStoreDialogOpen] = useState(false)
    const [assistantVectorStoreDialogProps, setAssistantVectorStoreDialogProps] = useState({})
    const [assistantResourceValid, setAssistantResourceValid] = useState(false)
    const assistantIdRef = useRef('')
    const openAIAssistantIdRef = useRef('')
    const assistantCredentialRef = useRef('')
    const toolResourcesRef = useRef({})
    const requestedAssistantScopeId =
        dialogProps.data?.id ||
        dialogProps.assistantId ||
        dialogProps.selectedOpenAIAssistantId ||
        (dialogProps.type === 'ADD' ? 'new' : '')
    const requestedAssistantScopeKey = createAssistantScopeKey([
        show,
        dialogProps.type,
        requestedAssistantScopeId,
        dialogProps.data?.details ?? '',
        dialogProps.data?.credential ?? dialogProps.credential ?? '',
        typeof dialogProps.data?.iconSrc,
        dialogProps.data?.iconSrc ?? ''
    ])
    currentRequestedScopeKeyRef.current = requestedAssistantScopeKey
    currentShowRef.current = show
    const isCommittedResource = assistantScopeRef.current?.key === requestedAssistantScopeKey
    const isValidResource = assistantResourceValid && isCommittedResource
    const openAIAssistantCreationDisabled = dialogProps.type === 'ADD'
    const mutationPermissionId = dialogProps.type === 'ADD' ? 'assistants:create' : 'assistants:update'
    const hasMutationPermission = hasPermission(mutationPermissionId)
    const resourceBusyOrInvalid = !isValidResource || loading
    const resourceControlsDisabled = resourceBusyOrInvalid || openAIAssistantCreationDisabled || !hasMutationPermission
    const canMutateResource = isValidResource && !loading && !openAIAssistantCreationDisabled && hasMutationPermission
    const samplingParams = parseAssistantSamplingParams({ temperature, topP })
    const textFieldsValid = validateAssistantTextFields({
        name: assistantName,
        description: assistantDesc,
        instructions: assistantInstructions
    })
    const credentialLocked = hasProviderBoundAssistantState({
        openAIAssistantId: openAIAssistantIdRef.current,
        toolResources: toolResourcesRef.current
    })
    const assistantModelOptions =
        assistantModel && !assistantAvailableModels.some((model) => model.name === assistantModel)
            ? [...assistantAvailableModels, { label: `${assistantModel}（现有模型）`, name: assistantModel }]
            : assistantAvailableModels
    const associatedVectorStoreId = toolResources?.file_search?.vector_store_ids?.[0] ?? ''
    const associatedVectorStoreObject = toolResources?.file_search?.vector_store_object
    const associatedVectorStoreLabel =
        associatedVectorStoreId && associatedVectorStoreObject?.id === associatedVectorStoreId
            ? associatedVectorStoreObject.name || associatedVectorStoreObject.id
            : associatedVectorStoreId

    const isAssistantScopeCurrent = (candidateScope) => assistantScopeRef.current === candidateScope
    const isVectorStoreGenerationCurrent = (generation) => vectorStoreGenerationRef.current === generation

    const commitAssistantId = (value) => {
        assistantIdRef.current = value
    }

    const commitOpenAIAssistantId = (value) => {
        openAIAssistantIdRef.current = value
    }

    const commitAssistantCredential = (value) => {
        assistantCredentialRef.current = value
        operationAbortControllerRef.current?.abort()
        operationAbortControllerRef.current = null
        operationGenerationRef.current += 1
        operationInFlightRef.current = false
        setLoading(false)
        setAssistantCredential(value)
    }

    const handleAssistantCredentialSelect = (value) => {
        if (value === assistantCredentialRef.current) return
        if (
            hasProviderBoundAssistantState({
                openAIAssistantId: openAIAssistantIdRef.current,
                toolResources: toolResourcesRef.current
            })
        ) {
            enqueueSnackbar({
                message: '当前助手已关联 OpenAI 端资源，只能在原凭据下维护。请迁移到自定义助手或 OpenAI 响应 API。',
                options: { variant: 'error' }
            })
            return
        }
        commitAssistantCredential(value)
    }

    const commitToolResources = (value) => {
        toolResourcesRef.current = value
        setToolResources(value)
    }

    const beginOperation = () => {
        if (operationInFlightRef.current) return null
        operationAbortControllerRef.current?.abort()
        const abortController = new AbortController()
        operationAbortControllerRef.current = abortController
        operationInFlightRef.current = true
        return {
            scope: assistantScopeRef.current,
            scopeKey: currentRequestedScopeKeyRef.current,
            generation: ++operationGenerationRef.current,
            assistantId: assistantIdRef.current,
            openAIAssistantId: openAIAssistantIdRef.current,
            credential: assistantCredentialRef.current,
            show: currentShowRef.current,
            abortController
        }
    }

    const isOperationCurrent = (operation) =>
        !operation.abortController.signal.aborted &&
        isAssistantOperationCurrent(operation, {
            scope: assistantScopeRef.current,
            scopeKey: currentRequestedScopeKeyRef.current,
            generation: operationGenerationRef.current,
            assistantId: assistantIdRef.current,
            openAIAssistantId: openAIAssistantIdRef.current,
            credential: assistantCredentialRef.current,
            show: currentShowRef.current
        })

    const invalidateOperations = () => {
        operationAbortControllerRef.current?.abort()
        operationAbortControllerRef.current = null
        operationGenerationRef.current += 1
        operationInFlightRef.current = false
        setLoading(false)
    }

    const finishOperation = (operation) => {
        if (!isOperationCurrent(operation)) return
        operationAbortControllerRef.current = null
        operationInFlightRef.current = false
        setLoading(false)
    }

    const beginVectorStoreGeneration = () => ++vectorStoreGenerationRef.current

    const closeAssistantVectorStoreDialog = () => {
        beginVectorStoreGeneration()
        assistantVectorStoreDialogOpenRef.current = false
        setAssistantVectorStoreDialogOpen(false)
    }

    const isAssistantVectorStoreDialogCurrent = (dialogState) =>
        currentShowRef.current &&
        assistantVectorStoreDialogOpenRef.current &&
        isAssistantScopeCurrent(dialogState.assistantScope) &&
        isVectorStoreGenerationCurrent(dialogState.vectorStoreGeneration)

    const handleDialogClose = () => {
        if (loading || operationInFlightRef.current) return
        invalidateOperations()
        closeAssistantVectorStoreDialog()
        onCancel()
    }

    const notifyInvalidAssistantResource = () => {
        enqueueSnackbar({
            message: INVALID_ASSISTANT_RESOURCE_MESSAGE,
            options: {
                key: new Date().getTime() + Math.random(),
                variant: 'error',
                persist: true,
                action: (key) => (
                    <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                        <IconX />
                    </Button>
                )
            }
        })
    }

    const notifyInvalidMutationResponse = () => {
        enqueueSnackbar({
            message: INVALID_ASSISTANT_MUTATION_RESPONSE_MESSAGE,
            options: {
                key: new Date().getTime() + Math.random(),
                variant: 'error',
                persist: true,
                action: (key) => (
                    <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                        <IconX />
                    </Button>
                )
            }
        })
    }

    const syncData = (data) => {
        commitOpenAIAssistantId(data.id)
        setAssistantName(data.name)
        setAssistantDesc(data.description)
        setAssistantModel(data.model)
        setAssistantInstructions(data.instructions)
        setTemperature(data.temperature)
        setTopP(data.top_p)
        commitToolResources(data.tool_resources)
        setAssistantTools(data.tools)
    }

    const resetAssistantResourceState = () => {
        commitAssistantId('')
        commitOpenAIAssistantId('')
        commitAssistantCredential('')
        commitToolResources({})
        setAssistantName('')
        setAssistantDesc('')
        setAssistantIcon(`https://api.dicebear.com/7.x/bottts/svg?seed=${uuidv4()}`)
        setAssistantModel('')
        setAssistantInstructions('')
        setAssistantTools(['code_interpreter', 'file_search'])
        setTemperature(1)
        setTopP(1)
    }

    useEffect(() => {
        if (show) dispatch({ type: SHOW_CANVAS_DIALOG })
        else dispatch({ type: HIDE_CANVAS_DIALOG })
        return () => dispatch({ type: HIDE_CANVAS_DIALOG })
    }, [show, dispatch])

    useEffect(
        () => () => {
            currentShowRef.current = false
            loadAbortControllerRef.current?.abort()
            operationAbortControllerRef.current?.abort()
            operationAbortControllerRef.current = null
            operationGenerationRef.current += 1
            operationInFlightRef.current = false
            vectorStoreGenerationRef.current += 1
            assistantVectorStoreDialogOpenRef.current = false
        },
        []
    )

    useEffect(() => {
        loadAbortControllerRef.current?.abort()
        const abortController = new AbortController()
        loadAbortControllerRef.current = abortController
        const committedScope = {
            id: requestedAssistantScopeId,
            key: requestedAssistantScopeKey,
            generation: assistantScopeGenerationRef.current + 1
        }
        assistantScopeGenerationRef.current = committedScope.generation
        assistantScopeRef.current = committedScope
        invalidateOperations()
        setAssistantResourceValid(false)
        setDeleteDialogOpen(false)
        closeAssistantVectorStoreDialog()
        setLoading(false)
        resetAssistantResourceState()

        const isLoadCurrent = () =>
            !abortController.signal.aborted &&
            isAssistantScopeCurrent(committedScope) &&
            currentRequestedScopeKeyRef.current === committedScope.key &&
            currentShowRef.current

        const notifyLoadError = (error) => {
            if (!isLoadCurrent()) return
            enqueueSnackbar({
                message: `获取助手失败：${getErrorMessage(error, '未知错误')}`,
                options: {
                    key: new Date().getTime() + Math.random(),
                    variant: 'error',
                    persist: true,
                    action: (key) => (
                        <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                            <IconX />
                        </Button>
                    )
                }
            })
        }

        const loadStoredAssistant = async (assistantToLoad) => {
            setLoading(true)
            try {
                const response = await client.get(`/assistants/${encodeURIComponent(assistantToLoad)}`, {
                    signal: abortController.signal
                })
                if (!isLoadCurrent()) return
                const parsedResource = parseStoredAssistantResource(response.data)
                if (!parsedResource.success || parsedResource.data.id !== assistantToLoad) {
                    notifyInvalidAssistantResource()
                    return
                }
                commitAssistantId(parsedResource.data.id)
                setAssistantIcon(parsedResource.data.iconSrc)
                commitAssistantCredential(parsedResource.data.credential)
                syncData(parsedResource.data.details)
                setAssistantResourceValid(true)
            } catch (error) {
                notifyLoadError(error)
            } finally {
                if (isLoadCurrent()) setLoading(false)
            }
        }

        const loadExistingOpenAIAssistant = async (selectedAssistantId, credential) => {
            commitAssistantCredential(credential)
            setLoading(true)
            try {
                const response = await client.get(`/openai-assistants/${encodeURIComponent(selectedAssistantId)}`, {
                    params: { credential },
                    signal: abortController.signal
                })
                if (!isLoadCurrent() || assistantCredentialRef.current !== credential) return
                const parsedDetails = parseAssistantDetails(response.data)
                if (!parsedDetails.success || parsedDetails.data.id !== selectedAssistantId) {
                    notifyInvalidAssistantResource()
                    return
                }
                syncData(parsedDetails.data)
                setAssistantResourceValid(true)
            } catch (error) {
                notifyLoadError(error)
            } finally {
                if (isLoadCurrent() && assistantCredentialRef.current === credential) setLoading(false)
            }
        }

        if (!show) return () => abortController.abort()

        if (dialogProps.type === 'EDIT' && dialogProps.data) {
            // When assistant dialog is opened from Assistants dashboard
            const parsedResource = parseStoredAssistantResource(dialogProps.data)
            if (!parsedResource.success) {
                notifyInvalidAssistantResource()
                return () => abortController.abort()
            }

            commitAssistantId(parsedResource.data.id)
            setAssistantIcon(parsedResource.data.iconSrc)
            commitAssistantCredential(parsedResource.data.credential)
            syncData(parsedResource.data.details)
            setAssistantResourceValid(true)
        } else if (dialogProps.type === 'EDIT' && dialogProps.assistantId) {
            // When assistant dialog is opened from OpenAIAssistant node in canvas
            void loadStoredAssistant(dialogProps.assistantId)
        } else if (dialogProps.type === 'ADD' && dialogProps.selectedOpenAIAssistantId && dialogProps.credential) {
            // When assistant dialog is to add new assistant from existing
            void loadExistingOpenAIAssistant(dialogProps.selectedOpenAIAssistantId, dialogProps.credential)
        } else if (dialogProps.type === 'ADD' && !dialogProps.selectedOpenAIAssistantId) {
            // When assistant dialog is to add a blank new assistant
            setAssistantResourceValid(true)
        }

        return () => abortController.abort()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [requestedAssistantScopeKey])

    const onAddAssistantVectorStoreClick = () => {
        if (!canMutateResource) return
        const vectorStoreGeneration = beginVectorStoreGeneration()
        const dialogProp = {
            title: '选择既有向量库',
            type: 'ADD',
            cancelButtonName: '取消',
            confirmButtonName: '关联',
            credential: assistantCredential,
            assistantScope: assistantScopeRef.current,
            assistantMutationPermissionId: mutationPermissionId,
            vectorStoreGeneration
        }
        setAssistantVectorStoreDialogProps(dialogProp)
        assistantVectorStoreDialogOpenRef.current = true
        setAssistantVectorStoreDialogOpen(true)
    }

    const addNewAssistant = async () => {
        if (!canMutateResource) return
        if (!textFieldsValid) {
            enqueueSnackbar({ message: '助手名称、描述或指令超过允许长度，请缩短后重试。', options: { variant: 'error' } })
            return
        }
        if (!samplingParams.success) {
            enqueueSnackbar({ message: '温度必须在 0–2 之间，核采样概率必须在 0–1 之间。', options: { variant: 'error' } })
            return
        }
        const operation = beginOperation()
        if (!operation) return
        setLoading(true)
        try {
            const assistantDetails = {
                id: operation.openAIAssistantId,
                name: assistantName,
                description: assistantDesc,
                model: assistantModel,
                instructions: assistantInstructions,
                temperature: samplingParams.data.temperature,
                top_p: samplingParams.data.topP,
                tools: assistantTools,
                tool_resources: toolResourcesRef.current
            }
            const obj = {
                details: JSON.stringify(assistantDetails),
                iconSrc: assistantIcon,
                credential: operation.credential,
                type: 'OPENAI'
            }

            const createResp = await assistantsApi.createNewAssistant(obj, { signal: operation.abortController.signal })
            if (!isOperationCurrent(operation)) return
            const validatedResponse = validateAssistantMutationResponse(createResp?.data, {
                expectedCredential: operation.credential,
                expectedIcon: assistantIcon,
                expectedDetails: assistantDetails
            })
            if (!validatedResponse.success) {
                notifyInvalidMutationResponse()
                return
            }

            enqueueSnackbar({
                message: '新助手已添加',
                options: {
                    key: new Date().getTime() + Math.random(),
                    variant: 'success',
                    action: (key) => (
                        <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                            <IconX />
                        </Button>
                    )
                }
            })
            onConfirm(validatedResponse.data.id)
        } catch (error) {
            if (!isOperationCurrent(operation)) return
            enqueueSnackbar({
                message: `添加新助手失败：${getErrorMessage(error, '未知错误')}`,
                options: {
                    key: new Date().getTime() + Math.random(),
                    variant: 'error',
                    persist: true,
                    action: (key) => (
                        <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                            <IconX />
                        </Button>
                    )
                }
            })
        } finally {
            finishOperation(operation)
        }
    }

    const saveAssistant = async () => {
        if (!canMutateResource) return
        if (!textFieldsValid) {
            enqueueSnackbar({ message: '助手名称、描述或指令超过允许长度，请缩短后重试。', options: { variant: 'error' } })
            return
        }
        if (!samplingParams.success) {
            enqueueSnackbar({ message: '温度必须在 0–2 之间，核采样概率必须在 0–1 之间。', options: { variant: 'error' } })
            return
        }
        const operation = beginOperation()
        if (!operation) return
        setLoading(true)
        try {
            const assistantDetails = {
                id: operation.openAIAssistantId,
                name: assistantName,
                description: assistantDesc,
                model: assistantModel,
                instructions: assistantInstructions,
                temperature: samplingParams.data.temperature,
                top_p: samplingParams.data.topP,
                tools: assistantTools,
                tool_resources: toolResourcesRef.current
            }
            const obj = {
                details: JSON.stringify(assistantDetails),
                iconSrc: assistantIcon,
                credential: operation.credential
            }
            const saveResp = await assistantsApi.updateAssistant(operation.assistantId, obj, {
                signal: operation.abortController.signal
            })
            if (!isOperationCurrent(operation)) return
            const validatedResponse = validateAssistantMutationResponse(saveResp?.data, {
                expectedAssistantId: operation.assistantId,
                expectedCredential: operation.credential,
                expectedIcon: assistantIcon,
                expectedDetails: assistantDetails
            })
            if (!validatedResponse.success) {
                notifyInvalidMutationResponse()
                return
            }

            enqueueSnackbar({
                message: '助手已保存',
                options: {
                    key: new Date().getTime() + Math.random(),
                    variant: 'success',
                    action: (key) => (
                        <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                            <IconX />
                        </Button>
                    )
                }
            })
            onConfirm(validatedResponse.data.id)
        } catch (error) {
            if (!isOperationCurrent(operation)) return
            enqueueSnackbar({
                message: `保存助手失败：${getErrorMessage(error, '未知错误')}`,
                options: {
                    key: new Date().getTime() + Math.random(),
                    variant: 'error',
                    persist: true,
                    action: (key) => (
                        <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                            <IconX />
                        </Button>
                    )
                }
            })
        } finally {
            finishOperation(operation)
        }
    }

    const onSyncClick = async () => {
        if (!canMutateResource) return
        const operation = beginOperation()
        if (!operation) return
        setLoading(true)
        try {
            const getResp = await assistantsApi.getAssistantObj(operation.openAIAssistantId, operation.credential, {
                signal: operation.abortController.signal
            })
            if (!isOperationCurrent(operation)) return
            const parsedDetails = parseAssistantDetails(getResp?.data)
            if (!parsedDetails.success || parsedDetails.data.id !== operation.openAIAssistantId) {
                notifyInvalidMutationResponse()
                return
            }

            syncData(parsedDetails.data)
            enqueueSnackbar({
                message: '助手同步成功！',
                options: {
                    key: new Date().getTime() + Math.random(),
                    variant: 'success',
                    action: (key) => (
                        <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                            <IconX />
                        </Button>
                    )
                }
            })
        } catch (error) {
            if (!isOperationCurrent(operation)) return
            enqueueSnackbar({
                message: `同步助手失败：${getErrorMessage(error, '未知错误')}`,
                options: {
                    key: new Date().getTime() + Math.random(),
                    variant: 'error',
                    persist: true,
                    action: (key) => (
                        <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                            <IconX />
                        </Button>
                    )
                }
            })
        } finally {
            finishOperation(operation)
        }
    }

    const detachVectorStore = () => {
        if (!canMutateResource) return
        invalidateOperations()
        beginVectorStoreGeneration()
        commitToolResources({
            ...toolResourcesRef.current,
            file_search: {
                files: [],
                vector_store_object: null,
                vector_store_ids: []
            }
        })
    }

    const onDeleteClick = () => {
        if (resourceBusyOrInvalid || !hasPermission('assistants:delete')) return
        const localAssistantId = assistantIdRef.current || '无本地 ID'
        const providerAssistantId = openAIAssistantIdRef.current || '无 OpenAI ID'
        setDeleteDialogProps({
            title: '删除旧版 OpenAI 助手',
            description: `助手“${
                assistantName || '未命名助手'
            }”；Flowise 本地 ID：${localAssistantId}；OpenAI 助手 ID：${providerAssistantId}。选择“仅删除 Flowise 记录”只会移除本地记录，OpenAI 端资源仍会保留；选择“永久删除 OpenAI 与 Flowise 记录”会先永久删除 OpenAI 端助手，再删除本地记录，操作无法恢复。`,
            cancelButtonName: '取消'
        })
        setDeleteDialogOpen(true)
    }

    const deleteAssistant = async (isDeleteBoth) => {
        if (!isValidResource || !hasPermission('assistants:delete')) return
        const operation = beginOperation()
        if (!operation) return
        setDeleteDialogOpen(false)
        setLoading(true)
        try {
            const delResp = await assistantsApi.deleteAssistant(operation.assistantId, isDeleteBoth, {
                signal: operation.abortController.signal
            })
            if (!isOperationCurrent(operation)) return
            if (!validateAssistantDeletionResponse(delResp?.data, operation.assistantId)) {
                notifyInvalidMutationResponse()
                return
            }

            enqueueSnackbar({
                message: '助手已删除',
                options: {
                    key: new Date().getTime() + Math.random(),
                    variant: 'success',
                    action: (key) => (
                        <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                            <IconX />
                        </Button>
                    )
                }
            })
            onConfirm()
        } catch (error) {
            if (!isOperationCurrent(operation)) return
            enqueueSnackbar({
                message: `删除助手失败：${getErrorMessage(error, '未知错误')}`,
                options: {
                    key: new Date().getTime() + Math.random(),
                    variant: 'error',
                    persist: true,
                    action: (key) => (
                        <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                            <IconX />
                        </Button>
                    )
                }
            })
        } finally {
            finishOperation(operation)
        }
    }

    const onFileDeleteClick = (fileId, toolType) => {
        if (!isValidResource) return
        if (toolType === 'code_interpreter') {
            if (!hasPermission(mutationPermissionId)) return
            invalidateOperations()
            const stateUpdate = removeCodeInterpreterFile({ fileId, currentToolResources: toolResourcesRef.current })
            if (!stateUpdate.success) {
                notifyInvalidMutationResponse()
                return
            }
            commitToolResources(stateUpdate.data)
        }
    }

    const component = show ? (
        <Dialog fullWidth maxWidth='md' open={show} onClose={handleDialogClose} aria-labelledby={titleId}>
            <DialogTitle sx={{ fontSize: '1rem', p: 3, pb: 0 }} id={titleId}>
                {dialogProps.title}
            </DialogTitle>
            <DialogContent
                id={contentId}
                ref={dialogRef}
                sx={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: '75vh', position: 'relative', px: 3, pb: 3 }}
            >
                <Alert severity='warning' variant='outlined'>
                    <AlertTitle>OpenAI 助手 API 将于 2026 年 8 月 26 日停止服务</AlertTitle>
                    已停用新建旧版 OpenAI 助手及新增 OpenAI 端资源；现有助手可查看、编辑、同步、解绑、删除与迁移。保存会同时更新 OpenAI
                    端助手和 Flowise 本地记录，但不会新建 OpenAI 端资源。助手本身可通过明确范围确认进行清理。请迁移到自定义助手或 OpenAI
                    响应 API。{' '}
                    <Link href='https://developers.openai.com/api/docs/assistants/migration' target='_blank' rel='noopener noreferrer'>
                        查看 OpenAI 官方迁移指南
                    </Link>
                </Alert>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, pt: 2 }}>
                    <Box>
                        <Stack sx={{ position: 'relative' }} direction='row'>
                            <Typography variant='overline'>
                                OpenAI 凭据
                                <span style={{ color: 'red' }}>&nbsp;*</span>
                            </Typography>
                        </Stack>
                        <CredentialInputHandler
                            key={assistantCredential}
                            disabled={resourceControlsDisabled || credentialLocked}
                            data={assistantCredential ? { credential: assistantCredential } : {}}
                            inputParam={{
                                label: '连接凭据',
                                name: 'credential',
                                type: 'credential',
                                credentialNames: ['openAIApi']
                            }}
                            onSelect={handleAssistantCredentialSelect}
                        />
                        {credentialLocked && (
                            <Typography variant='caption' color='text.secondary'>
                                已关联 OpenAI 端助手或文件资源，只能在原凭据下维护；请迁移到自定义助手或 OpenAI 响应 API。
                            </Typography>
                        )}
                    </Box>
                    <Box>
                        <Stack sx={{ position: 'relative' }} direction='row'>
                            <Typography component='label' htmlFor='assistantModel' variant='overline'>
                                助手模型
                                <span style={{ color: 'red' }}>&nbsp;*</span>
                            </Typography>
                        </Stack>
                        <Dropdown
                            key={assistantModel}
                            disabled={resourceControlsDisabled}
                            name='assistantModel'
                            options={assistantModelOptions}
                            onSelect={(newValue) => setAssistantModel(newValue)}
                            value={assistantModel ?? '请选择一个选项'}
                        />
                    </Box>
                    <Box>
                        <Stack sx={{ position: 'relative', alignItems: 'center' }} direction='row'>
                            <Typography component='label' htmlFor='assistantName' variant='overline'>
                                助手名称
                            </Typography>
                            <TooltipWithParser title={'助手的名称。最长 256 个字符。'} />
                        </Stack>
                        <OutlinedInput
                            id='assistantName'
                            disabled={resourceControlsDisabled}
                            type='string'
                            size='small'
                            fullWidth
                            placeholder='我的新助手'
                            value={assistantName}
                            name='assistantName'
                            inputProps={{ 'aria-label': '助手名称', maxLength: MAX_ASSISTANT_NAME_LENGTH }}
                            onChange={(e) => setAssistantName(e.target.value)}
                        />
                    </Box>
                    <Box>
                        <Stack sx={{ position: 'relative', alignItems: 'center' }} direction='row'>
                            <Typography component='label' htmlFor='assistantDesc' variant='overline'>
                                助手描述
                            </Typography>
                            <TooltipWithParser title={'助手的描述。最长 512 个字符。'} />
                        </Stack>
                        <OutlinedInput
                            id='assistantDesc'
                            disabled={resourceControlsDisabled}
                            type='string'
                            size='small'
                            fullWidth
                            placeholder='助手的功能描述'
                            multiline={true}
                            rows={3}
                            value={assistantDesc}
                            name='assistantDesc'
                            inputProps={{ 'aria-label': '助手描述', maxLength: MAX_ASSISTANT_DESCRIPTION_LENGTH }}
                            onChange={(e) => setAssistantDesc(e.target.value)}
                        />
                    </Box>
                    <Box>
                        <Stack sx={{ position: 'relative' }} direction='row'>
                            <Typography component='label' htmlFor='assistantIcon' variant='overline'>
                                助手图标地址
                            </Typography>
                        </Stack>
                        <div
                            style={{
                                width: 100,
                                height: 100,
                                borderRadius: '50%',
                                backgroundColor: 'white'
                            }}
                        >
                            <img
                                style={{
                                    width: '100%',
                                    height: '100%',
                                    padding: 5,
                                    borderRadius: '50%',
                                    objectFit: 'contain'
                                }}
                                alt={assistantName}
                                src={sanitizeImageUrl(assistantIcon)}
                            />
                        </div>
                        <OutlinedInput
                            id='assistantIcon'
                            disabled={resourceControlsDisabled}
                            type='string'
                            size='small'
                            fullWidth
                            placeholder={`https://api.dicebear.com/7.x/bottts/svg?seed=${uuidv4()}`}
                            value={assistantIcon}
                            name='assistantIcon'
                            inputProps={{ 'aria-label': '助手图标地址' }}
                            onChange={(e) => setAssistantIcon(e.target.value)}
                        />
                    </Box>
                    <Box>
                        <Stack sx={{ position: 'relative', alignItems: 'center' }} direction='row'>
                            <Typography component='label' htmlFor='assistantInstructions' variant='overline'>
                                助手指令
                            </Typography>
                            <TooltipWithParser title={'助手使用的系统指令。最长 256000 个字符。'} />
                        </Stack>
                        <OutlinedInput
                            id='assistantInstructions'
                            disabled={resourceControlsDisabled}
                            type='string'
                            size='small'
                            fullWidth
                            placeholder='你是一位个人数学家教。当被问到问题时，编写并运行代码来回答。'
                            multiline={true}
                            rows={3}
                            inputProps={{ 'aria-label': '助手指令', maxLength: MAX_ASSISTANT_INSTRUCTIONS_LENGTH }}
                            value={assistantInstructions}
                            name='assistantInstructions'
                            onChange={(e) => setAssistantInstructions(e.target.value)}
                        />
                    </Box>
                    <Box>
                        <Stack sx={{ position: 'relative', alignItems: 'center' }} direction='row'>
                            <Typography component='label' htmlFor='assistantTemp' variant='overline'>
                                助手温度
                            </Typography>
                            <TooltipWithParser title={'控制随机性：降低温度会使输出更稳定。当温度趋近于零时，模型将变得确定性且重复。'} />
                        </Stack>
                        <OutlinedInput
                            id='assistantTemp'
                            disabled={resourceControlsDisabled}
                            type='number'
                            size='small'
                            fullWidth
                            value={temperature ?? ''}
                            name='assistantTemp'
                            error={!samplingParams.success}
                            inputProps={{ 'aria-label': '助手温度', min: 0, max: 2, step: 0.01 }}
                            onChange={(e) => setTemperature(e.target.value)}
                        />
                    </Box>
                    <Box>
                        <Stack sx={{ position: 'relative', alignItems: 'center' }} direction='row'>
                            <Typography component='label' htmlFor='assistantTopP' variant='overline'>
                                助手核采样概率
                            </Typography>
                            <TooltipWithParser title={'通过核采样控制多样性：0.5 表示考虑所有按可能性加权选项的一半。'} />
                        </Stack>
                        <OutlinedInput
                            id='assistantTopP'
                            disabled={resourceControlsDisabled}
                            type='number'
                            fullWidth
                            size='small'
                            value={topP ?? ''}
                            name='assistantTopP'
                            error={!samplingParams.success}
                            inputProps={{ 'aria-label': '助手核采样概率', min: 0, max: 1, step: 0.01 }}
                            onChange={(e) => setTopP(e.target.value)}
                        />
                    </Box>
                    {assistantCredential && (
                        <>
                            <Box>
                                <Stack sx={{ position: 'relative', alignItems: 'center' }} direction='row'>
                                    <Typography component='label' htmlFor='assistantTools' variant='overline'>
                                        助手工具
                                    </Typography>
                                    <TooltipWithParser title='在助手上启用的工具列表。每个助手最多可启用 128 个工具。' />
                                </Stack>
                                <MultiDropdown
                                    key={JSON.stringify(assistantTools)}
                                    disabled={resourceControlsDisabled}
                                    name='assistantTools'
                                    options={[
                                        {
                                            label: '代码解释器',
                                            name: 'code_interpreter'
                                        },
                                        {
                                            label: '文件搜索',
                                            name: 'file_search'
                                        }
                                    ]}
                                    onSelect={(newValue) => {
                                        newValue ? setAssistantTools(JSON.parse(newValue)) : setAssistantTools([])
                                        setTimeout(() => {
                                            dialogRef?.current?.scrollTo({ top: maxScroll })
                                        }, 100)
                                    }}
                                    value={assistantTools ?? '请选择一个选项'}
                                />
                            </Box>
                            <Box>
                                {assistantTools?.length > 0 && assistantTools.includes('code_interpreter') && (
                                    <Card sx={{ mb: 2, border: '1px solid #e0e0e0', borderRadius: `${customization.borderRadius}px` }}>
                                        <CardContent>
                                            <Stack sx={{ position: 'relative', alignItems: 'center' }} direction='row'>
                                                <Typography variant='overline'>代码解释器文件</Typography>
                                                <TooltipWithParser title='代码解释器使助手能够编写和运行代码。该工具可以处理多种数据格式和类型的文件，并生成图表等文件。' />
                                            </Stack>
                                            {toolResources?.code_interpreter?.files?.length > 0 && (
                                                <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap' }}>
                                                    {toolResources?.code_interpreter?.files?.map((file, index) => (
                                                        <div
                                                            key={index}
                                                            style={{
                                                                display: 'flex',
                                                                flexDirection: 'row',
                                                                alignItems: 'center',
                                                                width: 'max-content',
                                                                height: 'max-content',
                                                                borderRadius: 15,
                                                                background: 'rgb(254,252,191)',
                                                                paddingLeft: 15,
                                                                paddingRight: 15,
                                                                paddingTop: 5,
                                                                paddingBottom: 5,
                                                                marginRight: 10,
                                                                marginBottom: 10
                                                            }}
                                                        >
                                                            <span style={{ color: 'rgb(116,66,16)', marginRight: 10 }}>
                                                                {file.filename}
                                                            </span>
                                                            <PermissionIconButton
                                                                permissionId={mutationPermissionId}
                                                                aria-label={`移除代码解释器文件 ${file.filename ?? file.id}`}
                                                                disabled={resourceControlsDisabled}
                                                                sx={{ height: 15, width: 15, p: 0 }}
                                                                onClick={() => onFileDeleteClick(file.id, 'code_interpreter')}
                                                            >
                                                                <IconX />
                                                            </PermissionIconButton>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                            <Typography variant='caption' color='text.secondary'>
                                                已停用新建旧版 OpenAI 助手及新增 OpenAI
                                                端资源；现有代码解释器文件仅支持查看或从本地关联中移除。
                                            </Typography>
                                        </CardContent>
                                    </Card>
                                )}
                                {assistantTools?.length > 0 && assistantTools.includes('file_search') && (
                                    <Card sx={{ mb: 2, border: '1px solid #e0e0e0', borderRadius: `${customization.borderRadius}px` }}>
                                        <CardContent>
                                            <Stack sx={{ position: 'relative', alignItems: 'center' }} direction='row'>
                                                <Typography variant='overline'>文件搜索文件</Typography>
                                                <TooltipWithParser title='文件搜索使助手能够获取您或用户上传文件中的知识。文件上传后，助手会根据用户请求自动决定何时检索内容。' />
                                            </Stack>
                                            {associatedVectorStoreId && (
                                                <Chip
                                                    label={associatedVectorStoreLabel}
                                                    sx={{ mb: 2, mt: 1 }}
                                                    variant='outlined'
                                                    color='primary'
                                                />
                                            )}
                                            {associatedVectorStoreId && (
                                                <StyledPermissionButton
                                                    permissionId='assistants:update'
                                                    disabled={!canMutateResource}
                                                    variant='outlined'
                                                    aria-describedby={`${dialogId}-vector-store-unbind-help`}
                                                    onClick={detachVectorStore}
                                                    sx={{ mb: 2, ml: 1, mt: 1 }}
                                                >
                                                    解绑向量库
                                                </StyledPermissionButton>
                                            )}
                                            {toolResources?.file_search?.files?.length > 0 && (
                                                <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap' }}>
                                                    {toolResources?.file_search?.files?.map((file, index) => (
                                                        <div
                                                            key={index}
                                                            style={{
                                                                display: 'flex',
                                                                flexDirection: 'row',
                                                                alignItems: 'center',
                                                                width: 'max-content',
                                                                height: 'max-content',
                                                                borderRadius: 15,
                                                                background: 'rgb(254,252,191)',
                                                                paddingLeft: 15,
                                                                paddingRight: 15,
                                                                paddingTop: 5,
                                                                paddingBottom: 5,
                                                                marginRight: 10,
                                                                marginBottom: 10
                                                            }}
                                                        >
                                                            <span style={{ color: 'rgb(116,66,16)', marginRight: 10 }}>
                                                                {file.filename}
                                                            </span>
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                            {!associatedVectorStoreId && (
                                                <StyledPermissionButton
                                                    permissionId={mutationPermissionId}
                                                    disabled={resourceControlsDisabled}
                                                    variant='outlined'
                                                    fullWidth
                                                    startIcon={<IconPlus />}
                                                    sx={{ marginRight: '1rem' }}
                                                    onClick={() => onAddAssistantVectorStoreClick()}
                                                >
                                                    选择既有向量库
                                                </StyledPermissionButton>
                                            )}
                                            <Typography
                                                id={`${dialogId}-vector-store-unbind-help`}
                                                variant='caption'
                                                color='text.secondary'
                                            >
                                                已停用新建旧版 OpenAI 助手及新增 OpenAI
                                                端资源；可选择既有向量库。关联或解绑只修改当前表单，需保存主助手后生效；保存会同时更新
                                                OpenAI 端助手和 Flowise 本地记录。
                                            </Typography>
                                        </CardContent>
                                    </Card>
                                )}
                            </Box>
                        </>
                    )}
                </Box>
            </DialogContent>
            <DialogActions sx={{ p: 3, pt: 0 }}>
                <Button disabled={loading || operationInFlightRef.current} onClick={handleDialogClose}>
                    {dialogProps.cancelButtonName ?? '关闭'}
                </Button>
                {dialogProps.type === 'EDIT' && (
                    <StyledPermissionButton
                        permissionId='assistants:update'
                        disabled={resourceControlsDisabled}
                        color='secondary'
                        variant='contained'
                        onClick={() => onSyncClick()}
                    >
                        同步
                    </StyledPermissionButton>
                )}
                {dialogProps.type === 'EDIT' && (
                    <StyledPermissionButton
                        permissionId={'assistants:delete'}
                        disabled={resourceBusyOrInvalid}
                        color='error'
                        variant='contained'
                        onClick={() => onDeleteClick()}
                    >
                        删除
                    </StyledPermissionButton>
                )}
                <StyledPermissionButton
                    permissionId={mutationPermissionId}
                    disabled={
                        resourceControlsDisabled || !textFieldsValid || !samplingParams.success || !(assistantModel && assistantCredential)
                    }
                    variant='contained'
                    onClick={() => (dialogProps.type === 'ADD' ? addNewAssistant() : saveAssistant())}
                >
                    {dialogProps.confirmButtonName}
                </StyledPermissionButton>
            </DialogActions>
            <DeleteConfirmDialog
                show={deleteDialogOpen}
                dialogProps={deleteDialogProps}
                onCancel={() => setDeleteDialogOpen(false)}
                onDelete={() => deleteAssistant()}
                onDeleteBoth={() => deleteAssistant(true)}
            />
            <AssistantVectorStoreDialog
                show={assistantVectorStoreDialogOpen}
                dialogProps={assistantVectorStoreDialogProps}
                onCancel={closeAssistantVectorStoreDialog}
                onConfirm={(vectorStoreObj, files) => {
                    if (!isAssistantVectorStoreDialogCurrent(assistantVectorStoreDialogProps)) {
                        closeAssistantVectorStoreDialog()
                        return
                    }
                    const currentToolResources = toolResourcesRef.current
                    const currentVectorStoreId = currentToolResources.file_search?.vector_store_ids?.[0]
                    const candidateToolResources = {
                        ...currentToolResources,
                        file_search: {
                            ...currentToolResources.file_search,
                            vector_store_object: vectorStoreObj,
                            files:
                                files ?? (vectorStoreObj?.id === currentVectorStoreId ? currentToolResources.file_search?.files ?? [] : []),
                            vector_store_ids: vectorStoreObj?.id ? [vectorStoreObj.id] : []
                        }
                    }
                    const parsedToolResources = parseAssistantToolResources(candidateToolResources)
                    if (!parsedToolResources.success) {
                        notifyInvalidMutationResponse()
                        return
                    }
                    invalidateOperations()
                    commitToolResources(parsedToolResources.data)
                    closeAssistantVectorStoreDialog()
                }}
            />
            {loading && <BackdropLoader open={loading} />}
        </Dialog>
    ) : null

    return createPortal(component, portalElement)
}

AssistantDialog.propTypes = {
    show: PropTypes.bool,
    dialogProps: PropTypes.object,
    onCancel: PropTypes.func,
    onConfirm: PropTypes.func
}

export default AssistantDialog
