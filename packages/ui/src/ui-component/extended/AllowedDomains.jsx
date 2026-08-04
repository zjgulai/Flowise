import { useDispatch } from 'react-redux'
import { useState, useEffect } from 'react'
import PropTypes from 'prop-types'
import { enqueueSnackbar as enqueueSnackbarAction, closeSnackbar as closeSnackbarAction, SET_CHATFLOW } from '@/store/actions'

// material-ui
import { Button, IconButton, OutlinedInput, Box, InputAdornment, Stack, Typography } from '@mui/material'
import { IconX, IconTrash, IconPlus } from '@tabler/icons-react'

// Project import
import { StyledButton } from '@/ui-component/button/StyledButton'
import { TooltipWithParser } from '@/ui-component/tooltip/TooltipWithParser'

// store
import useNotifier from '@/utils/useNotifier'
import { getErrorMessage } from '@/utils/getErrorMessage'

// API
import chatflowsApi from '@/api/chatflows'

const AllowedDomains = ({ dialogProps, onConfirm, hideTitle = false }) => {
    const dispatch = useDispatch()

    useNotifier()

    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))

    const [inputFields, setInputFields] = useState([''])
    const [errorMessage, setErrorMessage] = useState('')

    const [chatbotConfig, setChatbotConfig] = useState({})

    const addInputField = () => {
        setInputFields([...inputFields, ''])
    }
    const removeInputFields = (index) => {
        const rows = [...inputFields]
        rows.splice(index, 1)
        setInputFields(rows)
    }

    const handleChange = (index, evnt) => {
        const { value } = evnt.target
        const list = [...inputFields]
        list[index] = value
        setInputFields(list)
    }

    const onSave = async () => {
        try {
            let value = {
                allowedOrigins: [...inputFields],
                allowedOriginsError: errorMessage
            }
            chatbotConfig.allowedOrigins = value.allowedOrigins
            chatbotConfig.allowedOriginsError = value.allowedOriginsError

            const saveResp = await chatflowsApi.updateChatflow(dialogProps.chatflow.id, {
                chatbotConfig: JSON.stringify(chatbotConfig)
            })
            if (saveResp.data) {
                enqueueSnackbar({
                    message: '允许来源已保存',
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
                onConfirm?.()
            }
        } catch (error) {
            enqueueSnackbar({
                message: `保存允许来源失败：${getErrorMessage(error, '未知错误')}`,
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

    useEffect(() => {
        if (dialogProps.chatflow && dialogProps.chatflow.chatbotConfig) {
            try {
                let chatbotConfig = JSON.parse(dialogProps.chatflow.chatbotConfig)
                setChatbotConfig(chatbotConfig || {})
                if (chatbotConfig.allowedOrigins) {
                    let inputFields = [...chatbotConfig.allowedOrigins]
                    setInputFields(inputFields)
                } else {
                    setInputFields([''])
                }
                if (chatbotConfig.allowedOriginsError) {
                    setErrorMessage(chatbotConfig.allowedOriginsError)
                } else {
                    setErrorMessage('')
                }
            } catch (e) {
                setInputFields([''])
                setErrorMessage('')
            }
        }

        return () => {}
    }, [dialogProps])

    return (
        <Stack direction='column' spacing={2} sx={{ width: '100%' }}>
            {!hideTitle && (
                <Typography variant='h3'>
                    允许的域名
                    <TooltipWithParser style={{ mb: 1, mt: 2, marginLeft: 10 }} title={'此聊天机器人仅允许从以下域名访问。'} />
                </Typography>
            )}
            <Stack direction='column' spacing={2} sx={{ width: '100%' }}>
                <Stack direction='column' spacing={2}>
                    <Typography>域名</Typography>
                    {inputFields.map((origin, index) => {
                        return (
                            <div key={index} style={{ display: 'flex', width: '100%' }}>
                                <Box sx={{ width: '100%', mb: 1 }}>
                                    <OutlinedInput
                                        sx={{ width: '100%' }}
                                        key={index}
                                        type='text'
                                        onChange={(e) => handleChange(index, e)}
                                        size='small'
                                        value={origin}
                                        name='origin'
                                        placeholder='https://example.com'
                                        endAdornment={
                                            <InputAdornment position='end' sx={{ padding: '2px' }}>
                                                {inputFields.length > 1 && (
                                                    <IconButton
                                                        sx={{ height: 30, width: 30 }}
                                                        size='small'
                                                        color='error'
                                                        disabled={inputFields.length === 1}
                                                        onClick={() => removeInputFields(index)}
                                                        edge='end'
                                                        aria-label={`删除第 ${index + 1} 个域名`}
                                                    >
                                                        <IconTrash />
                                                    </IconButton>
                                                )}
                                            </InputAdornment>
                                        }
                                    />
                                </Box>
                                <Box sx={{ width: '5%', mb: 1 }}>
                                    {index === inputFields.length - 1 && (
                                        <IconButton color='primary' onClick={addInputField} aria-label='添加域名'>
                                            <IconPlus />
                                        </IconButton>
                                    )}
                                </Box>
                            </div>
                        )
                    })}
                </Stack>
                <Stack direction='column' spacing={1}>
                    <Typography>
                        错误消息
                        <TooltipWithParser style={{ mb: 1, mt: 2, marginLeft: 10 }} title={'访问域名未经授权时显示的自定义错误消息'} />
                    </Typography>
                    <OutlinedInput
                        sx={{ width: '100%' }}
                        type='text'
                        size='small'
                        fullWidth
                        placeholder='未授权域名！'
                        value={errorMessage}
                        onChange={(e) => {
                            setErrorMessage(e.target.value)
                        }}
                    />
                </Stack>
            </Stack>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', width: '100%', mt: 2 }}>
                <StyledButton variant='contained' onClick={onSave} sx={{ minWidth: 100 }}>
                    保存
                </StyledButton>
            </Box>
        </Stack>
    )
}

AllowedDomains.propTypes = {
    dialogProps: PropTypes.object,
    onConfirm: PropTypes.func,
    hideTitle: PropTypes.bool
}

export default AllowedDomains
