import { useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { enqueueSnackbar as enqueueSnackbarAction, closeSnackbar as closeSnackbarAction, SET_CHATFLOW } from '@/store/actions'
import PropTypes from 'prop-types'

import { Typography, Button, OutlinedInput, Stack, Box } from '@mui/material'

// Project import
import { StyledButton } from '@/ui-component/button/StyledButton'
import { TooltipWithParser } from '@/ui-component/tooltip/TooltipWithParser'
import { SwitchInput } from '@/ui-component/switch/Switch'

// Icons
import { IconX } from '@tabler/icons-react'

// API
import chatflowsApi from '@/api/chatflows'

// utils
import useNotifier from '@/utils/useNotifier'
import { getErrorMessage } from '@/utils/getErrorMessage'

const RateLimit = ({ dialogProps, hideTitle = false }) => {
    const dispatch = useDispatch()
    const chatflow = useSelector((state) => state.canvas.chatflow)
    const chatflowid = chatflow.id
    const apiConfig = chatflow.apiConfig ? JSON.parse(chatflow.apiConfig) : {}

    useNotifier()

    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))

    const [rateLimitStatus, setRateLimitStatus] = useState(apiConfig?.rateLimit?.status !== undefined ? apiConfig.rateLimit.status : false)
    const [limitMax, setLimitMax] = useState(apiConfig?.rateLimit?.limitMax ?? '')
    const [limitDuration, setLimitDuration] = useState(apiConfig?.rateLimit?.limitDuration ?? '')
    const [limitMsg, setLimitMsg] = useState(apiConfig?.rateLimit?.limitMsg ?? '')

    const formatObj = () => {
        let apiConfig = JSON.parse(dialogProps.chatflow.apiConfig)
        if (apiConfig === null || apiConfig === undefined) {
            apiConfig = {}
        }
        let obj = { status: rateLimitStatus }

        if (rateLimitStatus) {
            const rateLimitValuesBoolean = [!limitMax, !limitDuration, !limitMsg]
            const rateLimitFilledValues = rateLimitValuesBoolean.filter((value) => value === false)
            if (rateLimitFilledValues.length >= 1 && rateLimitFilledValues.length <= 2) {
                throw new Error('请填写所有速率限制字段')
            } else if (rateLimitFilledValues.length === 3) {
                obj = {
                    ...obj,
                    limitMax,
                    limitDuration,
                    limitMsg
                }
            }
        }
        apiConfig.rateLimit = obj
        return apiConfig
    }

    const handleChange = (value) => {
        setRateLimitStatus(value)
    }

    const checkDisabled = () => {
        if (rateLimitStatus) {
            if (limitMax === '' || limitDuration === '' || limitMsg === '') {
                return true
            }
        }
        return false
    }

    const onSave = async () => {
        try {
            const saveResp = await chatflowsApi.updateChatflow(chatflowid, {
                apiConfig: JSON.stringify(formatObj())
            })
            if (saveResp.data) {
                enqueueSnackbar({
                    message: '速率限制配置已保存',
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
                dispatch({ type: SET_CHATFLOW, chatflow: saveResp.data })
            }
        } catch (error) {
            enqueueSnackbar({
                message: `保存速率限制配置失败：${getErrorMessage(error, '未知错误')}`,
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

    const onTextChanged = (value, fieldName) => {
        switch (fieldName) {
            case 'limitMax':
                setLimitMax(value)
                break
            case 'limitDuration':
                setLimitDuration(value)
                break
            case 'limitMsg':
                setLimitMsg(value)
                break
        }
    }

    const textField = (message, fieldName, fieldLabel, fieldType = 'string', placeholder = '') => {
        return (
            <Stack direction='column' spacing={1}>
                <Typography>{fieldLabel}</Typography>
                <OutlinedInput
                    id={fieldName}
                    type={fieldType}
                    fullWidth
                    value={message}
                    placeholder={placeholder}
                    name={fieldName}
                    size='small'
                    onChange={(e) => {
                        onTextChanged(e.target.value, fieldName)
                    }}
                />
            </Stack>
        )
    }

    return (
        <Stack direction='column' spacing={2} sx={{ width: '100%' }}>
            {!hideTitle && (
                <Typography variant='h3'>
                    速率限制{' '}
                    <TooltipWithParser
                        style={{ marginLeft: 10 }}
                        title={
                            '请参阅<a target="_blank" href="https://docs.flowiseai.com/configuration/rate-limit">速率限制设置指南</a>，在托管环境中正确配置速率限制。'
                        }
                    />
                </Typography>
            )}
            <SwitchInput label='启用速率限制' onChange={handleChange} value={rateLimitStatus} />
            {rateLimitStatus && (
                <Stack direction='column' spacing={2} sx={{ width: '100%' }}>
                    {textField(limitMax, 'limitMax', '每个周期的消息上限', 'number', '5')}
                    {textField(limitDuration, 'limitDuration', '周期时长（秒）', 'number', '60')}
                    {textField(limitMsg, 'limitMsg', '达到上限时的提示消息', 'string', '您已达到使用上限')}
                </Stack>
            )}
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', width: '100%', mt: 2 }}>
                <StyledButton disabled={checkDisabled()} variant='contained' onClick={() => onSave()} sx={{ minWidth: 100 }}>
                    保存
                </StyledButton>
            </Box>
        </Stack>
    )
}

RateLimit.propTypes = {
    isSessionMemory: PropTypes.bool,
    dialogProps: PropTypes.object,
    hideTitle: PropTypes.bool
}

export default RateLimit
