import { useDispatch } from 'react-redux'
import { useState, useEffect } from 'react'
import PropTypes from 'prop-types'
import { enqueueSnackbar as enqueueSnackbarAction, closeSnackbar as closeSnackbarAction, SET_CHATFLOW } from '@/store/actions'

// material-ui
import { Typography, Box, Button, FormControl, ListItem, ListItemAvatar, ListItemText, MenuItem, Select } from '@mui/material'
import { IconX } from '@tabler/icons-react'
import { useTheme } from '@mui/material/styles'

// Project import
import CredentialInputHandler from '@/views/canvas/CredentialInputHandler'
import { TooltipWithParser } from '@/ui-component/tooltip/TooltipWithParser'
import { SwitchInput } from '@/ui-component/switch/Switch'
import { Input } from '@/ui-component/input/Input'
import { StyledButton } from '@/ui-component/button/StyledButton'
import { Dropdown } from '@/ui-component/dropdown/Dropdown'
import openAISVG from '@/assets/images/openai.svg'
import assemblyAIPng from '@/assets/images/assemblyai.png'
import localAiPng from '@/assets/images/localai.png'
import azureSvg from '@/assets/images/azure_openai.svg'
import groqPng from '@/assets/images/groq.png'

// store
import useNotifier from '@/utils/useNotifier'
import { getErrorMessage } from '@/utils/getErrorMessage'

// API
import chatflowsApi from '@/api/chatflows'

// If implementing a new provider, this must be updated in
// components/src/speechToText.ts as well
const SpeechToTextType = {
    OPENAI_WHISPER: 'openAIWhisper',
    ASSEMBLYAI_TRANSCRIBE: 'assemblyAiTranscribe',
    LOCALAI_STT: 'localAISTT',
    AZURE_COGNITIVE: 'azureCognitive',
    GROQ_WHISPER: 'groqWhisper'
}

// Weird quirk - the key must match the name property value.
const speechToTextProviders = {
    [SpeechToTextType.OPENAI_WHISPER]: {
        label: 'OpenAI Whisper',
        name: SpeechToTextType.OPENAI_WHISPER,
        icon: openAISVG,
        url: 'https://platform.openai.com/docs/guides/speech-to-text',
        inputs: [
            {
                label: '连接凭据',
                name: 'credential',
                type: 'credential',
                credentialNames: ['openAIApi']
            },
            {
                label: '语言',
                name: 'language',
                type: 'string',
                description: '输入音频的语言。使用 <code>ISO-639-1</code> 格式指定语言可提高识别准确率并降低延迟。',
                placeholder: 'en',
                optional: true
            },
            {
                label: '提示词',
                name: 'prompt',
                type: 'string',
                rows: 4,
                description: '用于引导模型风格或延续上一段音频的可选文本。提示词应与音频语言一致。',
                optional: true
            },
            {
                label: '温度',
                name: 'temperature',
                type: 'number',
                step: 0.1,
                description: '采样温度范围为 0 到 1。较高值（如 0.8）会增加输出随机性，较低值（如 0.2）会使输出更集中、稳定。',
                optional: true
            }
        ]
    },
    [SpeechToTextType.ASSEMBLYAI_TRANSCRIBE]: {
        label: 'Assembly AI',
        name: SpeechToTextType.ASSEMBLYAI_TRANSCRIBE,
        icon: assemblyAIPng,
        url: 'https://www.assemblyai.com/',
        inputs: [
            {
                label: '连接凭据',
                name: 'credential',
                type: 'credential',
                credentialNames: ['assemblyAIApi']
            }
        ]
    },
    [SpeechToTextType.LOCALAI_STT]: {
        label: 'LocalAI STT',
        name: SpeechToTextType.LOCALAI_STT,
        icon: localAiPng,
        url: 'https://localai.io/features/audio-to-text/',
        inputs: [
            {
                label: '连接凭据',
                name: 'credential',
                type: 'credential',
                credentialNames: ['localAIApi']
            },
            {
                label: '基础 URL',
                name: 'baseUrl',
                type: 'string',
                description: '本地 AI 服务器的基础 URL'
            },
            {
                label: '语言',
                name: 'language',
                type: 'string',
                description: '输入音频的语言。使用 <code>ISO-639-1</code> 格式指定语言可提高识别准确率并降低延迟。',
                placeholder: 'en',
                optional: true
            },
            {
                label: '模型',
                name: 'model',
                type: 'string',
                description: '要加载的 STT 模型；留空时默认使用 whisper-1。',
                placeholder: 'whisper-1',
                optional: true
            },
            {
                label: '提示词',
                name: 'prompt',
                type: 'string',
                rows: 4,
                description: '用于引导模型风格或延续上一段音频的可选文本。提示词应与音频语言一致。',
                optional: true
            },
            {
                label: '温度',
                name: 'temperature',
                type: 'number',
                step: 0.1,
                description: '采样温度范围为 0 到 1。较高值（如 0.8）会增加输出随机性，较低值（如 0.2）会使输出更集中、稳定。',
                optional: true
            }
        ]
    },
    [SpeechToTextType.AZURE_COGNITIVE]: {
        label: 'Azure Cognitive Services',
        name: SpeechToTextType.AZURE_COGNITIVE,
        icon: azureSvg,
        url: 'https://azure.microsoft.com/en-us/products/cognitive-services/speech-services',
        inputs: [
            {
                label: '连接凭据',
                name: 'credential',
                type: 'credential',
                credentialNames: ['azureCognitiveServices']
            },
            {
                label: '语言',
                name: 'language',
                type: 'string',
                description: '识别语言（例如 <code>en-US</code>、<code>es-ES</code>）',
                placeholder: 'en-US',
                optional: true
            },
            {
                label: '亵渎过滤模式',
                name: 'profanityFilterMode',
                type: 'options',
                description: '设置如何处理转写内容中的不雅用语',
                options: [
                    {
                        label: '无',
                        name: 'None'
                    },
                    {
                        label: '已遮罩',
                        name: 'Masked'
                    },
                    {
                        label: '已移除',
                        name: 'Removed'
                    }
                ],
                default: 'Masked',
                optional: true
            },
            {
                label: '音频声道',
                name: 'channels',
                type: 'string',
                description: '要处理的音频声道列表，使用英文逗号分隔（例如“0,1”）',
                placeholder: '0,1',
                default: '0,1'
            }
        ]
    },
    [SpeechToTextType.GROQ_WHISPER]: {
        label: 'Groq Whisper',
        name: SpeechToTextType.GROQ_WHISPER,
        icon: groqPng,
        url: 'https://console.groq.com/',
        inputs: [
            {
                label: '模型',
                name: 'model',
                type: 'string',
                description: '要加载的 STT 模型；留空时默认使用 <code>whisper-large-v3</code>。',
                placeholder: 'whisper-large-v3',
                optional: true
            },
            {
                label: '连接凭据',
                name: 'credential',
                type: 'credential',
                credentialNames: ['groqApi']
            },
            {
                label: '语言',
                name: 'language',
                type: 'string',
                description: '输入音频的语言。使用 <code>ISO-639-1</code> 格式指定语言可提高识别准确率并降低延迟。',
                placeholder: 'en',
                optional: true
            },
            {
                label: '温度',
                name: 'temperature',
                type: 'number',
                step: 0.1,
                description: '采样温度范围为 0 到 1。较高值（如 0.8）会增加输出随机性，较低值（如 0.2）会使输出更集中、稳定。',
                optional: true
            }
        ]
    }
}

const SpeechToText = ({ dialogProps, onConfirm }) => {
    const dispatch = useDispatch()

    useNotifier()
    const theme = useTheme()

    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))

    const [speechToText, setSpeechToText] = useState({})
    const [selectedProvider, setSelectedProvider] = useState('none')

    const onSave = async () => {
        const speechToText = setValue(true, selectedProvider, 'status')
        try {
            const saveResp = await chatflowsApi.updateChatflow(dialogProps.chatflow.id, {
                speechToText: JSON.stringify(speechToText)
            })
            if (saveResp.data) {
                enqueueSnackbar({
                    message: '语音转文字配置已保存',
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
                message: `保存语音转文字配置失败：${getErrorMessage(error, '未知错误')}`,
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

    const setValue = (value, providerName, inputParamName) => {
        let newVal = {}
        if (!Object.prototype.hasOwnProperty.call(speechToText, providerName)) {
            newVal = { ...speechToText, [providerName]: {} }
        } else {
            newVal = { ...speechToText }
        }

        newVal[providerName][inputParamName] = value
        if (inputParamName === 'status' && value === true) {
            // ensure that the others are turned off
            Object.keys(speechToTextProviders).forEach((key) => {
                const provider = speechToTextProviders[key]
                if (provider.name !== providerName) {
                    newVal[provider.name] = { ...speechToText[provider.name], status: false }
                }
            })
            if (providerName !== 'none' && newVal['none']) {
                newVal['none'].status = false
            }
        }
        setSpeechToText(newVal)
        return newVal
    }

    const handleProviderChange = (event) => {
        setSelectedProvider(event.target.value)
    }

    useEffect(() => {
        if (dialogProps.chatflow && dialogProps.chatflow.speechToText) {
            try {
                const speechToText = JSON.parse(dialogProps.chatflow.speechToText)
                let selectedProvider = 'none'
                Object.keys(speechToTextProviders).forEach((key) => {
                    const providerConfig = speechToText[key]
                    if (providerConfig && providerConfig.status) {
                        selectedProvider = key
                    }
                })
                setSelectedProvider(selectedProvider)
                setSpeechToText(speechToText)
            } catch {
                setSpeechToText({})
                setSelectedProvider('none')
            }
        }

        return () => {
            setSpeechToText({})
            setSelectedProvider('none')
        }
    }, [dialogProps])

    return (
        <>
            <Box fullWidth sx={{ mb: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
                <Typography>提供商</Typography>
                <FormControl fullWidth>
                    <Select
                        size='small'
                        value={selectedProvider}
                        onChange={handleProviderChange}
                        sx={{
                            '& .MuiSvgIcon-root': {
                                color: theme?.customization?.isDarkMode ? '#fff' : 'inherit'
                            }
                        }}
                    >
                        <MenuItem value='none'>无</MenuItem>
                        {Object.values(speechToTextProviders).map((provider) => (
                            <MenuItem key={provider.name} value={provider.name}>
                                {provider.label}
                            </MenuItem>
                        ))}
                    </Select>
                </FormControl>
            </Box>
            {selectedProvider !== 'none' && (
                <>
                    <ListItem sx={{ mt: 3 }} alignItems='center'>
                        <ListItemAvatar>
                            <div
                                style={{
                                    width: 50,
                                    height: 50,
                                    borderRadius: '50%',
                                    backgroundColor: 'white',
                                    flexShrink: 0,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center'
                                }}
                            >
                                <img
                                    style={{
                                        width: '100%',
                                        height: '100%',
                                        padding: 10,
                                        objectFit: 'contain'
                                    }}
                                    alt='语音转文字提供商'
                                    src={speechToTextProviders[selectedProvider].icon}
                                />
                            </div>
                        </ListItemAvatar>
                        <ListItemText
                            sx={{ ml: 1 }}
                            primary={speechToTextProviders[selectedProvider].label}
                            secondary={
                                <a
                                    target='_blank'
                                    rel='noreferrer'
                                    href={speechToTextProviders[selectedProvider].url}
                                    style={{
                                        color: theme?.customization?.isDarkMode ? '#90caf9' : '#1976d2',
                                        textDecoration: 'underline'
                                    }}
                                >
                                    {speechToTextProviders[selectedProvider].url}
                                </a>
                            }
                        />
                    </ListItem>
                    {speechToTextProviders[selectedProvider].inputs.map((inputParam, index) => (
                        <Box key={index} sx={{ p: 2 }}>
                            <div style={{ display: 'flex', flexDirection: 'row' }}>
                                <Typography>
                                    {inputParam.label}
                                    {!inputParam.optional && <span style={{ color: 'red' }}>&nbsp;*</span>}
                                    {inputParam.description && (
                                        <TooltipWithParser style={{ marginLeft: 10 }} title={inputParam.description} />
                                    )}
                                </Typography>
                            </div>
                            {inputParam.type === 'credential' && (
                                <CredentialInputHandler
                                    key={speechToText[selectedProvider]?.credentialId}
                                    data={
                                        speechToText[selectedProvider]?.credentialId
                                            ? { credential: speechToText[selectedProvider].credentialId }
                                            : {}
                                    }
                                    inputParam={inputParam}
                                    onSelect={(newValue) => setValue(newValue, selectedProvider, 'credentialId')}
                                />
                            )}
                            {inputParam.type === 'boolean' && (
                                <SwitchInput
                                    onChange={(newValue) => setValue(newValue, selectedProvider, inputParam.name)}
                                    value={
                                        speechToText[selectedProvider]
                                            ? speechToText[selectedProvider][inputParam.name]
                                            : inputParam.default ?? false
                                    }
                                />
                            )}
                            {(inputParam.type === 'string' || inputParam.type === 'password' || inputParam.type === 'number') && (
                                <Input
                                    inputParam={inputParam}
                                    onChange={(newValue) => setValue(newValue, selectedProvider, inputParam.name)}
                                    value={
                                        speechToText[selectedProvider]
                                            ? speechToText[selectedProvider][inputParam.name]
                                            : inputParam.default ?? ''
                                    }
                                />
                            )}

                            {inputParam.type === 'options' && (
                                <Dropdown
                                    name={inputParam.name}
                                    options={inputParam.options}
                                    onSelect={(newValue) => setValue(newValue, selectedProvider, inputParam.name)}
                                    value={
                                        speechToText[selectedProvider]
                                            ? speechToText[selectedProvider][inputParam.name]
                                            : inputParam.default ?? 'choose an option'
                                    }
                                />
                            )}
                        </Box>
                    ))}
                </>
            )}
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', width: '100%', mt: 2 }}>
                <StyledButton
                    disabled={selectedProvider !== 'none' && !speechToText[selectedProvider]?.credentialId}
                    variant='contained'
                    onClick={onSave}
                    sx={{ minWidth: 100 }}
                >
                    保存
                </StyledButton>
            </Box>
        </>
    )
}

SpeechToText.propTypes = {
    dialogProps: PropTypes.object,
    onConfirm: PropTypes.func
}

export default SpeechToText
