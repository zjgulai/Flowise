import { createPortal } from 'react-dom'
import PropTypes from 'prop-types'
import { useState, useEffect, useRef } from 'react'
import { useDispatch } from 'react-redux'
import {
    HIDE_CANVAS_DIALOG,
    SHOW_CANVAS_DIALOG,
    enqueueSnackbar as enqueueSnackbarAction,
    closeSnackbar as closeSnackbarAction
} from '@/store/actions'

// Material
import {
    Alert,
    Box,
    Button,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    OutlinedInput,
    Typography
} from '@mui/material'

// Project imports
import { StyledButton } from '@/ui-component/button/StyledButton'
import ConfirmDialog from '@/ui-component/dialog/ConfirmDialog'

// Icons
import { IconX, IconFiles } from '@tabler/icons-react'

// API
import documentStoreApi, {
    DOCUMENT_STORE_VERSION_CONFLICT_MESSAGE,
    isDocumentStoreVersionConflict,
    requireDocumentStoreVersionToken
} from '@/api/documentstore'

// utils
import { getErrorMessage } from '@/utils/getErrorMessage'
import useNotifier from '@/utils/useNotifier'

const AddDocStoreDialog = ({ show, dialogProps, onCancel, onConfirm }) => {
    const portalElement = document.getElementById('portal')

    const dispatch = useDispatch()

    // ==============================|| Snackbar ||============================== //

    useNotifier()

    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))

    const [documentStoreName, setDocumentStoreName] = useState('')
    const [documentStoreDesc, setDocumentStoreDesc] = useState('')
    const [dialogType, setDialogType] = useState('ADD')
    const [docStoreId, setDocumentStoreId] = useState()
    const [versionToken, setVersionToken] = useState()
    const [hasVersionConflict, setHasVersionConflict] = useState(false)
    const [isSubmitting, setIsSubmitting] = useState(false)
    const submitErrorSnackbarKey = useRef()

    const dismissSubmitError = () => {
        if (!submitErrorSnackbarKey.current) return
        closeSnackbar(submitErrorSnackbarKey.current)
        submitErrorSnackbarKey.current = undefined
    }

    useEffect(() => {
        setDialogType(dialogProps.type)
        if (dialogProps.type === 'EDIT' && dialogProps.data) {
            setDocumentStoreName(dialogProps.data.name)
            setDocumentStoreDesc(dialogProps.data.description)
            setDocumentStoreId(dialogProps.data.id)
            setVersionToken(dialogProps.data.versionToken)
            setHasVersionConflict(false)
        } else if (dialogProps.type === 'ADD') {
            setDocumentStoreName('')
            setDocumentStoreDesc('')
            setDocumentStoreId(undefined)
            setVersionToken(undefined)
            setHasVersionConflict(false)
        }

        return () => {
            setDocumentStoreName('')
            setDocumentStoreDesc('')
            setDocumentStoreId(undefined)
            setVersionToken(undefined)
            setHasVersionConflict(false)
        }
    }, [dialogProps])

    useEffect(() => {
        if (show) dispatch({ type: SHOW_CANVAS_DIALOG })
        else dispatch({ type: HIDE_CANVAS_DIALOG })
        return () => dispatch({ type: HIDE_CANVAS_DIALOG })
    }, [show, dispatch])

    const createDocumentStore = async () => {
        if (isSubmitting) return
        setIsSubmitting(true)
        try {
            const obj = {
                name: documentStoreName,
                description: documentStoreDesc
            }
            const createResp = await documentStoreApi.createDocumentStore(obj)
            if (createResp.data) {
                dismissSubmitError()
                enqueueSnackbar({
                    message: '文档库已创建',
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
                onConfirm(createResp.data.id, {
                    ...(createResp.data || {}),
                    name: documentStoreName,
                    description: documentStoreDesc
                })
            }
        } catch (error) {
            const key = new Date().getTime() + Math.random()
            submitErrorSnackbarKey.current = key
            enqueueSnackbar({
                message: `新增文档库失败：${getErrorMessage(error, '未知错误')}`,
                options: {
                    key,
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
            setIsSubmitting(false)
        }
    }

    const updateDocumentStore = async () => {
        if (isSubmitting || hasVersionConflict) return
        setIsSubmitting(true)
        try {
            const saveObj = {
                name: documentStoreName,
                description: documentStoreDesc
            }

            const saveResp = await documentStoreApi.updateDocumentStore(docStoreId, saveObj, versionToken)
            if (saveResp.data) {
                dismissSubmitError()
                enqueueSnackbar({
                    message: '文档库已更新',
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
                onConfirm(saveResp.data.id, {
                    ...(saveResp.data || {}),
                    name: documentStoreName,
                    description: documentStoreDesc
                })
            }
        } catch (error) {
            if (isDocumentStoreVersionConflict(error)) {
                setVersionToken(undefined)
                setHasVersionConflict(true)
                const key = new Date().getTime() + Math.random()
                submitErrorSnackbarKey.current = key
                enqueueSnackbar({
                    message: DOCUMENT_STORE_VERSION_CONFLICT_MESSAGE,
                    options: { key, variant: 'warning' }
                })
                return
            }
            const key = new Date().getTime() + Math.random()
            submitErrorSnackbarKey.current = key
            enqueueSnackbar({
                message: `更新文档库失败：${getErrorMessage(error, '未知错误')}`,
                options: {
                    key,
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
            setIsSubmitting(false)
        }
    }

    const reloadLatestValues = async () => {
        if (isSubmitting || !docStoreId) return
        setIsSubmitting(true)
        try {
            const latestResponse = await documentStoreApi.getSpecificDocumentStore(docStoreId)
            const latestVersionToken = requireDocumentStoreVersionToken(latestResponse.data)
            setDocumentStoreName(latestResponse.data.name || '')
            setDocumentStoreDesc(latestResponse.data.description || '')
            setVersionToken(latestVersionToken)
            setHasVersionConflict(false)
            dismissSubmitError()
            enqueueSnackbar({
                message: '已重新载入最新值，请确认后提交',
                options: { variant: 'info' }
            })
        } catch (error) {
            setVersionToken(undefined)
            setHasVersionConflict(true)
            enqueueSnackbar({
                message: `重新载入失败：${getErrorMessage(error, '未知错误')}`,
                options: { variant: 'error' }
            })
        } finally {
            setIsSubmitting(false)
        }
    }

    const component = show ? (
        <Dialog
            fullWidth
            maxWidth='sm'
            open={show}
            onClose={isSubmitting ? undefined : onCancel}
            aria-labelledby='alert-dialog-title'
            aria-describedby='alert-dialog-description'
        >
            <DialogTitle style={{ fontSize: '1rem' }} id='alert-dialog-title'>
                <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
                    <IconFiles style={{ marginRight: '10px' }} />
                    {dialogProps.title}
                </div>
            </DialogTitle>
            <DialogContent>
                {hasVersionConflict && (
                    <Alert
                        severity='warning'
                        sx={{ mt: 2 }}
                        action={
                            <Button color='inherit' size='small' disabled={isSubmitting} onClick={reloadLatestValues}>
                                重新载入最新值
                            </Button>
                        }
                    >
                        当前草稿已保留，但不能与新版本令牌混用。请重新载入后再编辑和提交。
                    </Alert>
                )}
                <Box sx={{ p: 2 }}>
                    <div style={{ display: 'flex', flexDirection: 'row' }}>
                        <Typography>
                            名称<span style={{ color: 'red' }}>&nbsp;*</span>
                        </Typography>

                        <div style={{ flexGrow: 1 }}></div>
                    </div>
                    <OutlinedInput
                        id='txtInput_documentStoreName'
                        size='small'
                        sx={{ mt: 1 }}
                        type='string'
                        fullWidth
                        key='documentStoreName'
                        onChange={(e) => setDocumentStoreName(e.target.value)}
                        value={documentStoreName ?? ''}
                    />
                </Box>
                <Box sx={{ p: 2 }}>
                    <div style={{ display: 'flex', flexDirection: 'row' }}>
                        <Typography>描述</Typography>

                        <div style={{ flexGrow: 1 }}></div>
                    </div>
                    <OutlinedInput
                        id='txtInput_documentStoreDescription'
                        size='small'
                        multiline={true}
                        rows={7}
                        sx={{ mt: 1 }}
                        type='string'
                        fullWidth
                        key='documentStoreDesc'
                        onChange={(e) => setDocumentStoreDesc(e.target.value)}
                        value={documentStoreDesc ?? ''}
                    />
                </Box>
            </DialogContent>
            <DialogActions>
                <Button disabled={isSubmitting} onClick={() => onCancel()}>
                    取消
                </Button>
                <StyledButton
                    id='btn_submitDocumentStore'
                    disabled={isSubmitting || hasVersionConflict || !documentStoreName.trim()}
                    variant='contained'
                    onClick={() => (dialogType === 'ADD' ? createDocumentStore() : updateDocumentStore())}
                >
                    {isSubmitting ? (
                        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
                            <CircularProgress size={18} color='inherit' />
                            正在提交…
                        </Box>
                    ) : (
                        dialogProps.confirmButtonName
                    )}
                </StyledButton>
            </DialogActions>
            <ConfirmDialog />
        </Dialog>
    ) : null

    return createPortal(component, portalElement)
}

AddDocStoreDialog.propTypes = {
    show: PropTypes.bool,
    dialogProps: PropTypes.object,
    onCancel: PropTypes.func,
    onConfirm: PropTypes.func
}

export default AddDocStoreDialog
