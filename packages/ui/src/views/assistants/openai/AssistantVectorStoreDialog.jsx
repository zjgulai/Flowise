import { createPortal } from 'react-dom'
import PropTypes from 'prop-types'
import { useEffect, useId, useRef, useState } from 'react'
import { useDispatch } from 'react-redux'
import { enqueueSnackbar as enqueueSnackbarAction, closeSnackbar as closeSnackbarAction } from '@/store/actions'

import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Box, Stack, OutlinedInput, Typography } from '@mui/material'

import { StyledPermissionButton } from '@/ui-component/button/RBACButtons'
import { SwitchInput } from '@/ui-component/switch/Switch'
import { Dropdown } from '@/ui-component/dropdown/Dropdown'
import { BackdropLoader } from '@/ui-component/loading/BackdropLoader'

import { IconX } from '@tabler/icons-react'

import assistantsApi from '@/api/assistants'

import useNotifier from '@/utils/useNotifier'
import { formatBytes } from '@/utils/genericHelper'

import { createAssistantScopeKey, INVALID_ASSISTANT_MUTATION_RESPONSE_MESSAGE } from './assistantResourceState'
import { parseAssistantVectorStoreList } from './assistantVectorStoreState'

const AssistantVectorStoreDialog = ({ show, dialogProps, onCancel, onConfirm }) => {
    const portalElement = document.getElementById('portal')
    const dispatch = useDispatch()
    const dialogId = `assistant-vector-store-${useId()}`
    const titleId = `${dialogId}-title`
    const contentId = `${dialogId}-content`

    useNotifier()

    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))

    const [name, setName] = useState('')
    const [isExpirationOn, setExpirationOnOff] = useState(false)
    const [expirationDays, setExpirationDays] = useState(7)
    const [availableVectorStores, setAvailableVectorStores] = useState([])
    const [selectedVectorStore, setSelectedVectorStore] = useState('')
    const [loading, setLoading] = useState(false)
    const [resourceValid, setResourceValid] = useState(false)
    const [resourceScopeKey, setResourceScopeKey] = useState('')

    const currentShowRef = useRef(show)
    const currentScopeKeyRef = useRef('')
    const loadGenerationRef = useRef(0)
    const loadAbortControllerRef = useRef(null)

    const requestedScopeKey = createAssistantScopeKey([
        show,
        dialogProps.type ?? '',
        dialogProps.credential ?? '',
        dialogProps.assistantScope?.key ?? dialogProps.assistantScope?.id ?? '',
        dialogProps.assistantScope?.generation ?? '',
        dialogProps.vectorStoreGeneration ?? '',
        dialogProps.data?.id ?? ''
    ])
    currentShowRef.current = show
    currentScopeKeyRef.current = requestedScopeKey
    const isValidResource = resourceValid && resourceScopeKey === requestedScopeKey

    const notify = (message, variant = 'error', persist = variant === 'error') => {
        enqueueSnackbar({
            message,
            options: {
                key: new Date().getTime() + Math.random(),
                variant,
                persist,
                action: (key) => (
                    <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                        <IconX />
                    </Button>
                )
            }
        })
    }

    const resetForm = () => {
        setName('')
        setExpirationOnOff(false)
        setExpirationDays(7)
        setAvailableVectorStores([])
        setSelectedVectorStore('')
        setResourceValid(false)
        setResourceScopeKey('')
    }

    const applyVectorStoreToForm = (vectorStore) => {
        setSelectedVectorStore(vectorStore.id)
        setName(vectorStore.name ?? '')
        if (vectorStore.expires_after?.days) {
            setExpirationDays(vectorStore.expires_after.days)
            setExpirationOnOff(true)
        } else {
            setExpirationDays(7)
            setExpirationOnOff(false)
        }
    }

    useEffect(
        () => () => {
            currentShowRef.current = false
            loadGenerationRef.current += 1
            loadAbortControllerRef.current?.abort()
        },
        []
    )

    useEffect(() => {
        loadAbortControllerRef.current?.abort()
        setLoading(false)
        resetForm()

        const abortController = new AbortController()
        loadAbortControllerRef.current = abortController
        const loadGeneration = ++loadGenerationRef.current
        const credential = dialogProps.credential
        const isLoadCurrent = () =>
            !abortController.signal.aborted &&
            loadGenerationRef.current === loadGeneration &&
            currentScopeKeyRef.current === requestedScopeKey &&
            currentShowRef.current

        if (!show) return () => abortController.abort()
        if (!credential || dialogProps.type !== 'ADD') {
            notify('向量库上下文无效，请关闭后重试。')
            return () => abortController.abort()
        }

        const loadVectorStores = async () => {
            setLoading(true)
            try {
                const listResponse = await assistantsApi.listAssistantVectorStore(credential, { signal: abortController.signal })
                if (!isLoadCurrent()) return

                const parsedList = parseAssistantVectorStoreList(listResponse?.data)
                if (!parsedList.success) {
                    notify(INVALID_ASSISTANT_MUTATION_RESPONSE_MESSAGE)
                    return
                }

                setAvailableVectorStores(parsedList.data)
                setResourceScopeKey(requestedScopeKey)
                setResourceValid(true)
            } catch (error) {
                if (!isLoadCurrent() || error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError') return
                notify('加载向量库失败，请稍后重试。')
            } finally {
                if (isLoadCurrent()) setLoading(false)
            }
        }

        void loadVectorStores()
        return () => abortController.abort()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [requestedScopeKey])

    const selectVectorStore = (newValue) => {
        if (loading || !isValidResource) return
        const vectorStore = availableVectorStores.find((store) => store.id === newValue)
        if (!vectorStore) {
            notify(INVALID_ASSISTANT_MUTATION_RESPONSE_MESSAGE)
            return
        }
        applyVectorStoreToForm(vectorStore)
    }

    const attachExistingVectorStore = () => {
        if (loading || !isValidResource || dialogProps.type !== 'ADD' || !selectedVectorStore) return
        const vectorStore = availableVectorStores.find((store) => store.id === selectedVectorStore)
        if (!vectorStore) {
            notify(INVALID_ASSISTANT_MUTATION_RESPONSE_MESSAGE)
            return
        }
        onConfirm(vectorStore)
    }

    const handleCancel = () => {
        loadAbortControllerRef.current?.abort()
        setLoading(false)
        onCancel()
    }

    const availableVectorStoreOptions = availableVectorStores.map((vectorStore) => ({
        label: vectorStore.name ?? vectorStore.id,
        name: vectorStore.id,
        description: `${vectorStore.file_counts?.total ?? 0} 个文件（${formatBytes(vectorStore.usage_bytes ?? 0)}）`
    }))
    const controlsDisabled = loading || !isValidResource
    const vectorStoreFieldsDisabled = true
    const submitPermissionId = dialogProps.assistantMutationPermissionId ?? 'assistants:update'

    const component = show ? (
        <Dialog fullWidth maxWidth='sm' open={show} onClose={handleCancel} aria-labelledby={titleId}>
            <DialogTitle sx={{ fontSize: '1rem' }} id={titleId}>
                {dialogProps.title}
            </DialogTitle>
            <DialogContent id={contentId}>
                <Box sx={{ p: 2 }}>
                    <Stack sx={{ position: 'relative' }} direction='row'>
                        <Typography component='label' htmlFor='assistantVectorStore' variant='overline'>
                            选择向量库
                            <span style={{ color: 'red' }}>&nbsp;*</span>
                        </Typography>
                    </Stack>
                    <Dropdown
                        disabled={controlsDisabled}
                        name='assistantVectorStore'
                        options={availableVectorStoreOptions}
                        loading={loading}
                        onSelect={selectVectorStore}
                        value={selectedVectorStore ?? '请选择一个选项'}
                    />
                </Box>

                {selectedVectorStore !== '' && (
                    <>
                        <Box sx={{ p: 2 }}>
                            <Stack sx={{ position: 'relative' }} direction='row'>
                                <Typography component='label' htmlFor='vsName' variant='overline'>
                                    向量库名称
                                </Typography>
                            </Stack>
                            <OutlinedInput
                                id='vsName'
                                disabled={vectorStoreFieldsDisabled}
                                type='string'
                                fullWidth
                                placeholder='我的向量库'
                                value={name}
                                inputProps={{ 'aria-label': '向量库名称' }}
                                onChange={(event) => setName(event.target.value)}
                            />
                        </Box>

                        <Box sx={{ p: 2 }}>
                            <Stack sx={{ position: 'relative' }} direction='row'>
                                <Typography variant='overline'>向量库过期设置</Typography>
                            </Stack>
                            <SwitchInput
                                label='启用向量库过期设置'
                                disabled={vectorStoreFieldsDisabled}
                                onChange={(newValue) => setExpirationOnOff(newValue)}
                                value={isExpirationOn}
                            />
                        </Box>

                        {isExpirationOn && (
                            <Box sx={{ p: 2 }}>
                                <Stack sx={{ position: 'relative' }} direction='row'>
                                    <Typography component='label' htmlFor='expDays' variant='overline'>
                                        有效天数
                                        <span style={{ color: 'red' }}>&nbsp;*</span>
                                    </Typography>
                                </Stack>
                                <OutlinedInput
                                    id='expDays'
                                    disabled={vectorStoreFieldsDisabled}
                                    type='number'
                                    fullWidth
                                    value={expirationDays}
                                    inputProps={{ 'aria-label': '有效天数', min: 1, step: 1 }}
                                    onChange={(event) => setExpirationDays(event.target.value)}
                                />
                            </Box>
                        )}
                    </>
                )}
            </DialogContent>
            <DialogActions>
                <Button onClick={handleCancel}>{dialogProps.cancelButtonName ?? '取消'}</Button>
                <StyledPermissionButton
                    permissionId={submitPermissionId}
                    disabled={controlsDisabled || !selectedVectorStore}
                    variant='contained'
                    onClick={attachExistingVectorStore}
                >
                    {dialogProps.confirmButtonName}
                </StyledPermissionButton>
            </DialogActions>
            {loading && <BackdropLoader open={loading} />}
        </Dialog>
    ) : null

    return createPortal(component, portalElement)
}

AssistantVectorStoreDialog.propTypes = {
    show: PropTypes.bool,
    dialogProps: PropTypes.object,
    onCancel: PropTypes.func,
    onConfirm: PropTypes.func
}

export default AssistantVectorStoreDialog
