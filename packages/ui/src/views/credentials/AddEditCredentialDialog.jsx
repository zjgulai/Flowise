import { createPortal } from 'react-dom'
import PropTypes from 'prop-types'
import { useState, useEffect, useRef } from 'react'
import { useDispatch } from 'react-redux'
import { enqueueSnackbar as enqueueSnackbarAction, closeSnackbar as closeSnackbarAction } from '@/store/actions'
import parser from 'html-react-parser'

// Material
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Box, Stack, OutlinedInput, Typography } from '@mui/material'

// Project imports
import { StyledButton } from '@/ui-component/button/StyledButton'
import ConfirmDialog from '@/ui-component/dialog/ConfirmDialog'
import CredentialInputHandler from './CredentialInputHandler'

// Icons
import { IconHandStop, IconX } from '@tabler/icons-react'

// API
import credentialsApi from '@/api/credentials'
import oauth2Api from '@/api/oauth2'

// Hooks
import useApi from '@/hooks/useApi'

// utils
import useNotifier from '@/utils/useNotifier'
import { getErrorMessage } from '@/utils/getErrorMessage'
import { getTrustedOAuth2MessageType } from '@/utils/getTrustedOAuth2MessageType'
import { useAuth } from '@/hooks/useAuth'
import { initializeDefaultNodeData } from '@/utils/genericHelper'

// const
import { baseURL, REDACTED_CREDENTIAL_VALUE } from '@/store/constant'
import { HIDE_CANVAS_DIALOG, SHOW_CANVAS_DIALOG } from '@/store/actions'
import keySVG from '@/assets/images/key.svg'

export const createOAuth2PopupSession = ({
    authWindow,
    credentialId,
    expectedOrigin,
    eventTarget,
    onSuccess,
    onFailure,
    closedCheckIntervalMs = 1000,
    timeoutMs = 300000
}) => {
    let settled = false
    let closedCheckIntervalId
    let timeoutId
    let handleMessage

    const isAuthWindowClosed = () => {
        try {
            return authWindow.closed
        } catch {
            return true
        }
    }

    const closeAuthWindow = () => {
        try {
            if (!authWindow.closed) authWindow.close()
        } catch {
            // Local cleanup is complete even if the browser refuses to close the popup.
        }
    }

    const cleanup = () => {
        if (closedCheckIntervalId !== undefined) eventTarget.clearInterval(closedCheckIntervalId)
        if (timeoutId !== undefined) eventTarget.clearTimeout(timeoutId)
        if (handleMessage) eventTarget.removeEventListener('message', handleMessage)
    }

    const settle = (outcome) => {
        if (settled) return
        settled = true
        cleanup()

        try {
            if (outcome === 'success') onSuccess()
            else onFailure(outcome)
        } finally {
            closeAuthWindow()
        }
    }

    handleMessage = (event) => {
        const messageType = getTrustedOAuth2MessageType(event, {
            expectedOrigin,
            expectedSource: authWindow,
            credentialId
        })
        if (!messageType) return

        settle(messageType === 'OAUTH2_SUCCESS' ? 'success' : 'error')
    }

    eventTarget.addEventListener('message', handleMessage)
    closedCheckIntervalId = eventTarget.setInterval(() => {
        if (isAuthWindowClosed()) settle('closed')
    }, closedCheckIntervalMs)
    timeoutId = eventTarget.setTimeout(() => settle('timeout'), timeoutMs)

    return {
        cancel: () => {
            if (settled) return
            settled = true
            cleanup()
            closeAuthWindow()
        }
    }
}

const AddEditCredentialDialog = ({ show, dialogProps, onCancel, onConfirm, setError }) => {
    const portalElement = document.getElementById('portal')

    const dispatch = useDispatch()

    // ==============================|| Snackbar ||============================== //

    useNotifier()

    const { hasPermission } = useAuth()
    const canReveal = hasPermission('credentials:create') || hasPermission('credentials:update')

    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))

    const getSpecificCredentialApi = useApi(credentialsApi.getSpecificCredential)
    const getSpecificComponentCredentialApi = useApi(credentialsApi.getSpecificComponentCredential)

    const [credential, setCredential] = useState({})
    const [name, setName] = useState('')
    const [credentialData, setCredentialData] = useState({})
    const [componentCredential, setComponentCredential] = useState({})
    const [shared, setShared] = useState(false)
    const [revealedData, setRevealedData] = useState(null)
    const oauthSessionRef = useRef(null)

    useEffect(() => {
        if (getSpecificCredentialApi.data) {
            const shared = getSpecificCredentialApi.data.shared
            setShared(shared)
            if (!shared) {
                setCredential(getSpecificCredentialApi.data)
                if (getSpecificCredentialApi.data.name) {
                    setName(getSpecificCredentialApi.data.name)
                }
                if (getSpecificCredentialApi.data.plainDataObj) {
                    setCredentialData(getSpecificCredentialApi.data.plainDataObj)
                }
                getSpecificComponentCredentialApi.request(getSpecificCredentialApi.data.credentialName)
            }
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getSpecificCredentialApi.data])

    useEffect(() => {
        if (getSpecificComponentCredentialApi.data) {
            setComponentCredential(getSpecificComponentCredentialApi.data)
        }
    }, [getSpecificComponentCredentialApi.data])

    useEffect(() => {
        if (getSpecificCredentialApi.error && setError) {
            setError(new Error('加载凭据失败，请稍后重试'))
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getSpecificCredentialApi.error])

    useEffect(() => {
        if (getSpecificComponentCredentialApi.error && setError) {
            setError(new Error('加载凭据类型失败，请稍后重试'))
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getSpecificComponentCredentialApi.error])

    useEffect(() => {
        setRevealedData(null)
        if (dialogProps.type === 'EDIT' && dialogProps.data) {
            // When credential dialog is opened from Credentials dashboard
            getSpecificCredentialApi.request(dialogProps.data.id)
        } else if (dialogProps.type === 'EDIT' && dialogProps.credentialId) {
            // When credential dialog is opened from node in canvas
            getSpecificCredentialApi.request(dialogProps.credentialId)
        } else if (dialogProps.type === 'ADD' && dialogProps.credentialComponent) {
            // When credential dialog is to add a new credential
            setName('')
            setCredential({})
            const defaultCredentialData = initializeDefaultNodeData(dialogProps.credentialComponent.inputs)
            setCredentialData(defaultCredentialData)
            setComponentCredential(dialogProps.credentialComponent)
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dialogProps])

    useEffect(() => {
        if (show) dispatch({ type: SHOW_CANVAS_DIALOG })
        else dispatch({ type: HIDE_CANVAS_DIALOG })
        return () => dispatch({ type: HIDE_CANVAS_DIALOG })
    }, [show, dispatch])

    useEffect(() => {
        if (!show) {
            oauthSessionRef.current?.cancel()
            oauthSessionRef.current = null
        }

        return () => {
            oauthSessionRef.current?.cancel()
            oauthSessionRef.current = null
        }
    }, [show])

    const isMaskedUrlValue = (value) => typeof value === 'string' && value.includes('\u2022\u2022\u2022\u2022\u2022\u2022')

    const handleRevealField = async (fieldName) => {
        let data = revealedData
        if (!data) {
            const resp = await credentialsApi.revealCredential(credential.id)
            data = resp.data.plainDataObj
            setRevealedData(data)
        }
        return data[fieldName]
    }

    const addNewCredential = async () => {
        try {
            const obj = {
                name,
                credentialName: componentCredential.name,
                plainDataObj: credentialData
            }
            const createResp = await credentialsApi.createCredential(obj)
            if (createResp.data) {
                enqueueSnackbar({
                    message: '已添加新凭据',
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
                onConfirm(createResp.data.id)
            }
        } catch (error) {
            if (setError) setError(new Error('添加凭据失败，请稍后重试'))
            enqueueSnackbar({
                message: `添加凭据失败：${getErrorMessage(error)}`,
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
            onCancel()
        }
    }

    const saveCredential = async () => {
        try {
            const saveObj = {
                name,
                credentialName: componentCredential.name
            }

            let plainDataObj = {}
            for (const key in credentialData) {
                if (credentialData[key] !== REDACTED_CREDENTIAL_VALUE && !isMaskedUrlValue(credentialData[key])) {
                    plainDataObj[key] = credentialData[key]
                }
            }
            if (Object.keys(plainDataObj).length) saveObj.plainDataObj = plainDataObj

            const saveResp = await credentialsApi.updateCredential(credential.id, saveObj)
            if (saveResp.data) {
                enqueueSnackbar({
                    message: '凭据已保存',
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
                onConfirm(saveResp.data.id)
            }
        } catch (error) {
            if (setError) setError(new Error('保存凭据失败，请稍后重试'))
            enqueueSnackbar({
                message: `保存凭据失败：${getErrorMessage(error)}`,
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
            onCancel()
        }
    }

    const setOAuth2 = async () => {
        oauthSessionRef.current?.cancel()
        oauthSessionRef.current = null

        try {
            let credentialId = null

            // First save or add the credential
            if (dialogProps.type === 'ADD') {
                // Add new credential first
                const obj = {
                    name,
                    credentialName: componentCredential.name,
                    plainDataObj: credentialData
                }
                const createResp = await credentialsApi.createCredential(obj)
                if (createResp.data) {
                    credentialId = createResp.data.id
                }
            } else {
                // Save existing credential first
                const saveObj = {
                    name,
                    credentialName: componentCredential.name
                }

                let plainDataObj = {}
                for (const key in credentialData) {
                    if (credentialData[key] !== REDACTED_CREDENTIAL_VALUE && !isMaskedUrlValue(credentialData[key])) {
                        plainDataObj[key] = credentialData[key]
                    }
                }
                if (Object.keys(plainDataObj).length) saveObj.plainDataObj = plainDataObj

                const saveResp = await credentialsApi.updateCredential(credential.id, saveObj)
                if (saveResp.data) {
                    credentialId = credential.id
                }
            }

            if (!credentialId) {
                throw new Error('保存凭据失败')
            }

            const authResponse = await oauth2Api.authorize(credentialId)

            if (authResponse.data && authResponse.data.success && authResponse.data.authorizationUrl) {
                // Open the authorization URL in a new window/tab
                const authWindow = window.open(
                    authResponse.data.authorizationUrl,
                    '_blank',
                    'width=600,height=700,scrollbars=yes,resizable=yes'
                )

                if (!authWindow) {
                    throw new Error('打开授权窗口失败，请检查是否阻止了弹窗。')
                }

                let oauthSession
                oauthSession = createOAuth2PopupSession({
                    authWindow,
                    credentialId,
                    expectedOrigin: window.location.origin,
                    eventTarget: window,
                    onSuccess: () => {
                        if (oauthSessionRef.current === oauthSession) oauthSessionRef.current = null
                        enqueueSnackbar({
                            message: 'OAuth2 授权已完成',
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
                        onConfirm(credentialId)
                    },
                    onFailure: (reason) => {
                        if (oauthSessionRef.current === oauthSession) oauthSessionRef.current = null
                        const failureMessage =
                            reason === 'closed'
                                ? '授权窗口已关闭，OAuth2 授权未完成'
                                : reason === 'timeout'
                                ? 'OAuth2 授权超时，请重试'
                                : 'OAuth2 授权失败，请重试'
                        enqueueSnackbar({
                            message: failureMessage,
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
                })
                oauthSessionRef.current = oauthSession
            } else {
                throw new Error('授权端点返回了无效响应')
            }
        } catch {
            if (setError) setError(new Error('OAuth2 授权失败'))
            enqueueSnackbar({
                message: 'OAuth2 授权失败，请重试',
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
    }

    const component = show ? (
        <Dialog
            fullWidth
            maxWidth='sm'
            open={show}
            onClose={onCancel}
            aria-labelledby='alert-dialog-title'
            aria-describedby='alert-dialog-description'
        >
            <DialogTitle sx={{ fontSize: '1rem' }} id='alert-dialog-title'>
                {!shared && componentCredential && componentCredential.label && (
                    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
                        <div
                            style={{
                                width: 50,
                                height: 50,
                                marginRight: 10,
                                borderRadius: '50%',
                                backgroundColor: 'white'
                            }}
                        >
                            <img
                                style={{
                                    width: '100%',
                                    height: '100%',
                                    padding: 7,
                                    borderRadius: '50%',
                                    objectFit: 'contain'
                                }}
                                alt={componentCredential.name}
                                src={`${baseURL}/api/v1/components-credentials-icon/${componentCredential.name}`}
                                onError={(e) => {
                                    e.target.onerror = null
                                    e.target.style.padding = '5px'
                                    e.target.src = keySVG
                                }}
                            />
                        </div>
                        {componentCredential.label}
                    </div>
                )}
            </DialogTitle>
            <DialogContent>
                {shared && (
                    <div
                        style={{
                            display: 'flex',
                            flexDirection: 'column',
                            borderRadius: 10,
                            background: '#f37a97',
                            padding: 10,
                            marginTop: 10,
                            marginBottom: 10
                        }}
                    >
                        <div
                            style={{
                                display: 'flex',
                                flexDirection: 'row',
                                alignItems: 'center'
                            }}
                        >
                            <IconHandStop size={25} color='white' />
                            <span style={{ color: 'white', marginLeft: 10, fontWeight: 400 }}>共享凭据不可编辑。</span>
                        </div>
                    </div>
                )}
                {!shared && componentCredential && componentCredential.description && (
                    <Box sx={{ pl: 2, pr: 2 }}>
                        <div
                            style={{
                                display: 'flex',
                                flexDirection: 'row',
                                borderRadius: 10,
                                background: 'rgb(254,252,191)',
                                padding: 10,
                                marginTop: 10,
                                marginBottom: 10
                            }}
                        >
                            <span style={{ color: 'rgb(116,66,16)' }}>{parser(componentCredential.description)}</span>
                        </div>
                    </Box>
                )}
                {!shared && componentCredential && componentCredential.label && (
                    <Box sx={{ p: 2 }}>
                        <Stack sx={{ position: 'relative' }} direction='row'>
                            <Typography variant='overline'>
                                凭据名称
                                <span style={{ color: 'red' }}>&nbsp;*</span>
                            </Typography>
                        </Stack>
                        <OutlinedInput
                            id='credName'
                            type='string'
                            fullWidth
                            placeholder={componentCredential.label}
                            value={name}
                            name='name'
                            onChange={(e) => setName(e.target.value)}
                        />
                    </Box>
                )}
                {!shared && componentCredential && componentCredential.name && componentCredential.name.includes('OAuth2') && (
                    <Box sx={{ p: 2 }}>
                        <Stack sx={{ position: 'relative' }} direction='row'>
                            <Typography variant='overline'>OAuth2 重定向 URL</Typography>
                        </Stack>
                        <OutlinedInput
                            id='oauthRedirectUrl'
                            type='string'
                            disabled
                            fullWidth
                            value={`${baseURL}/api/v1/oauth2-credential/callback`}
                        />
                    </Box>
                )}
                {!shared &&
                    componentCredential &&
                    componentCredential.inputs &&
                    componentCredential.inputs
                        .filter((inputParam) => inputParam.hidden !== true)
                        .map((inputParam, index) => (
                            <CredentialInputHandler
                                key={index}
                                inputParam={inputParam}
                                data={credentialData}
                                onReveal={dialogProps.type === 'EDIT' && canReveal ? handleRevealField : undefined}
                            />
                        ))}

                {!shared && componentCredential && componentCredential.name && componentCredential.name.includes('OAuth2') && (
                    <Box sx={{ p: 2 }}>
                        <Button variant='contained' color='secondary' onClick={() => setOAuth2()}>
                            授权
                        </Button>
                    </Box>
                )}
            </DialogContent>
            <DialogActions>
                {!shared && (
                    <StyledButton
                        disabled={!name}
                        variant='contained'
                        onClick={() => (dialogProps.type === 'ADD' ? addNewCredential() : saveCredential())}
                    >
                        {dialogProps.confirmButtonName}
                    </StyledButton>
                )}
            </DialogActions>
            <ConfirmDialog />
        </Dialog>
    ) : null

    return createPortal(component, portalElement)
}

AddEditCredentialDialog.propTypes = {
    show: PropTypes.bool,
    dialogProps: PropTypes.object,
    onCancel: PropTypes.func,
    onConfirm: PropTypes.func,
    setError: PropTypes.func
}

export default AddEditCredentialDialog
