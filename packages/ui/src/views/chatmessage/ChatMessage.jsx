import { useState, useRef, useEffect, useCallback, Fragment, useContext, memo } from 'react'
import { useSelector, useDispatch } from 'react-redux'
import PropTypes from 'prop-types'
import { cloneDeep } from 'lodash'
import axios from 'axios'
import { v4 as uuidv4 } from 'uuid'
import { EventStreamContentType, fetchEventSource } from '@microsoft/fetch-event-source'

import {
    Box,
    Button,
    Card,
    CardMedia,
    Chip,
    CircularProgress,
    Divider,
    IconButton,
    InputAdornment,
    OutlinedInput,
    Typography,
    Stack,
    Dialog,
    DialogTitle,
    DialogContent,
    DialogActions,
    TextField
} from '@mui/material'
import { darken, useTheme } from '@mui/material/styles'
import {
    IconCircleDot,
    IconDownload,
    IconSend,
    IconMicrophone,
    IconPhotoPlus,
    IconTrash,
    IconX,
    IconTool,
    IconSquareFilled,
    IconCheck,
    IconPaperclip,
    IconSparkles,
    IconVolume
} from '@tabler/icons-react'
import robotPNG from '@/assets/images/robot.png'
import userPNG from '@/assets/images/account.png'
import multiagent_supervisorPNG from '@/assets/images/multiagent_supervisor.png'
import multiagent_workerPNG from '@/assets/images/multiagent_worker.png'
import audioUploadSVG from '@/assets/images/wave-sound.jpg'

// project import
import NodeInputHandler from '@/views/canvas/NodeInputHandler'
import { MemoizedReactMarkdown } from '@/ui-component/markdown/MemoizedReactMarkdown'
import { SafeHTML } from '@/ui-component/safe/SafeHTML'
import SourceDocDialog from '@/ui-component/dialog/SourceDocDialog'
import ChatFeedbackContentDialog from '@/ui-component/dialog/ChatFeedbackContentDialog'
import StarterPromptsCard from '@/ui-component/cards/StarterPromptsCard'
import AgentReasoningCard from './AgentReasoningCard'
import AgentExecutedDataCard from './AgentExecutedDataCard'
import ThinkingCard from './ThinkingCard'
import { ImageButton, ImageSrc, ImageBackdrop, ImageMarked } from '@/ui-component/button/ImageButton'
import CopyToClipboardButton from '@/ui-component/button/CopyToClipboardButton'
import ThumbsUpButton from '@/ui-component/button/ThumbsUpButton'
import ThumbsDownButton from '@/ui-component/button/ThumbsDownButton'
import { cancelAudioRecording, startAudioRecording, stopAudioRecording } from './audio-recording'
import './audio-recording.css'
import './ChatMessage.css'

// api
import chatmessageApi from '@/api/chatmessage'
import chatflowsApi from '@/api/chatflows'
import predictionApi from '@/api/prediction'
import vectorstoreApi from '@/api/vectorstore'
import attachmentsApi from '@/api/attachments'
import chatmessagefeedbackApi from '@/api/chatmessagefeedback'
import leadsApi from '@/api/lead'
import executionsApi from '@/api/executions'
import ttsApi from '@/api/tts'

// Hooks
import useApi from '@/hooks/useApi'
import { flowContext } from '@/store/context/ReactFlowContext'

// Const
import { baseURL, maxScroll } from '@/store/constant'
import { enqueueSnackbar as enqueueSnackbarAction, closeSnackbar as closeSnackbarAction } from '@/store/actions'

// Utils
import { isValidURL, removeDuplicateURL, setLocalStorageChatflow, getLocalStorageChatflow } from '@/utils/genericHelper'
import { getErrorMessage } from '@/utils/getErrorMessage'
import { createChatStreamGuard } from '@/utils/createChatStreamGuard'
import { createTTSStreamResources, disposeTTSStreamResources, ownsTTSStream } from '@/utils/ttsStreamingLifecycle'
import useNotifier from '@/utils/useNotifier'
import FollowUpPromptsCard from '@/ui-component/cards/FollowUpPromptsCard'

// History
import { ChatInputHistory } from './ChatInputHistory'

const messageImageStyle = {
    width: '128px',
    height: '128px',
    objectFit: 'cover'
}

// Extension must match recording MIME so server validation and STT work (audio/webm, audio/mp4, audio/ogg).
const getRecordingExtensionForMime = (mime) => {
    const mimeToExt = {
        'audio/webm': 'webm',
        'audio/mp4': 'm4a',
        'audio/x-m4a': 'm4a',
        'audio/ogg': 'ogg',
        'audio/oga': 'ogg',
        'audio/wav': 'wav',
        'audio/wave': 'wav',
        'audio/x-wav': 'wav'
    }
    const extension = mimeToExt[mime]
    if (extension) {
        return extension
    }
    return 'webm'
}

const CardWithDeleteOverlay = ({ item, disabled, customization, onDelete }) => {
    const [isHovered, setIsHovered] = useState(false)
    const defaultBackgroundColor = customization.isDarkMode ? 'rgba(0, 0, 0, 0.3)' : 'transparent'

    return (
        <div
            onMouseEnter={() => setIsHovered(true)}
            onMouseLeave={() => setIsHovered(false)}
            style={{ position: 'relative', display: 'inline-block' }}
        >
            <Card
                sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    height: '48px',
                    width: 'max-content',
                    p: 2,
                    mr: 1,
                    flex: '0 0 auto',
                    transition: 'opacity 0.3s',
                    opacity: isHovered ? 1 : 1,
                    backgroundColor: isHovered ? 'rgba(0, 0, 0, 0.3)' : defaultBackgroundColor
                }}
                variant='outlined'
            >
                <IconPaperclip size={20} style={{ transition: 'filter 0.3s', filter: isHovered ? 'blur(2px)' : 'none' }} />
                <span
                    style={{
                        marginLeft: '5px',
                        color: customization.isDarkMode ? 'white' : 'inherit',
                        transition: 'filter 0.3s',
                        filter: isHovered ? 'blur(2px)' : 'none'
                    }}
                >
                    {item.name}
                </span>
            </Card>
            {isHovered && !disabled && (
                <Button
                    disabled={disabled}
                    onClick={() => onDelete(item)}
                    startIcon={<IconTrash color='white' size={22} />}
                    title='移除附件'
                    sx={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        backgroundColor: 'transparent',
                        '&:hover': {
                            backgroundColor: 'transparent'
                        }
                    }}
                ></Button>
            )}
        </div>
    )
}

CardWithDeleteOverlay.propTypes = {
    item: PropTypes.object,
    customization: PropTypes.object,
    disabled: PropTypes.bool,
    onDelete: PropTypes.func
}

const ChatMessage = ({ open, chatflowid, isAgentCanvas, isDialog, previews, setPreviews }) => {
    const theme = useTheme()
    const customization = useSelector((state) => state.customization)

    const ps = useRef()

    const dispatch = useDispatch()
    const { onAgentflowNodeStatusUpdate, clearAgentflowNodeStatus } = useContext(flowContext)

    useNotifier()
    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))

    const [userInput, setUserInput] = useState('')
    const [loading, setLoading] = useState(false)
    const [messages, setMessages] = useState([
        {
            message: '你好！有什么可以帮你？',
            type: 'apiMessage'
        }
    ])
    const [isChatFlowAvailableToStream, setIsChatFlowAvailableToStream] = useState(false)
    const [isChatFlowAvailableForSpeech, setIsChatFlowAvailableForSpeech] = useState(false)
    const [sourceDialogOpen, setSourceDialogOpen] = useState(false)
    const [sourceDialogProps, setSourceDialogProps] = useState({})
    const [chatId, setChatId] = useState(uuidv4())
    const [isMessageStopping, setIsMessageStopping] = useState(false)
    const [uploadedFiles, setUploadedFiles] = useState([])
    const [imageUploadAllowedTypes, setImageUploadAllowedTypes] = useState('')
    const [fileUploadAllowedTypes, setFileUploadAllowedTypes] = useState('')
    const [inputHistory] = useState(new ChatInputHistory(10))

    const inputRef = useRef(null)
    const getChatmessageApi = useApi(chatmessageApi.getInternalChatmessageFromChatflow)
    const getAllExecutionsApi = useApi(executionsApi.getAllExecutions)
    const getIsChatflowStreamingApi = useApi(chatflowsApi.getIsChatflowStreaming)
    const getAllowChatFlowUploads = useApi(chatflowsApi.getAllowChatflowUploads)
    const getChatflowConfig = useApi(chatflowsApi.getSpecificChatflow)

    const [starterPrompts, setStarterPrompts] = useState([])

    // full file upload
    const [fullFileUpload, setFullFileUpload] = useState(false)
    const [fullFileUploadAllowedTypes, setFullFileUploadAllowedTypes] = useState('*')

    // feedback
    const [chatFeedbackStatus, setChatFeedbackStatus] = useState(false)
    const [feedbackId, setFeedbackId] = useState('')
    const [showFeedbackContentDialog, setShowFeedbackContentDialog] = useState(false)

    // leads
    const [leadsConfig, setLeadsConfig] = useState(null)
    const [leadName, setLeadName] = useState('')
    const [leadEmail, setLeadEmail] = useState('')
    const [leadPhone, setLeadPhone] = useState('')
    const [isLeadSaving, setIsLeadSaving] = useState(false)
    const [isLeadSaved, setIsLeadSaved] = useState(false)

    // follow-up prompts
    const [followUpPromptsStatus, setFollowUpPromptsStatus] = useState(false)
    const [followUpPrompts, setFollowUpPrompts] = useState([])

    // thinking/reasoning state
    const [isThinking, setIsThinking] = useState(false)

    // drag & drop and file input
    const imgUploadRef = useRef(null)
    const fileUploadRef = useRef(null)
    const [isChatFlowAvailableForImageUploads, setIsChatFlowAvailableForImageUploads] = useState(false)
    const [isChatFlowAvailableForFileUploads, setIsChatFlowAvailableForFileUploads] = useState(false)
    const [isChatFlowAvailableForRAGFileUploads, setIsChatFlowAvailableForRAGFileUploads] = useState(false)
    const [isDragActive, setIsDragActive] = useState(false)

    // recording
    const [isRecording, setIsRecording] = useState(false)
    const [recordingNotSupported, setRecordingNotSupported] = useState(false)
    const [isLoadingRecording, setIsLoadingRecording] = useState(false)

    const [openFeedbackDialog, setOpenFeedbackDialog] = useState(false)
    const [feedback, setFeedback] = useState('')
    const [pendingActionData, setPendingActionData] = useState(null)
    const [feedbackType, setFeedbackType] = useState('')

    // start input type
    const [startInputType, setStartInputType] = useState('')
    const [formTitle, setFormTitle] = useState('')
    const [formDescription, setFormDescription] = useState('')
    const [formInputsData, setFormInputsData] = useState({})
    const [formInputParams, setFormInputParams] = useState([])

    const [isConfigLoading, setIsConfigLoading] = useState(true)

    // TTS state
    const [isTTSLoading, setIsTTSLoading] = useState({})
    const [isTTSPlaying, setIsTTSPlaying] = useState({})
    const [ttsAudio, setTtsAudio] = useState({})
    const [isTTSEnabled, setIsTTSEnabled] = useState(false)

    // Ref to prevent auto-scroll during TTS actions (using ref to avoid re-renders)
    const isTTSActionRef = useRef(false)
    const ttsTimeoutRef = useRef(null)
    const ttsInitializationTimeoutRef = useRef(null)
    const ttsStreamSessionRef = useRef(0)
    const ttsStreamingResourcesRef = useRef(createTTSStreamResources())
    const chatStreamAbortControllerRef = useRef(null)

    const isFileAllowedForUpload = (file) => {
        const constraints = getAllowChatFlowUploads.data
        /**
         * {isImageUploadAllowed: boolean, imgUploadSizeAndTypes: Array<{ fileTypes: string[], maxUploadSize: number }>}
         */
        let acceptFile = false

        // Early return if constraints are not available yet
        if (!constraints) {
            return false
        }

        if (constraints.isImageUploadAllowed) {
            const fileType = file.type
            const sizeInMB = file.size / 1024 / 1024
            if (constraints.imgUploadSizeAndTypes && Array.isArray(constraints.imgUploadSizeAndTypes)) {
                constraints.imgUploadSizeAndTypes.forEach((allowed) => {
                    if (allowed.fileTypes && allowed.fileTypes.includes(fileType) && sizeInMB <= allowed.maxUploadSize) {
                        acceptFile = true
                    }
                })
            }
        }

        if (fullFileUpload) {
            return true
        } else if (constraints.isRAGFileUploadAllowed) {
            const fileExt = file.name.split('.').pop()
            if (fileExt && constraints.fileUploadSizeAndTypes && Array.isArray(constraints.fileUploadSizeAndTypes)) {
                constraints.fileUploadSizeAndTypes.forEach((allowed) => {
                    if (allowed.fileTypes && allowed.fileTypes.length === 1 && allowed.fileTypes[0] === '*') {
                        acceptFile = true
                    } else if (allowed.fileTypes && allowed.fileTypes.includes(`.${fileExt}`)) {
                        acceptFile = true
                    }
                })
            }
        }
        if (!acceptFile) {
            alert('无法上传此文件，请检查允许的文件类型和大小上限。')
        }
        return acceptFile
    }

    const handleDrop = async (e) => {
        if (!isChatFlowAvailableForImageUploads && !isChatFlowAvailableForFileUploads) {
            return
        }
        e.preventDefault()
        setIsDragActive(false)
        let files = []
        let uploadedFiles = []

        if (e.dataTransfer.files.length > 0) {
            for (const file of e.dataTransfer.files) {
                if (isFileAllowedForUpload(file) === false) {
                    return
                }
                const reader = new FileReader()
                const { name } = file
                // Only add files
                if (!file.type || !imageUploadAllowedTypes.includes(file.type)) {
                    uploadedFiles.push({ file, type: fullFileUpload ? 'file:full' : 'file:rag' })
                }
                files.push(
                    new Promise((resolve) => {
                        reader.onload = (evt) => {
                            if (!evt?.target?.result) {
                                return
                            }
                            const { result } = evt.target
                            let previewUrl
                            if (file.type.startsWith('audio/')) {
                                previewUrl = audioUploadSVG
                            } else {
                                previewUrl = URL.createObjectURL(file)
                            }
                            resolve({
                                data: result,
                                preview: previewUrl,
                                type: 'file',
                                name: name,
                                mime: file.type
                            })
                        }
                        reader.readAsDataURL(file)
                    })
                )
            }

            const newFiles = await Promise.all(files)
            setUploadedFiles(uploadedFiles)
            setPreviews((prevPreviews) => [...prevPreviews, ...newFiles])
        }

        if (e.dataTransfer.items) {
            //TODO set files
            for (const item of e.dataTransfer.items) {
                if (item.kind === 'string' && item.type.match('^text/uri-list')) {
                    item.getAsString((s) => {
                        let upload = {
                            data: s,
                            preview: s,
                            type: 'url',
                            name: s ? s.substring(s.lastIndexOf('/') + 1) : ''
                        }
                        setPreviews((prevPreviews) => [...prevPreviews, upload])
                    })
                } else if (item.kind === 'string' && item.type.match('^text/html')) {
                    item.getAsString((s) => {
                        if (s.indexOf('href') === -1) return
                        //extract href
                        let start = s ? s.substring(s.indexOf('href') + 6) : ''
                        let hrefStr = start.substring(0, start.indexOf('"'))

                        let upload = {
                            data: hrefStr,
                            preview: hrefStr,
                            type: 'url',
                            name: hrefStr ? hrefStr.substring(hrefStr.lastIndexOf('/') + 1) : ''
                        }
                        setPreviews((prevPreviews) => [...prevPreviews, upload])
                    })
                }
            }
        }
    }

    const handleFileChange = async (event) => {
        const fileObj = event.target.files && event.target.files[0]
        if (!fileObj) {
            return
        }
        let files = []
        let uploadedFiles = []
        for (const file of event.target.files) {
            if (isFileAllowedForUpload(file) === false) {
                return
            }
            // Only add files
            if (!file.type || !imageUploadAllowedTypes.includes(file.type)) {
                uploadedFiles.push({ file, type: fullFileUpload ? 'file:full' : 'file:rag' })
            }
            const reader = new FileReader()
            const { name } = file
            files.push(
                new Promise((resolve) => {
                    reader.onload = (evt) => {
                        if (!evt?.target?.result) {
                            return
                        }
                        const { result } = evt.target
                        resolve({
                            data: result,
                            preview: URL.createObjectURL(file),
                            type: 'file',
                            name: name,
                            mime: file.type
                        })
                    }
                    reader.readAsDataURL(file)
                })
            )
        }

        const newFiles = await Promise.all(files)
        setUploadedFiles(uploadedFiles)
        setPreviews((prevPreviews) => [...prevPreviews, ...newFiles])
        // 👇️ reset file input
        event.target.value = null
    }

    const addRecordingToPreviews = (blob) => {
        let mimeType = ''
        const pos = blob.type.indexOf(';')
        if (pos === -1) {
            mimeType = blob.type
        } else {
            mimeType = blob.type ? blob.type.substring(0, pos) : ''
        }
        const ext = getRecordingExtensionForMime(mimeType)
        // read blob and add to previews
        const reader = new FileReader()
        reader.readAsDataURL(blob)
        reader.onloadend = () => {
            const base64data = reader.result
            const upload = {
                data: base64data,
                preview: audioUploadSVG,
                type: 'audio',
                name: `audio_${Date.now()}.${ext}`,
                mime: mimeType
            }
            setPreviews((prevPreviews) => [...prevPreviews, upload])
        }
    }

    const handleDrag = (e) => {
        if (isChatFlowAvailableForImageUploads || isChatFlowAvailableForFileUploads) {
            e.preventDefault()
            e.stopPropagation()
            if (e.type === 'dragenter' || e.type === 'dragover') {
                setIsDragActive(true)
            } else if (e.type === 'dragleave') {
                setIsDragActive(false)
            }
        }
    }

    const handleAbort = async () => {
        setIsMessageStopping(true)
        const ttsAbortRequest = handleTTSAbortAll()
        chatStreamAbortControllerRef.current?.abort()
        stopAllTTS()
        cleanupCalledTools()
        finalizeThinking()
        abortMessage()
        closeResponse()

        const [, stopMessageResult] = await Promise.allSettled([ttsAbortRequest, chatmessageApi.abortMessage(chatflowid, chatId)])
        if (stopMessageResult.status === 'rejected') {
            enqueueSnackbar({
                message: '已停止本地生成，但服务端停止请求失败',
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

    const handleDeletePreview = (itemToDelete) => {
        if (itemToDelete.type === 'file') {
            URL.revokeObjectURL(itemToDelete.preview) // Clean up for file
        }
        setPreviews(previews.filter((item) => item !== itemToDelete))
    }

    const handleFileUploadClick = () => {
        // 👇️ open file input box on click of another element
        fileUploadRef.current.click()
    }

    const handleImageUploadClick = () => {
        // 👇️ open file input box on click of another element
        imgUploadRef.current.click()
    }

    const clearPreviews = () => {
        // Revoke the data uris to avoid memory leaks
        previews.forEach((file) => URL.revokeObjectURL(file.preview))
        setPreviews([])
    }

    const onMicrophonePressed = () => {
        setIsRecording(true)
        startAudioRecording(setIsRecording, setRecordingNotSupported)
    }

    const onRecordingCancelled = () => {
        if (!recordingNotSupported) cancelAudioRecording()
        setIsRecording(false)
        setRecordingNotSupported(false)
    }

    const onRecordingStopped = async () => {
        setIsLoadingRecording(true)
        stopAudioRecording(addRecordingToPreviews)
    }

    const onSourceDialogClick = (data, title) => {
        setSourceDialogProps({ data, title })
        setSourceDialogOpen(true)
    }

    const onURLClick = (data) => {
        window.open(data, '_blank')
    }

    const scrollToBottom = () => {
        if (ps.current) {
            ps.current.scrollTo({ top: maxScroll })
        }
    }

    // Helper function to manage TTS action flag
    const setTTSAction = (isActive) => {
        isTTSActionRef.current = isActive
        if (ttsTimeoutRef.current) {
            clearTimeout(ttsTimeoutRef.current)
            ttsTimeoutRef.current = null
        }
        if (isActive) {
            // Reset the flag after a longer delay to ensure all state changes are complete
            ttsTimeoutRef.current = setTimeout(() => {
                isTTSActionRef.current = false
                ttsTimeoutRef.current = null
            }, 300)
        }
    }

    const onChange = useCallback((e) => setUserInput(e.target.value), [setUserInput])

    const updateLastMessage = (text) => {
        setMessages((prevMessages) => {
            let allMessages = [...cloneDeep(prevMessages)]
            if (allMessages[allMessages.length - 1].type === 'userMessage') return allMessages
            allMessages[allMessages.length - 1].message += text
            allMessages[allMessages.length - 1].feedback = null
            return allMessages
        })
    }

    const updateErrorMessage = (errorMessage) => {
        const safeErrorMessage = getErrorMessage({ response: { data: errorMessage } }, '生成回复失败，请稍后重试')
        setMessages((prevMessages) => {
            let allMessages = [...cloneDeep(prevMessages)]
            allMessages.push({ message: safeErrorMessage, type: 'apiMessage' })
            return allMessages
        })
    }

    const updateLastMessageSourceDocuments = (sourceDocuments) => {
        setMessages((prevMessages) => {
            let allMessages = [...cloneDeep(prevMessages)]
            if (allMessages[allMessages.length - 1].type === 'userMessage') return allMessages
            allMessages[allMessages.length - 1].sourceDocuments = sourceDocuments
            return allMessages
        })
    }

    const updateLastMessageAgentReasoning = (agentReasoning) => {
        setMessages((prevMessages) => {
            let allMessages = [...cloneDeep(prevMessages)]
            if (allMessages[allMessages.length - 1].type === 'userMessage') return allMessages
            allMessages[allMessages.length - 1].agentReasoning = agentReasoning
            return allMessages
        })
    }

    const handleThinkingEvent = (data, duration) => {
        if (data && duration === undefined) {
            // Still thinking - append content
            setIsThinking(true)
            setMessages((prevMessages) => {
                let allMessages = [...cloneDeep(prevMessages)]
                if (allMessages[allMessages.length - 1].type === 'userMessage') return allMessages
                const lastMessage = allMessages[allMessages.length - 1]
                lastMessage.thinking = (lastMessage.thinking || '') + data
                lastMessage.isThinking = true
                return allMessages
            })
        } else if (data === '' && duration !== undefined) {
            // Thinking finished - set duration
            setIsThinking(false)
            setMessages((prevMessages) => {
                let allMessages = [...cloneDeep(prevMessages)]
                if (allMessages[allMessages.length - 1].type === 'userMessage') return allMessages
                const lastMessage = allMessages[allMessages.length - 1]
                lastMessage.thinkingDuration = duration
                lastMessage.isThinking = false
                return allMessages
            })
        }
    }

    const finalizeThinking = () => {
        // Clean up thinking state if stream ends unexpectedly
        if (isThinking) {
            setIsThinking(false)
            setMessages((prevMessages) => {
                let allMessages = [...cloneDeep(prevMessages)]
                if (allMessages[allMessages.length - 1].type === 'userMessage') return allMessages
                allMessages[allMessages.length - 1].isThinking = false
                return allMessages
            })
        }
    }

    const updateAgentFlowEvent = (event) => {
        if (event === 'INPROGRESS') {
            setMessages((prevMessages) => [...prevMessages, { message: '', type: 'apiMessage', agentFlowEventStatus: event }])
        } else {
            setMessages((prevMessages) => {
                let allMessages = [...cloneDeep(prevMessages)]
                if (allMessages[allMessages.length - 1].type === 'userMessage') return allMessages
                allMessages[allMessages.length - 1].agentFlowEventStatus = event
                return allMessages
            })
        }
    }

    const updateAgentFlowExecutedData = (agentFlowExecutedData) => {
        setMessages((prevMessages) => {
            let allMessages = [...cloneDeep(prevMessages)]
            if (allMessages[allMessages.length - 1].type === 'userMessage') return allMessages
            allMessages[allMessages.length - 1].agentFlowExecutedData = agentFlowExecutedData
            return allMessages
        })
    }

    const updateLastMessageAction = (action) => {
        setMessages((prevMessages) => {
            let allMessages = [...cloneDeep(prevMessages)]
            if (allMessages[allMessages.length - 1].type === 'userMessage') return allMessages
            allMessages[allMessages.length - 1].action = action
            return allMessages
        })
    }

    const updateLastMessageArtifacts = (artifacts) => {
        artifacts.forEach((artifact) => {
            if (artifact.type === 'png' || artifact.type === 'jpeg') {
                artifact.data = `${baseURL}/api/v1/get-upload-file?chatflowId=${chatflowid}&chatId=${chatId}&fileName=${artifact.data.replace(
                    'FILE-STORAGE::',
                    ''
                )}`
            }
        })
        setMessages((prevMessages) => {
            let allMessages = [...cloneDeep(prevMessages)]
            if (allMessages[allMessages.length - 1].type === 'userMessage') return allMessages
            allMessages[allMessages.length - 1].artifacts = artifacts
            return allMessages
        })
    }

    const updateLastMessageNextAgent = (nextAgent) => {
        setMessages((prevMessages) => {
            let allMessages = [...cloneDeep(prevMessages)]
            if (allMessages[allMessages.length - 1].type === 'userMessage') return allMessages
            const lastAgentReasoning = allMessages[allMessages.length - 1].agentReasoning
            if (lastAgentReasoning && lastAgentReasoning.length > 0) {
                lastAgentReasoning.push({ nextAgent })
            }
            allMessages[allMessages.length - 1].agentReasoning = lastAgentReasoning
            return allMessages
        })
    }

    const updateLastMessageNextAgentFlow = (nextAgentFlow) => {
        onAgentflowNodeStatusUpdate(nextAgentFlow)
    }

    const updateLastMessageUsedTools = (usedTools) => {
        setMessages((prevMessages) => {
            let allMessages = [...cloneDeep(prevMessages)]
            if (allMessages[allMessages.length - 1].type === 'userMessage') return allMessages

            // When usedTools are received, check if there are matching calledTools to replace
            const lastMessage = allMessages[allMessages.length - 1]
            if (lastMessage.calledTools && lastMessage.calledTools.length > 0) {
                // Replace calledTools with usedTools for matching tool names
                const updatedCalledTools = lastMessage.calledTools.map((calledTool) => {
                    const matchingUsedTool = usedTools.find((usedTool) => usedTool.tool === calledTool.tool)
                    return matchingUsedTool || calledTool
                })

                // Remove calledTools that have been replaced by usedTools
                const remainingCalledTools = updatedCalledTools.filter(
                    (calledTool) => !usedTools.some((usedTool) => usedTool.tool === calledTool.tool)
                )

                allMessages[allMessages.length - 1].calledTools = remainingCalledTools.length > 0 ? remainingCalledTools : undefined
            }

            allMessages[allMessages.length - 1].usedTools = usedTools
            return allMessages
        })
    }

    const updateLastMessageCalledTools = (calledTools) => {
        setMessages((prevMessages) => {
            let allMessages = [...cloneDeep(prevMessages)]
            if (allMessages[allMessages.length - 1].type === 'userMessage') return allMessages
            allMessages[allMessages.length - 1].calledTools = calledTools
            return allMessages
        })
    }

    const cleanupCalledTools = () => {
        setMessages((prevMessages) => {
            let allMessages = [...cloneDeep(prevMessages)]
            if (allMessages[allMessages.length - 1].type === 'userMessage') return allMessages

            // Remove any remaining calledTools when the stream ends
            const lastMessage = allMessages[allMessages.length - 1]
            if (lastMessage && lastMessage.calledTools && lastMessage.calledTools.length > 0) {
                // Only remove if there are still calledTools and no matching usedTools
                const hasUsedTools = lastMessage.usedTools && lastMessage.usedTools.length > 0
                if (!hasUsedTools) {
                    allMessages[allMessages.length - 1].calledTools = undefined
                }
            }

            return allMessages
        })
    }

    const updateLastMessageFileAnnotations = (fileAnnotations) => {
        setMessages((prevMessages) => {
            let allMessages = [...cloneDeep(prevMessages)]
            if (allMessages[allMessages.length - 1].type === 'userMessage') return allMessages
            allMessages[allMessages.length - 1].fileAnnotations = fileAnnotations
            return allMessages
        })
    }

    const abortMessage = () => {
        setIsMessageStopping(false)
        setMessages((prevMessages) => {
            let allMessages = [...cloneDeep(prevMessages)]
            if (allMessages[allMessages.length - 1].type === 'userMessage') return allMessages
            const lastAgentReasoning = allMessages[allMessages.length - 1].agentReasoning
            if (lastAgentReasoning && lastAgentReasoning.length > 0) {
                allMessages[allMessages.length - 1].agentReasoning = lastAgentReasoning.filter((reasoning) => !reasoning.nextAgent)
            }
            allMessages[allMessages.length - 1].calledTools = undefined
            return allMessages
        })
        setTimeout(() => {
            inputRef.current?.focus()
        }, 100)
        enqueueSnackbar({
            message: '已停止生成消息',
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
    }

    const handleError = (message = '出现错误，请稍后重试。') => {
        message = message.replace(`Unable to parse JSON response from chat agent.\n\n`, '')
        setMessages((prevMessages) => [...prevMessages, { message, type: 'apiMessage' }])
        setLoading(false)
        setUserInput('')
        setUploadedFiles([])
        setTimeout(() => {
            inputRef.current?.focus()
        }, 100)
    }

    const handlePromptClick = async (promptStarterInput) => {
        setUserInput(promptStarterInput)
        handleSubmit(undefined, promptStarterInput)
    }

    const handleFollowUpPromptClick = async (promptStarterInput) => {
        setUserInput(promptStarterInput)
        setFollowUpPrompts([])
        handleSubmit(undefined, promptStarterInput)
    }

    const onSubmitResponse = (actionData, feedback = '', type = '') => {
        let fbType = feedbackType
        if (type) {
            fbType = type
        }
        const question = feedback ? feedback : fbType.charAt(0).toUpperCase() + fbType.slice(1)
        handleSubmit(undefined, question, undefined, {
            type: fbType,
            startNodeId: actionData?.nodeId,
            feedback
        })
    }

    const handleSubmitFeedback = () => {
        if (pendingActionData) {
            onSubmitResponse(pendingActionData, feedback)
            setOpenFeedbackDialog(false)
            setFeedback('')
            setPendingActionData(null)
            setFeedbackType('')
        }
    }

    const handleActionClick = async (elem, action) => {
        setUserInput(elem.label)
        setMessages((prevMessages) => {
            let allMessages = [...cloneDeep(prevMessages)]
            if (allMessages[allMessages.length - 1].type === 'userMessage') return allMessages
            allMessages[allMessages.length - 1].action = null
            return allMessages
        })
        if (elem.type.includes('agentflowv2')) {
            const type = elem.type.includes('approve') ? 'proceed' : 'reject'
            setFeedbackType(type)

            if (action.data && action.data.input && action.data.input.humanInputEnableFeedback) {
                setPendingActionData(action.data)
                setOpenFeedbackDialog(true)
            } else {
                onSubmitResponse(action.data, '', type)
            }
        } else {
            handleSubmit(undefined, elem.label, action)
        }
    }

    const updateMetadata = (data, input) => {
        // set message id that is needed for feedback
        if (data.chatMessageId) {
            setMessages((prevMessages) => {
                let allMessages = [...cloneDeep(prevMessages)]
                if (allMessages[allMessages.length - 1].type === 'apiMessage') {
                    allMessages[allMessages.length - 1].id = data.chatMessageId
                }
                return allMessages
            })
        }

        if (data.chatId) {
            setChatId(data.chatId)
        }

        if (input === '' && data.question) {
            // the response contains the question even if it was in an audio format
            // so if input is empty but the response contains the question, update the user message to show the question
            setMessages((prevMessages) => {
                let allMessages = [...cloneDeep(prevMessages)]
                if (allMessages[allMessages.length - 2].type === 'apiMessage') return allMessages
                allMessages[allMessages.length - 2].message = data.question
                return allMessages
            })
        }

        if (data.followUpPrompts) {
            const followUpPrompts = JSON.parse(data.followUpPrompts)
            if (typeof followUpPrompts === 'string') {
                setFollowUpPrompts(JSON.parse(followUpPrompts))
            } else {
                setFollowUpPrompts(followUpPrompts)
            }
        }
    }

    const handleFileUploads = async (uploads) => {
        if (!uploadedFiles.length) return uploads

        if (fullFileUpload) {
            const filesWithFullUploadType = uploadedFiles.filter((file) => file.type === 'file:full')
            if (filesWithFullUploadType.length > 0) {
                const formData = new FormData()
                for (const file of filesWithFullUploadType) {
                    formData.append('files', file.file)
                }
                formData.append('chatId', chatId)

                const response = await attachmentsApi.createAttachment(chatflowid, chatId, formData)
                const data = response.data

                for (const extractedFileData of data) {
                    const content = extractedFileData.content
                    const fileName = extractedFileData.name

                    // find matching name in previews and replace data with content
                    const uploadIndex = uploads.findIndex((upload) => upload.name === fileName)

                    if (uploadIndex !== -1) {
                        uploads[uploadIndex] = {
                            ...uploads[uploadIndex],
                            data: content,
                            name: fileName,
                            type: 'file:full'
                        }
                    }
                }
            }
        } else if (isChatFlowAvailableForRAGFileUploads) {
            const filesWithRAGUploadType = uploadedFiles.filter((file) => file.type === 'file:rag')

            if (filesWithRAGUploadType.length > 0) {
                const formData = new FormData()
                for (const file of filesWithRAGUploadType) {
                    formData.append('files', file.file)
                }
                formData.append('chatId', chatId)

                await vectorstoreApi.upsertVectorStoreWithFormData(chatflowid, formData)

                // delay for vector store to be updated
                const delay = (delayInms) => {
                    return new Promise((resolve) => setTimeout(resolve, delayInms))
                }
                await delay(2500) //TODO: check if embeddings can be retrieved using file name as metadata filter

                uploads = uploads.map((upload) => {
                    return {
                        ...upload,
                        type: 'file:rag'
                    }
                })
            }
        }
        return uploads
    }

    // Handle form submission
    const handleSubmit = async (e, selectedInput, action, humanInput) => {
        if (e) e.preventDefault()

        if (!selectedInput && userInput.trim() === '') {
            const containsFile = previews.filter((item) => !item.mime.startsWith('image') && item.type !== 'audio').length > 0
            if (!previews.length || (previews.length && containsFile)) {
                return
            }
        }

        let input = userInput

        if (typeof selectedInput === 'string') {
            if (selectedInput !== undefined && selectedInput.trim() !== '') input = selectedInput

            if (input.trim()) {
                inputHistory.addToHistory(input)
            }
        } else if (typeof selectedInput === 'object') {
            input = Object.entries(selectedInput)
                .map(([key, value]) => `${key}: ${value}`)
                .join('\n')
        }

        setLoading(true)
        clearAgentflowNodeStatus()

        let uploads = previews.map((item) => {
            return {
                data: item.data,
                type: item.type,
                name: item.name,
                mime: item.mime
            }
        })

        try {
            uploads = await handleFileUploads(uploads)
        } catch (error) {
            handleError(getErrorMessage(error, '文档上传失败，请稍后重试'))
            return
        }

        clearPreviews()
        setMessages((prevMessages) => [...prevMessages, { message: input, type: 'userMessage', fileUploads: uploads }])

        // Send user question to Prediction Internal API
        try {
            const params = {
                question: input,
                chatId
            }
            if (typeof selectedInput === 'object') {
                params.form = selectedInput
                delete params.question
            }
            if (uploads && uploads.length > 0) params.uploads = uploads
            if (leadEmail) params.leadEmail = leadEmail
            if (action) params.action = action
            if (humanInput) params.humanInput = humanInput

            if (isChatFlowAvailableToStream) {
                await fetchResponseFromEventStream(chatflowid, params)
            } else {
                const response = await predictionApi.sendMessageAndGetPrediction(chatflowid, params)
                if (response.data) {
                    const data = response.data

                    updateMetadata(data, input)

                    let text = ''
                    if (data.text) text = data.text
                    else if (data.json) text = '```json\n' + JSON.stringify(data.json, null, 2)
                    else text = JSON.stringify(data, null, 2)

                    setMessages((prevMessages) => [
                        ...prevMessages,
                        {
                            message: text,
                            id: data?.chatMessageId,
                            sourceDocuments: data?.sourceDocuments,
                            usedTools: data?.usedTools,
                            calledTools: data?.calledTools,
                            fileAnnotations: data?.fileAnnotations,
                            agentReasoning: data?.agentReasoning,
                            agentFlowExecutedData: data?.agentFlowExecutedData,
                            action: data?.action,
                            artifacts: data?.artifacts,
                            type: 'apiMessage',
                            feedback: null
                        }
                    ])

                    setLocalStorageChatflow(chatflowid, data.chatId)
                    setLoading(false)
                    setUserInput('')
                    setUploadedFiles([])

                    setTimeout(() => {
                        inputRef.current?.focus()
                        scrollToBottom()
                    }, 100)
                }
            }
        } catch (error) {
            cleanupCalledTools()
            finalizeThinking()
            handleError(getErrorMessage(error, '发送消息失败，请稍后重试'))
            return
        }
    }

    const fetchResponseFromEventStream = async (chatflowid, params) => {
        const chatId = params.chatId
        const input = params.question
        params.streaming = true
        const abortController = new AbortController()
        chatStreamAbortControllerRef.current?.abort()
        chatStreamAbortControllerRef.current = abortController
        const streamGuard = createChatStreamGuard(EventStreamContentType)

        try {
            await fetchEventSource(`${baseURL}/api/v1/internal-prediction/${chatflowid}`, {
                openWhenHidden: true,
                method: 'POST',
                body: JSON.stringify(params),
                signal: abortController.signal,
                headers: {
                    'Content-Type': 'application/json',
                    'x-request-from': 'internal'
                },
                onopen(response) {
                    streamGuard.assertOpenResponse(response)
                },
                onmessage(ev) {
                    const payload = JSON.parse(ev.data)
                    switch (payload.event) {
                        case 'start':
                            setMessages((prevMessages) => [...prevMessages, { message: '', type: 'apiMessage' }])
                            break
                        case 'token':
                            updateLastMessage(payload.data)
                            break
                        case 'sourceDocuments':
                            updateLastMessageSourceDocuments(payload.data)
                            break
                        case 'usedTools':
                            updateLastMessageUsedTools(payload.data)
                            break
                        case 'calledTools':
                            updateLastMessageCalledTools(payload.data)
                            break
                        case 'fileAnnotations':
                            updateLastMessageFileAnnotations(payload.data)
                            break
                        case 'agentReasoning':
                            updateLastMessageAgentReasoning(payload.data)
                            break
                        case 'thinking':
                            handleThinkingEvent(payload.data, payload.duration)
                            break
                        case 'agentFlowEvent':
                            updateAgentFlowEvent(payload.data)
                            break
                        case 'agentFlowExecutedData':
                            updateAgentFlowExecutedData(payload.data)
                            break
                        case 'artifacts':
                            updateLastMessageArtifacts(payload.data)
                            break
                        case 'action':
                            updateLastMessageAction(payload.data)
                            break
                        case 'nextAgent':
                            updateLastMessageNextAgent(payload.data)
                            break
                        case 'nextAgentFlow':
                            updateLastMessageNextAgentFlow(payload.data)
                            break
                        case 'metadata':
                            updateMetadata(payload.data, input)
                            break
                        case 'error':
                            updateErrorMessage(payload.data)
                            break
                        case 'abort':
                            streamGuard.markTerminal()
                            abortMessage(payload.data)
                            closeResponse()
                            abortController.abort()
                            break
                        case 'tts_start':
                            handleTTSStart(payload.data)
                            break
                        case 'tts_data':
                            handleTTSDataChunk(payload.data.audioChunk, payload.data.chatMessageId)
                            break
                        case 'tts_end':
                            handleTTSEnd(payload.data.chatMessageId)
                            break
                        case 'tts_abort':
                            handleTTSAbort(payload.data)
                            break
                        case 'end':
                            streamGuard.markTerminal()
                            cleanupCalledTools()
                            finalizeThinking()
                            setLocalStorageChatflow(chatflowid, chatId)
                            closeResponse()
                            abortController.abort()
                            break
                    }
                },
                onclose() {
                    streamGuard.assertTerminalClose()
                },
                onerror() {
                    streamGuard.fail()
                }
            })
        } finally {
            if (chatStreamAbortControllerRef.current === abortController) {
                chatStreamAbortControllerRef.current = null
            }
        }
    }

    const closeResponse = () => {
        cleanupCalledTools()
        setLoading(false)
        setUserInput('')
        setUploadedFiles([])
        setTimeout(() => {
            inputRef.current?.focus()
            scrollToBottom()
        }, 100)
    }
    // Prevent blank submissions and allow for multiline input
    const handleEnter = (e) => {
        // Check if IME composition is in progress
        const isIMEComposition = e.isComposing || e.keyCode === 229
        if (e.key === 'ArrowUp' && !isIMEComposition) {
            e.preventDefault()
            const previousInput = inputHistory.getPreviousInput(userInput)
            setUserInput(previousInput)
        } else if (e.key === 'ArrowDown' && !isIMEComposition) {
            e.preventDefault()
            const nextInput = inputHistory.getNextInput()
            setUserInput(nextInput)
        } else if (e.key === 'Enter' && userInput && !isIMEComposition) {
            if (!e.shiftKey && userInput) {
                handleSubmit(e)
            }
        } else if (e.key === 'Enter') {
            e.preventDefault()
        }
    }

    const getLabel = (URL, source) => {
        if (URL && typeof URL === 'object') {
            if (URL.pathname && typeof URL.pathname === 'string') {
                if (URL.pathname.substring(0, 15) === '/') {
                    return URL.host || ''
                } else {
                    return `${URL.pathname.substring(0, 15)}...`
                }
            } else if (URL.host) {
                return URL.host
            }
        }

        if (source && source.pageContent && typeof source.pageContent === 'string') {
            return `${source.pageContent.substring(0, 15)}...`
        }

        return ''
    }

    const getFileUploadAllowedTypes = () => {
        if (fullFileUpload) {
            return fullFileUploadAllowedTypes === '' ? '*' : fullFileUploadAllowedTypes
        }
        return fileUploadAllowedTypes.includes('*') ? '*' : fileUploadAllowedTypes || '*'
    }

    const downloadFile = async (fileAnnotation) => {
        try {
            const response = await axios.post(
                `${baseURL}/api/v1/openai-assistants-file/download`,
                { fileName: fileAnnotation.fileName, chatflowId: chatflowid, chatId: chatId },
                { responseType: 'blob' }
            )
            const blob = new Blob([response.data], { type: response.headers['content-type'] })
            const downloadUrl = window.URL.createObjectURL(blob)
            const link = document.createElement('a')
            link.href = downloadUrl
            link.download = fileAnnotation.fileName
            document.body.appendChild(link)
            link.click()
            link.remove()
        } catch (error) {
            enqueueSnackbar({
                message: getErrorMessage(error, '文件下载失败，请稍后重试'),
                options: {
                    key: new Date().getTime() + Math.random(),
                    variant: 'error'
                }
            })
        }
    }

    const getAgentIcon = (nodeName, instructions) => {
        if (nodeName) {
            return `${baseURL}/api/v1/node-icon/${nodeName}`
        } else if (instructions) {
            return multiagent_supervisorPNG
        } else {
            return multiagent_workerPNG
        }
    }

    // Get chatmessages successful
    useEffect(() => {
        if (getChatmessageApi.data?.length) {
            const chatId = getChatmessageApi.data[0]?.chatId
            setChatId(chatId)
            const loadedMessages = getChatmessageApi.data.map((message) => {
                const obj = {
                    id: message.id,
                    message: message.content,
                    feedback: message.feedback,
                    type: message.role
                }
                if (message.sourceDocuments) obj.sourceDocuments = message.sourceDocuments
                if (message.usedTools) obj.usedTools = message.usedTools
                if (message.calledTools) obj.calledTools = message.calledTools
                if (message.fileAnnotations) obj.fileAnnotations = message.fileAnnotations
                if (message.agentReasoning) obj.agentReasoning = message.agentReasoning
                if (message.reasonContent && typeof message.reasonContent === 'object') {
                    obj.thinking = message.reasonContent.thinking
                    obj.thinkingDuration = message.reasonContent.thinkingDuration
                }
                if (message.action) obj.action = message.action
                if (message.artifacts) {
                    obj.artifacts = message.artifacts
                    obj.artifacts.forEach((artifact) => {
                        if (artifact.type === 'png' || artifact.type === 'jpeg') {
                            artifact.data = `${baseURL}/api/v1/get-upload-file?chatflowId=${chatflowid}&chatId=${chatId}&fileName=${artifact.data.replace(
                                'FILE-STORAGE::',
                                ''
                            )}`
                        }
                    })
                }
                if (message.fileUploads) {
                    obj.fileUploads = message.fileUploads
                    obj.fileUploads.forEach((file) => {
                        if (file.type === 'stored-file') {
                            file.data = `${baseURL}/api/v1/get-upload-file?chatflowId=${chatflowid}&chatId=${chatId}&fileName=${file.name}`
                        }
                    })
                }
                if (message.followUpPrompts) obj.followUpPrompts = JSON.parse(message.followUpPrompts)
                if (message.role === 'apiMessage' && message.execution && message.execution.executionData)
                    obj.agentFlowExecutedData = JSON.parse(message.execution.executionData)
                return obj
            })
            setMessages((prevMessages) => [...prevMessages, ...loadedMessages])
            setLocalStorageChatflow(chatflowid, chatId)
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getChatmessageApi.data])

    useEffect(() => {
        if (getAllExecutionsApi.data?.length) {
            const chatId = getAllExecutionsApi.data[0]?.sessionId
            setChatId(chatId)
            const loadedMessages = getAllExecutionsApi.data.map((execution) => {
                const executionData =
                    typeof execution.executionData === 'string' ? JSON.parse(execution.executionData) : execution.executionData
                const obj = {
                    id: execution.id,
                    agentFlow: executionData
                }
                return obj
            })
            setMessages((prevMessages) => [...prevMessages, ...loadedMessages])
            setLocalStorageChatflow(chatflowid, chatId)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getAllExecutionsApi.data])

    // Get chatflow streaming capability
    useEffect(() => {
        if (getIsChatflowStreamingApi.data) {
            setIsChatFlowAvailableToStream(getIsChatflowStreamingApi.data?.isStreaming ?? false)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getIsChatflowStreamingApi.data])

    // Get chatflow uploads capability
    useEffect(() => {
        if (getAllowChatFlowUploads.data) {
            setIsChatFlowAvailableForImageUploads(getAllowChatFlowUploads.data?.isImageUploadAllowed ?? false)
            setIsChatFlowAvailableForRAGFileUploads(getAllowChatFlowUploads.data?.isRAGFileUploadAllowed ?? false)
            setIsChatFlowAvailableForSpeech(getAllowChatFlowUploads.data?.isSpeechToTextEnabled ?? false)
            setImageUploadAllowedTypes(getAllowChatFlowUploads.data?.imgUploadSizeAndTypes.map((allowed) => allowed.fileTypes).join(','))
            setFileUploadAllowedTypes(getAllowChatFlowUploads.data?.fileUploadSizeAndTypes.map((allowed) => allowed.fileTypes).join(','))
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getAllowChatFlowUploads.data])

    useEffect(() => {
        if (getChatflowConfig.data) {
            setIsConfigLoading(false)
            if (getChatflowConfig.data?.flowData) {
                let nodes = JSON.parse(getChatflowConfig.data?.flowData).nodes ?? []
                const startNode = nodes.find((node) => node.data.name === 'startAgentflow')
                if (startNode) {
                    const startInputType = startNode.data.inputs?.startInputType
                    setStartInputType(startInputType)

                    const formInputTypes = startNode.data.inputs?.formInputTypes
                    if (startInputType === 'formInput' && formInputTypes && formInputTypes.length > 0) {
                        for (const formInputType of formInputTypes) {
                            if (formInputType.type === 'options') {
                                formInputType.options = formInputType.addOptions.map((option) => ({
                                    label: option.option,
                                    name: option.option
                                }))
                            }
                        }
                        setFormInputParams(formInputTypes)
                        setFormInputsData({
                            id: 'formInput',
                            inputs: {},
                            inputParams: formInputTypes
                        })
                        setFormTitle(startNode.data.inputs?.formTitle)
                        setFormDescription(startNode.data.inputs?.formDescription)
                    }

                    getAllExecutionsApi.request({ agentflowId: chatflowid })
                }
            }

            if (getChatflowConfig.data?.chatbotConfig && JSON.parse(getChatflowConfig.data?.chatbotConfig)) {
                let config = JSON.parse(getChatflowConfig.data?.chatbotConfig)
                if (config.starterPrompts) {
                    let inputFields = []
                    Object.getOwnPropertyNames(config.starterPrompts).forEach((key) => {
                        if (config.starterPrompts[key]) {
                            inputFields.push(config.starterPrompts[key])
                        }
                    })
                    setStarterPrompts(inputFields.filter((field) => field.prompt !== ''))
                }
                if (config.chatFeedback) {
                    setChatFeedbackStatus(config.chatFeedback.status)
                }

                if (config.leads) {
                    setLeadsConfig(config.leads)
                    if (config.leads.status && !getLocalStorageChatflow(chatflowid).lead) {
                        setMessages((prevMessages) => {
                            const leadCaptureMessage = {
                                message: '',
                                type: 'leadCaptureMessage'
                            }

                            return [...prevMessages, leadCaptureMessage]
                        })
                    }
                }

                if (config.followUpPrompts) {
                    setFollowUpPromptsStatus(config.followUpPrompts.status)
                }

                if (config.fullFileUpload) {
                    setFullFileUpload(config.fullFileUpload.status)
                    if (config.fullFileUpload?.allowedUploadFileTypes) {
                        setFullFileUploadAllowedTypes(config.fullFileUpload?.allowedUploadFileTypes)
                    }
                }
            }
        }

        // Check if TTS is configured
        if (getChatflowConfig.data && getChatflowConfig.data.textToSpeech) {
            try {
                const ttsConfig =
                    typeof getChatflowConfig.data.textToSpeech === 'string'
                        ? JSON.parse(getChatflowConfig.data.textToSpeech)
                        : getChatflowConfig.data.textToSpeech

                let isEnabled = false
                if (ttsConfig) {
                    Object.keys(ttsConfig).forEach((provider) => {
                        if (provider !== 'none' && ttsConfig?.[provider]?.status) {
                            isEnabled = true
                        }
                    })
                }
                setIsTTSEnabled(isEnabled)
            } catch (error) {
                setIsTTSEnabled(false)
            }
        } else {
            setIsTTSEnabled(false)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getChatflowConfig.data])

    useEffect(() => {
        if (getChatflowConfig.error) {
            setIsConfigLoading(false)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getChatflowConfig.error])

    useEffect(() => {
        if (fullFileUpload) {
            setIsChatFlowAvailableForFileUploads(true)
        } else if (isChatFlowAvailableForRAGFileUploads) {
            setIsChatFlowAvailableForFileUploads(true)
        } else {
            setIsChatFlowAvailableForFileUploads(false)
        }
    }, [isChatFlowAvailableForRAGFileUploads, fullFileUpload])

    // Auto scroll chat to bottom (but not during TTS actions)
    useEffect(() => {
        if (!isTTSActionRef.current) {
            scrollToBottom()
        }
    }, [messages])

    useEffect(() => {
        if (isDialog && inputRef) {
            setTimeout(() => {
                inputRef.current?.focus()
            }, 100)
        }
    }, [isDialog, inputRef])

    useEffect(() => {
        if (open && chatflowid) {
            // API request
            getChatmessageApi.request(chatflowid)
            getIsChatflowStreamingApi.request(chatflowid)
            getAllowChatFlowUploads.request(chatflowid)
            getChatflowConfig.request(chatflowid)

            // Add a small delay to ensure content is rendered before scrolling
            setTimeout(() => {
                scrollToBottom()
            }, 100)

            setIsRecording(false)
            setIsConfigLoading(true)

            // leads
            const savedLead = getLocalStorageChatflow(chatflowid)?.lead
            if (savedLead) {
                setIsLeadSaved(!!savedLead)
                setLeadEmail(savedLead.email)
            }
        }

        return () => {
            setUserInput('')
            setUploadedFiles([])
            setLoading(false)
            setMessages([
                {
                    message: '你好！有什么可以帮你？',
                    type: 'apiMessage'
                }
            ])
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, chatflowid])

    useEffect(() => {
        // wait for audio recording to load and then send
        const containsAudio = previews.filter((item) => item.type === 'audio').length > 0
        if (previews.length >= 1 && containsAudio) {
            setIsRecording(false)
            setRecordingNotSupported(false)
            handlePromptClick('')
        }
        // eslint-disable-next-line
    }, [previews])

    useEffect(() => {
        if (followUpPromptsStatus && messages.length > 0) {
            const lastMessage = messages[messages.length - 1]
            if (lastMessage.type === 'apiMessage' && lastMessage.followUpPrompts) {
                if (Array.isArray(lastMessage.followUpPrompts)) {
                    setFollowUpPrompts(lastMessage.followUpPrompts)
                }
                if (typeof lastMessage.followUpPrompts === 'string') {
                    const followUpPrompts = JSON.parse(lastMessage.followUpPrompts)
                    setFollowUpPrompts(followUpPrompts)
                }
            } else if (lastMessage.type === 'userMessage') {
                setFollowUpPrompts([])
            }
        }
    }, [followUpPromptsStatus, messages])

    const copyMessageToClipboard = async (text) => {
        try {
            await navigator.clipboard.writeText(text || '')
        } catch (error) {
            enqueueSnackbar({
                message: getErrorMessage(error, '复制消息失败，请稍后重试'),
                options: {
                    key: new Date().getTime() + Math.random(),
                    variant: 'error'
                }
            })
        }
    }

    const onThumbsUpClick = async (messageId) => {
        const body = {
            chatflowid,
            chatId,
            messageId,
            rating: 'THUMBS_UP',
            content: ''
        }
        const result = await chatmessagefeedbackApi.addFeedback(chatflowid, body)
        if (result.data) {
            const data = result.data
            let id = ''
            if (data && data.id) id = data.id
            setMessages((prevMessages) => {
                const allMessages = [...cloneDeep(prevMessages)]
                return allMessages.map((message) => {
                    if (message.id === messageId) {
                        message.feedback = {
                            rating: 'THUMBS_UP'
                        }
                    }
                    return message
                })
            })
            setFeedbackId(id)
            setShowFeedbackContentDialog(true)
        }
    }

    const onThumbsDownClick = async (messageId) => {
        const body = {
            chatflowid,
            chatId,
            messageId,
            rating: 'THUMBS_DOWN',
            content: ''
        }
        const result = await chatmessagefeedbackApi.addFeedback(chatflowid, body)
        if (result.data) {
            const data = result.data
            let id = ''
            if (data && data.id) id = data.id
            setMessages((prevMessages) => {
                const allMessages = [...cloneDeep(prevMessages)]
                return allMessages.map((message) => {
                    if (message.id === messageId) {
                        message.feedback = {
                            rating: 'THUMBS_DOWN'
                        }
                    }
                    return message
                })
            })
            setFeedbackId(id)
            setShowFeedbackContentDialog(true)
        }
    }

    const submitFeedbackContent = async (text) => {
        const body = {
            content: text
        }
        const result = await chatmessagefeedbackApi.updateFeedback(feedbackId, body)
        if (result.data) {
            setFeedbackId('')
            setShowFeedbackContentDialog(false)
        }
    }

    const handleLeadCaptureSubmit = async (event) => {
        if (event) event.preventDefault()
        setIsLeadSaving(true)

        const body = {
            chatflowid,
            chatId,
            name: leadName,
            email: leadEmail,
            phone: leadPhone
        }

        const result = await leadsApi.addLead(body)
        if (result.data) {
            const data = result.data
            setChatId(data.chatId)
            setLocalStorageChatflow(chatflowid, data.chatId, { lead: { name: leadName, email: leadEmail, phone: leadPhone } })
            setIsLeadSaved(true)
            setLeadEmail(leadEmail)
            setMessages((prevMessages) => {
                let allMessages = [...cloneDeep(prevMessages)]
                if (allMessages[allMessages.length - 1].type !== 'leadCaptureMessage') return allMessages
                allMessages[allMessages.length - 1].message = leadsConfig.successMessage || '感谢您提交联系信息。'
                return allMessages
            })
        }

        setIsLeadSaving(false)
    }

    const clearTTSMessageState = (messageId) => {
        setIsTTSPlaying((prev) => {
            const newState = { ...prev }
            delete newState[messageId]
            return newState
        })

        setIsTTSLoading((prev) => {
            const newState = { ...prev }
            delete newState[messageId]
            return newState
        })
    }

    const cleanupTTSForMessage = (messageId) => {
        if (ttsAudio[messageId]) {
            ttsAudio[messageId].pause()
            ttsAudio[messageId].currentTime = 0
            setTtsAudio((prev) => {
                const newState = { ...prev }
                delete newState[messageId]
                return newState
            })
        }

        cleanupTTSStreaming()
        clearTTSMessageState(messageId)
    }

    const handleTTSStop = async (messageId) => {
        setTTSAction(true)
        cleanupTTSForMessage(messageId)
        try {
            await ttsApi.abortTTS({ chatflowId: chatflowid, chatId, chatMessageId: messageId })
        } catch (error) {
            enqueueSnackbar({
                message: getErrorMessage(error, '已停止本地播放，但服务端停止请求失败'),
                options: { variant: 'warning' }
            })
        } finally {
            setIsMessageStopping(false)
        }
    }

    const stopAllTTS = () => {
        ttsStreamSessionRef.current += 1
        Object.keys(ttsAudio).forEach((messageId) => {
            if (ttsAudio[messageId]) {
                ttsAudio[messageId].pause()
                ttsAudio[messageId].currentTime = 0
            }
        })
        setTtsAudio({})

        cleanupTTSStreaming()

        setIsTTSPlaying({})
        setIsTTSLoading({})
    }

    const handleTTSClick = async (messageId, messageText) => {
        if (isTTSLoading[messageId]) return

        if (isTTSPlaying[messageId] || ttsAudio[messageId]) {
            handleTTSStop(messageId)
            return
        }

        setTTSAction(true)

        // abort all ongoing streams and clear audio sources
        void handleTTSAbortAll()
        stopAllTTS()

        const sessionId = handleTTSStart({ chatMessageId: messageId, format: 'mp3' })
        const resources = ttsStreamingResourcesRef.current
        let reader = null
        let receivedEnd = false
        try {
            const abortController = new AbortController()
            resources.abortController = abortController

            const response = await fetch('/api/v1/text-to-speech/generate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-request-from': 'internal'
                },
                credentials: 'include',
                signal: abortController.signal,
                body: JSON.stringify({
                    chatflowId: chatflowid,
                    chatId: chatId,
                    chatMessageId: messageId,
                    text: messageText
                })
            })

            if (!response.ok) {
                enqueueSnackbar({
                    message: `语音播放失败：HTTP 请求状态码 ${response.status}`,
                    options: { variant: 'error' }
                })
                return
            }

            if (!response.body) {
                enqueueSnackbar({
                    message: '语音播放失败：未收到音频数据',
                    options: { variant: 'error' }
                })
                return
            }

            if (ttsStreamingResourcesRef.current !== resources || resources.disposed || resources.abortController?.signal.aborted) {
                try {
                    await response.body.cancel()
                } catch {
                    // The response may already be closed after a local stop.
                }
                return
            }

            reader = response.body.getReader()
            resources.reader = reader
            const decoder = new TextDecoder()
            let buffer = ''

            let done = false
            while (!done) {
                if (abortController.signal.aborted) {
                    break
                }

                const result = await reader.read()
                done = result.done
                if (done) {
                    break
                }
                const value = result.value
                const chunk = decoder.decode(value, { stream: true })
                buffer += chunk

                const lines = buffer.split('\n\n')
                buffer = lines.pop() || ''

                for (const eventBlock of lines) {
                    if (eventBlock.trim()) {
                        const event = parseSSEEvent(eventBlock)
                        if (event) {
                            switch (event.event) {
                                case 'tts_start':
                                    break
                                case 'tts_data':
                                    if (!abortController.signal.aborted) {
                                        handleTTSDataChunk(event.data.audioChunk, event.data.chatMessageId)
                                    }
                                    break
                                case 'tts_end':
                                    if (!abortController.signal.aborted) {
                                        receivedEnd = true
                                        handleTTSEnd(event.data.chatMessageId)
                                    }
                                    break
                                case 'tts_error':
                                    enqueueSnackbar({
                                        message: '语音生成失败，请检查配置后重试',
                                        options: { variant: 'error' }
                                    })
                                    abortController.abort()
                                    break
                            }
                        }
                    }
                }
            }
        } catch (error) {
            if (error.name !== 'AbortError' && ttsStreamingResourcesRef.current === resources && !resources.disposed) {
                enqueueSnackbar({
                    message: `语音播放失败：${getErrorMessage(error, '网络或浏览器错误')}`,
                    options: { variant: 'error' }
                })
            }
        } finally {
            if (reader) {
                if (!receivedEnd && ttsStreamingResourcesRef.current === resources && !resources.disposed) {
                    resources.abortController?.abort()
                    try {
                        await reader.cancel()
                    } catch {
                        // The stream may already be closed or aborted.
                    }
                }
                try {
                    reader.releaseLock()
                } catch {
                    // The reader may already have released its lock.
                }
                if (resources.reader === reader) resources.reader = null
            }
            if (!receivedEnd && ttsStreamingResourcesRef.current === resources && !resources.disposed) {
                cleanupTTSStreaming(sessionId)
                clearTTSMessageState(messageId)
            }
            if (ttsStreamingResourcesRef.current === resources && !resources.disposed) {
                setIsTTSLoading((prev) => {
                    const newState = { ...prev }
                    delete newState[messageId]
                    return newState
                })
            }
        }
    }

    const parseSSEEvent = (eventBlock) => {
        const lines = eventBlock.split('\n')
        const event = {}

        for (const line of lines) {
            if (line.startsWith('event:')) {
                event.event = line.substring(6).trim()
            } else if (line.startsWith('data:')) {
                const dataStr = line.substring(5).trim()
                try {
                    const parsed = JSON.parse(dataStr)
                    if (parsed.data) {
                        event.data = parsed.data
                    }
                } catch {
                    // Ignore malformed stream events without exposing raw provider data.
                }
            }
        }

        return event.event ? event : null
    }

    const cleanupTTSStreaming = (expectedSessionId = null) => {
        const resources = ttsStreamingResourcesRef.current
        if (expectedSessionId !== null && !ownsTTSStream(ttsStreamingResourcesRef, resources, expectedSessionId)) return

        if (ttsInitializationTimeoutRef.current) {
            clearTimeout(ttsInitializationTimeoutRef.current)
            ttsInitializationTimeoutRef.current = null
        }
        if (!disposeTTSStreamResources(resources)) return

        if (ttsStreamingResourcesRef.current === resources) {
            ttsStreamingResourcesRef.current = createTTSStreamResources(ttsStreamSessionRef.current)
        }
    }

    const processChunkQueue = (sessionId) => {
        const resources = ttsStreamingResourcesRef.current
        if (resources.sessionId !== sessionId || resources.disposed || !resources.sourceBuffer || resources.sourceBuffer.updating) return

        if (resources.chunkQueue.length > 0) {
            const chunk = resources.chunkQueue.shift()
            try {
                resources.sourceBuffer.appendBuffer(chunk)
            } catch {
                enqueueSnackbar({ message: '语音数据写入失败，请重试', options: { variant: 'error' } })
                clearTTSMessageState(resources.chatMessageId)
                cleanupTTSStreaming(sessionId)
            }
            return
        }

        if (resources.ended && resources.mediaSource?.readyState === 'open') {
            try {
                resources.mediaSource.endOfStream()
            } catch {
                // The browser may have already closed the stream.
            }
        }
    }

    const initializeTTSStreaming = (data, sessionId) => {
        const resources = ttsStreamingResourcesRef.current
        if (resources.sessionId !== sessionId || resources.disposed) return

        const failPlayback = (message, variant = 'error') => {
            if (ttsStreamingResourcesRef.current !== resources || resources.disposed) return
            enqueueSnackbar({ message, options: { variant } })
            clearTTSMessageState(data.chatMessageId)
            cleanupTTSStreaming(sessionId)
        }

        try {
            resources.mediaSource = new MediaSource()
            resources.audio = new Audio()
            resources.objectUrl = URL.createObjectURL(resources.mediaSource)
            resources.audio.src = resources.objectUrl

            resources.sourceOpenHandler = () => {
                if (ttsStreamingResourcesRef.current !== resources || resources.disposed) return
                if (resources.initializationWatchdog) {
                    clearTimeout(resources.initializationWatchdog)
                    resources.initializationWatchdog = null
                }
                try {
                    resources.sourceBuffer = resources.mediaSource.addSourceBuffer('audio/mpeg')
                    resources.sourceBufferUpdateHandler = () => {
                        if (ttsStreamingResourcesRef.current !== resources || resources.disposed) return
                        processChunkQueue(sessionId)
                    }
                    resources.sourceBuffer.addEventListener('updateend', resources.sourceBufferUpdateHandler)
                    processChunkQueue(sessionId)
                    resources.audio.play().catch(() => failPlayback('无法自动播放语音，请重试', 'warning'))
                } catch {
                    failPlayback('语音流初始化失败，请稍后重试')
                }
            }

            resources.audioPlayingHandler = () => {
                if (ttsStreamingResourcesRef.current !== resources || resources.disposed) return
                setIsTTSLoading((prevState) => {
                    const newState = { ...prevState }
                    delete newState[data.chatMessageId]
                    return newState
                })
                setIsTTSPlaying((prevState) => ({ ...prevState, [data.chatMessageId]: true }))
            }
            resources.audioEndedHandler = () => {
                if (ttsStreamingResourcesRef.current !== resources || resources.disposed) return
                clearTTSMessageState(data.chatMessageId)
                cleanupTTSStreaming(sessionId)
            }
            resources.audioErrorHandler = () => failPlayback('语音播放失败，请稍后重试')

            resources.mediaSource.addEventListener('sourceopen', resources.sourceOpenHandler, { once: true })
            resources.audio.addEventListener('playing', resources.audioPlayingHandler)
            resources.audio.addEventListener('ended', resources.audioEndedHandler, { once: true })
            resources.audio.addEventListener('error', resources.audioErrorHandler, { once: true })
            resources.initializationWatchdog = setTimeout(() => failPlayback('语音流初始化超时，请重试'), 8000)
        } catch {
            failPlayback('浏览器无法初始化语音播放')
        }
    }

    const handleTTSStart = (data) => {
        setTTSAction(true)

        // Stop all existing TTS audio before starting new stream
        stopAllTTS()
        const sessionId = ttsStreamSessionRef.current + 1
        ttsStreamSessionRef.current = sessionId
        ttsStreamingResourcesRef.current = createTTSStreamResources(sessionId, data.chatMessageId)

        setIsTTSLoading((prevState) => ({
            ...prevState,
            [data.chatMessageId]: true
        }))
        setMessages((prevMessages) => {
            const allMessages = [...cloneDeep(prevMessages)]
            const lastMessage = allMessages[allMessages.length - 1]
            if (lastMessage.type === 'userMessage') return allMessages
            if (lastMessage.id) return allMessages
            allMessages[allMessages.length - 1].id = data.chatMessageId
            return allMessages
        })
        ttsInitializationTimeoutRef.current = setTimeout(() => {
            ttsInitializationTimeoutRef.current = null
            initializeTTSStreaming(data, sessionId)
        }, 0)
        return sessionId
    }

    const handleTTSDataChunk = (base64Data, messageId) => {
        try {
            const audioBuffer = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0))
            const resources = ttsStreamingResourcesRef.current
            if (resources.disposed || !resources.sessionId || resources.chatMessageId !== messageId) return
            resources.chunkQueue.push(audioBuffer)
            processChunkQueue(resources.sessionId)
        } catch {
            enqueueSnackbar({
                message: '语音数据解析失败，请重试',
                options: { variant: 'error' }
            })
        }
    }

    const handleTTSEnd = (messageId) => {
        const resources = ttsStreamingResourcesRef.current
        if (resources.disposed || !resources.sessionId || resources.chatMessageId !== messageId) return
        resources.ended = true
        processChunkQueue(resources.sessionId)
    }

    const handleTTSAbort = (data) => {
        const messageId = data.chatMessageId
        if (ttsStreamingResourcesRef.current.chatMessageId === messageId) cleanupTTSForMessage(messageId)
        else clearTTSMessageState(messageId)
    }

    const handleTTSAbortAll = async () => {
        const activeTTSMessages = [...new Set(Object.keys(isTTSLoading).concat(Object.keys(isTTSPlaying)))]
        await Promise.allSettled(
            activeTTSMessages.map((messageId) => ttsApi.abortTTS({ chatflowId: chatflowid, chatId, chatMessageId: messageId }))
        )
    }

    useEffect(() => {
        return () => {
            chatStreamAbortControllerRef.current?.abort()
            cleanupTTSStreaming()
            // Cleanup TTS timeout on unmount
            if (ttsTimeoutRef.current) {
                clearTimeout(ttsTimeoutRef.current)
                ttsTimeoutRef.current = null
            }
        }
    }, [])

    const getInputDisabled = () => {
        return (
            loading ||
            !chatflowid ||
            (leadsConfig?.status && !isLeadSaved) ||
            (messages[messages.length - 1].action && Object.keys(messages[messages.length - 1].action).length > 0)
        )
    }

    const previewDisplay = (item) => {
        if (item.mime.startsWith('image/')) {
            return (
                <ImageButton
                    focusRipple
                    style={{
                        width: '48px',
                        height: '48px',
                        marginRight: '10px',
                        flex: '0 0 auto'
                    }}
                    disabled={getInputDisabled()}
                    onClick={() => handleDeletePreview(item)}
                >
                    <ImageSrc style={{ backgroundImage: `url(${item.data})` }} />
                    <ImageBackdrop className='MuiImageBackdrop-root' />
                    <ImageMarked className='MuiImageMarked-root'>
                        <IconTrash size={20} color='white' />
                    </ImageMarked>
                </ImageButton>
            )
        } else if (item.mime.startsWith('audio/')) {
            return (
                <Card
                    sx={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        height: '48px',
                        width: isDialog ? ps?.current?.offsetWidth / 4 : ps?.current?.offsetWidth / 2,
                        p: 0.5,
                        mr: 1,
                        backgroundColor: theme.palette.grey[500],
                        flex: '0 0 auto'
                    }}
                    variant='outlined'
                >
                    <CardMedia component='audio' sx={{ color: 'transparent' }} controls src={item.data} />
                    <IconButton disabled={getInputDisabled()} onClick={() => handleDeletePreview(item)} size='small'>
                        <IconTrash size={20} color='white' />
                    </IconButton>
                </Card>
            )
        } else {
            return (
                <CardWithDeleteOverlay
                    disabled={getInputDisabled()}
                    item={item}
                    customization={customization}
                    onDelete={() => handleDeletePreview(item)}
                />
            )
        }
    }

    const renderFileUploads = (item, index) => {
        if (item?.mime?.startsWith('image/')) {
            return (
                <Card
                    key={index}
                    sx={{
                        p: 0,
                        m: 0,
                        maxWidth: 128,
                        marginRight: '10px',
                        flex: '0 0 auto'
                    }}
                >
                    <CardMedia component='img' image={item.data} sx={{ height: 64 }} alt='上传内容预览' style={messageImageStyle} />
                </Card>
            )
        } else if (item?.mime?.startsWith('audio/')) {
            return (
                /* eslint-disable jsx-a11y/media-has-caption */
                <audio controls='controls'>
                    当前浏览器不支持 &lt;audio&gt; 标签。
                    <source src={item.data} type={item.mime} />
                </audio>
            )
        } else {
            return (
                <Card
                    sx={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        height: '48px',
                        width: 'max-content',
                        p: 2,
                        mr: 1,
                        flex: '0 0 auto',
                        backgroundColor: customization.isDarkMode ? 'rgba(0, 0, 0, 0.3)' : 'transparent'
                    }}
                    variant='outlined'
                >
                    <IconPaperclip size={20} />
                    <span
                        style={{
                            marginLeft: '5px',
                            color: customization.isDarkMode ? 'white' : 'inherit'
                        }}
                    >
                        {item.name}
                    </span>
                </Card>
            )
        }
    }

    const agentReasoningArtifacts = (artifacts) => {
        const newArtifacts = cloneDeep(artifacts)
        for (let i = 0; i < newArtifacts.length; i++) {
            const artifact = newArtifacts[i]
            if (artifact && (artifact.type === 'png' || artifact.type === 'jpeg')) {
                const data = artifact.data
                newArtifacts[i].data = `${baseURL}/api/v1/get-upload-file?chatflowId=${chatflowid}&chatId=${chatId}&fileName=${data.replace(
                    'FILE-STORAGE::',
                    ''
                )}`
            }
        }
        return newArtifacts
    }

    const renderArtifacts = (item, index, isAgentReasoning) => {
        if (item.type === 'png' || item.type === 'jpeg') {
            return (
                <Card
                    key={index}
                    sx={{
                        p: 0,
                        m: 0,
                        mt: 2,
                        mb: 2,
                        flex: '0 0 auto'
                    }}
                >
                    <CardMedia
                        component='img'
                        image={item.data}
                        sx={{ height: 'auto' }}
                        alt='生成内容'
                        style={{
                            width: isAgentReasoning ? '200px' : '100%',
                            height: isAgentReasoning ? '200px' : 'auto',
                            objectFit: 'cover'
                        }}
                    />
                </Card>
            )
        } else if (item.type === 'html') {
            return (
                <div style={{ marginTop: '20px' }}>
                    <SafeHTML html={item.data} />
                </div>
            )
        } else {
            return (
                <MemoizedReactMarkdown chatflowid={chatflowid} isFullWidth={isDialog}>
                    {item.data}
                </MemoizedReactMarkdown>
            )
        }
    }

    if (isConfigLoading) {
        return (
            <Box
                sx={{
                    width: '100%',
                    height: '100%',
                    position: 'relative',
                    backgroundColor: theme.palette.background.paper
                }}
            >
                <Box
                    sx={{
                        position: 'absolute',
                        top: '50%',
                        left: '50%',
                        transform: 'translate(-50%, -50%)'
                    }}
                >
                    <CircularProgress />
                </Box>
            </Box>
        )
    }

    if (startInputType === 'formInput' && messages.length === 1) {
        return (
            <Box
                sx={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    p: 2,
                    backgroundColor: theme.palette.background.paper
                }}
            >
                <Box
                    sx={{
                        width: '100%',
                        height: '100%',
                        position: 'relative'
                    }}
                >
                    <Box
                        sx={{
                            position: 'absolute',
                            top: '50%',
                            left: '50%',
                            transform: 'translate(-50%, -50%)',
                            width: '100%',
                            maxWidth: '600px',
                            maxHeight: '90%', // Limit height to 90% of parent
                            p: 3,
                            backgroundColor: customization.isDarkMode
                                ? darken(theme.palette.background.paper, 0.2)
                                : theme.palette.background.paper,
                            boxShadow: customization.isDarkMode ? '0px 0px 15px 0px rgba(255, 255, 255, 0.1)' : theme.shadows[3],
                            borderRadius: 2,
                            overflowY: 'auto' // Enable vertical scrolling if content overflows
                        }}
                    >
                        <Typography variant='h4' sx={{ mb: 1, textAlign: 'center' }}>
                            {formTitle || '请填写表单'}
                        </Typography>
                        <Typography variant='body1' sx={{ mb: 3, textAlign: 'center', color: theme.palette.text.secondary }}>
                            {formDescription || '请填写下方全部字段后继续'}
                        </Typography>

                        {/* Form inputs */}
                        <Box sx={{ mb: 3 }}>
                            {formInputParams &&
                                formInputParams.map((inputParam, index) => (
                                    <Box key={index} sx={{ mb: 2 }}>
                                        <NodeInputHandler
                                            inputParam={inputParam}
                                            data={formInputsData}
                                            isAdditionalParams={true}
                                            onCustomDataChange={({ inputParam, newValue }) => {
                                                setFormInputsData((prev) => ({
                                                    ...prev,
                                                    inputs: {
                                                        ...prev.inputs,
                                                        [inputParam.name]: newValue
                                                    }
                                                }))
                                            }}
                                        />
                                    </Box>
                                ))}
                        </Box>

                        <Button
                            variant='contained'
                            fullWidth
                            disabled={loading}
                            onClick={() => handleSubmit(null, formInputsData.inputs)}
                            sx={{
                                mb: 2,
                                borderRadius: 20,
                                background: 'linear-gradient(45deg, #673ab7 30%, #1e88e5 90%)'
                            }}
                        >
                            {loading ? '正在提交……' : '提交'}
                        </Button>
                    </Box>
                </Box>
            </Box>
        )
    }

    return (
        <div onDragEnter={handleDrag}>
            {isDragActive && (
                <div
                    className='image-dropzone'
                    onDragEnter={handleDrag}
                    onDragLeave={handleDrag}
                    onDragEnd={handleDrag}
                    onDrop={handleDrop}
                />
            )}
            {isDragActive &&
                (getAllowChatFlowUploads.data?.isImageUploadAllowed || getAllowChatFlowUploads.data?.isRAGFileUploadAllowed) && (
                    <Box className='drop-overlay'>
                        <Typography variant='h2'>拖放到此处上传</Typography>
                        {[
                            ...getAllowChatFlowUploads.data.imgUploadSizeAndTypes,
                            ...getAllowChatFlowUploads.data.fileUploadSizeAndTypes
                        ].map((allowed) => {
                            return (
                                <>
                                    <Typography variant='subtitle1'>{allowed.fileTypes?.join(', ')}</Typography>
                                    {allowed.maxUploadSize && (
                                        <Typography variant='subtitle1'>最大允许大小：{allowed.maxUploadSize} MB</Typography>
                                    )}
                                </>
                            )
                        })}
                    </Box>
                )}
            <div ref={ps} className={`${isDialog ? 'cloud-dialog' : 'cloud'}`}>
                <div id='messagelist' className={'messagelist'}>
                    {messages &&
                        messages.map((message, index) => {
                            return (
                                // The latest message sent by the user will be animated while waiting for a response
                                <Box
                                    sx={{
                                        background:
                                            message.type === 'apiMessage' || message.type === 'leadCaptureMessage'
                                                ? theme.palette.asyncSelect.main
                                                : ''
                                    }}
                                    key={index}
                                    style={{ display: 'flex' }}
                                    className={
                                        message.type === 'userMessage' && loading && index === messages.length - 1
                                            ? customization.isDarkMode
                                                ? 'usermessagewaiting-dark'
                                                : 'usermessagewaiting-light'
                                            : message.type === 'usermessagewaiting'
                                            ? 'apimessage'
                                            : 'usermessage'
                                    }
                                >
                                    {/* Display the correct icon depending on the message type */}
                                    {message.type === 'apiMessage' || message.type === 'leadCaptureMessage' ? (
                                        <img src={robotPNG} alt='AI 助手' width='30' height='30' className='boticon' />
                                    ) : (
                                        <img src={userPNG} alt='用户' width='30' height='30' className='usericon' />
                                    )}
                                    <div
                                        style={{
                                            display: 'flex',
                                            flexDirection: 'column',
                                            width: '100%'
                                        }}
                                    >
                                        {message.fileUploads && message.fileUploads.length > 0 && (
                                            <div
                                                style={{
                                                    display: 'flex',
                                                    flexWrap: 'wrap',
                                                    flexDirection: 'column',
                                                    width: '100%',
                                                    gap: '8px'
                                                }}
                                            >
                                                {message.fileUploads.map((item, index) => {
                                                    return <>{renderFileUploads(item, index)}</>
                                                })}
                                            </div>
                                        )}
                                        {message.thinking && (
                                            <ThinkingCard
                                                thinking={message.thinking}
                                                thinkingDuration={message.thinkingDuration}
                                                isThinking={message.isThinking}
                                                customization={customization}
                                            />
                                        )}
                                        {message.agentReasoning && message.agentReasoning.length > 0 && (
                                            <div style={{ display: 'block', flexDirection: 'row', width: '100%' }}>
                                                {message.agentReasoning.map((agent, index) => (
                                                    <AgentReasoningCard
                                                        key={index}
                                                        agent={agent}
                                                        index={index}
                                                        customization={customization}
                                                        chatflowid={chatflowid}
                                                        isDialog={isDialog}
                                                        onSourceDialogClick={onSourceDialogClick}
                                                        renderArtifacts={renderArtifacts}
                                                        agentReasoningArtifacts={agentReasoningArtifacts}
                                                        getAgentIcon={getAgentIcon}
                                                        removeDuplicateURL={removeDuplicateURL}
                                                        isValidURL={isValidURL}
                                                        onURLClick={onURLClick}
                                                        getLabel={getLabel}
                                                    />
                                                ))}
                                            </div>
                                        )}
                                        {message.agentFlowExecutedData &&
                                            Array.isArray(message.agentFlowExecutedData) &&
                                            message.agentFlowExecutedData.length > 0 && (
                                                <AgentExecutedDataCard
                                                    status={message.agentFlowEventStatus}
                                                    execution={message.agentFlowExecutedData}
                                                    agentflowId={chatflowid}
                                                    sessionId={chatId}
                                                />
                                            )}
                                        {message.calledTools && (
                                            <div
                                                style={{
                                                    display: 'block',
                                                    flexDirection: 'row',
                                                    width: '100%'
                                                }}
                                            >
                                                {message.calledTools.map((tool, index) => {
                                                    return tool ? (
                                                        <Chip
                                                            size='small'
                                                            key={`called-${index}`}
                                                            label={tool.tool}
                                                            component='a'
                                                            sx={{
                                                                mr: 1,
                                                                mt: 1,
                                                                borderColor: 'primary.main',
                                                                color: 'primary.main',
                                                                backgroundColor: 'rgba(25, 118, 210, 0.1)',
                                                                opacity: 0.9,
                                                                '&:hover': {
                                                                    backgroundColor: 'rgba(25, 118, 210, 0.2)',
                                                                    opacity: 1
                                                                }
                                                            }}
                                                            variant='outlined'
                                                            clickable
                                                            icon={<CircularProgress size={15} color='primary' />}
                                                            onClick={() => onSourceDialogClick(tool, '调用中的工具')}
                                                        />
                                                    ) : null
                                                })}
                                            </div>
                                        )}
                                        {message.usedTools && (
                                            <div
                                                style={{
                                                    display: 'block',
                                                    flexDirection: 'row',
                                                    width: '100%'
                                                }}
                                            >
                                                {message.usedTools.map((tool, index) => {
                                                    return tool ? (
                                                        <Chip
                                                            size='small'
                                                            key={`used-${index}`}
                                                            label={tool.tool}
                                                            component='a'
                                                            sx={{
                                                                mr: 1,
                                                                mt: 1,
                                                                borderColor: tool.error ? 'error.main' : undefined,
                                                                color: tool.error ? 'error.main' : undefined
                                                            }}
                                                            variant='outlined'
                                                            clickable
                                                            icon={
                                                                <IconTool
                                                                    size={15}
                                                                    color={tool.error ? theme.palette.error.main : undefined}
                                                                />
                                                            }
                                                            onClick={() => onSourceDialogClick(tool, '已用工具')}
                                                        />
                                                    ) : null
                                                })}
                                            </div>
                                        )}
                                        {message.artifacts && (
                                            <div
                                                style={{
                                                    display: 'flex',
                                                    flexWrap: 'wrap',
                                                    flexDirection: 'column',
                                                    width: '100%'
                                                }}
                                            >
                                                {message.artifacts.map((item, index) => {
                                                    return item !== null ? <>{renderArtifacts(item, index)}</> : null
                                                })}
                                            </div>
                                        )}
                                        <div className='markdownanswer'>
                                            {message.type === 'leadCaptureMessage' &&
                                            !getLocalStorageChatflow(chatflowid)?.lead &&
                                            leadsConfig.status ? (
                                                <Box
                                                    sx={{
                                                        display: 'flex',
                                                        flexDirection: 'column',
                                                        gap: 2,
                                                        marginTop: 2
                                                    }}
                                                >
                                                    <Typography sx={{ lineHeight: '1.5rem', whiteSpace: 'pre-line' }}>
                                                        {leadsConfig.title || '请留下您的联系方式：'}
                                                    </Typography>
                                                    <form
                                                        style={{
                                                            display: 'flex',
                                                            flexDirection: 'column',
                                                            gap: '8px',
                                                            width: isDialog ? '50%' : '100%'
                                                        }}
                                                        onSubmit={handleLeadCaptureSubmit}
                                                    >
                                                        {leadsConfig.name && (
                                                            <OutlinedInput
                                                                id='leadName'
                                                                type='text'
                                                                fullWidth
                                                                placeholder='名称'
                                                                name='leadName'
                                                                value={leadName}
                                                                // eslint-disable-next-line
                                                                autoFocus={true}
                                                                onChange={(e) => setLeadName(e.target.value)}
                                                            />
                                                        )}
                                                        {leadsConfig.email && (
                                                            <OutlinedInput
                                                                id='leadEmail'
                                                                type='email'
                                                                fullWidth
                                                                placeholder='邮箱地址'
                                                                name='leadEmail'
                                                                value={leadEmail}
                                                                onChange={(e) => setLeadEmail(e.target.value)}
                                                            />
                                                        )}
                                                        {leadsConfig.phone && (
                                                            <OutlinedInput
                                                                id='leadPhone'
                                                                type='number'
                                                                fullWidth
                                                                placeholder='电话号码'
                                                                name='leadPhone'
                                                                value={leadPhone}
                                                                onChange={(e) => setLeadPhone(e.target.value)}
                                                            />
                                                        )}
                                                        <Box
                                                            sx={{
                                                                display: 'flex',
                                                                alignItems: 'center'
                                                            }}
                                                        >
                                                            <Button
                                                                variant='outlined'
                                                                fullWidth
                                                                type='submit'
                                                                sx={{ borderRadius: '20px' }}
                                                            >
                                                                {isLeadSaving ? '正在保存……' : '保存'}
                                                            </Button>
                                                        </Box>
                                                    </form>
                                                </Box>
                                            ) : (
                                                <>
                                                    <MemoizedReactMarkdown chatflowid={chatflowid} isFullWidth={isDialog}>
                                                        {message.message}
                                                    </MemoizedReactMarkdown>
                                                </>
                                            )}
                                        </div>
                                        {message.fileAnnotations && (
                                            <div
                                                style={{
                                                    display: 'block',
                                                    flexDirection: 'row',
                                                    width: '100%',
                                                    marginBottom: '8px'
                                                }}
                                            >
                                                {message.fileAnnotations.map((fileAnnotation, index) => {
                                                    return (
                                                        <Button
                                                            sx={{
                                                                fontSize: '0.85rem',
                                                                textTransform: 'none',
                                                                mb: 1
                                                            }}
                                                            key={index}
                                                            variant='outlined'
                                                            onClick={() => downloadFile(fileAnnotation)}
                                                            endIcon={<IconDownload color={theme.palette.primary.main} />}
                                                        >
                                                            {fileAnnotation.fileName}
                                                        </Button>
                                                    )
                                                })}
                                            </div>
                                        )}
                                        {message.sourceDocuments && (
                                            <div
                                                style={{
                                                    display: 'block',
                                                    flexDirection: 'row',
                                                    width: '100%',
                                                    marginBottom: '8px'
                                                }}
                                            >
                                                {removeDuplicateURL(message).map((source, index) => {
                                                    const URL =
                                                        source.metadata && source.metadata.source
                                                            ? isValidURL(source.metadata.source)
                                                            : undefined
                                                    return (
                                                        <Chip
                                                            size='small'
                                                            key={index}
                                                            label={getLabel(URL, source) || ''}
                                                            component='a'
                                                            sx={{ mr: 1, mb: 1 }}
                                                            variant='outlined'
                                                            clickable
                                                            onClick={() =>
                                                                URL ? onURLClick(source.metadata.source) : onSourceDialogClick(source)
                                                            }
                                                        />
                                                    )
                                                })}
                                            </div>
                                        )}
                                        {message.action && (
                                            <div
                                                style={{
                                                    display: 'flex',
                                                    flexWrap: 'wrap',
                                                    flexDirection: 'row',
                                                    width: '100%',
                                                    gap: '8px',
                                                    marginBottom: '8px'
                                                }}
                                            >
                                                {(message.action.elements || []).map((elem, index) => {
                                                    return (
                                                        <>
                                                            {(elem.type === 'approve-button' && elem.label === 'Yes') ||
                                                            elem.type === 'agentflowv2-approve-button' ? (
                                                                <Button
                                                                    sx={{
                                                                        width: 'max-content',
                                                                        borderRadius: '20px',
                                                                        background: customization.isDarkMode ? 'transparent' : 'white'
                                                                    }}
                                                                    variant='outlined'
                                                                    color='success'
                                                                    key={index}
                                                                    startIcon={<IconCheck />}
                                                                    onClick={() => handleActionClick(elem, message.action)}
                                                                >
                                                                    {elem.type === 'agentflowv2-approve-button'
                                                                        ? '继续'
                                                                        : elem.label === 'Yes'
                                                                        ? '是'
                                                                        : elem.label}
                                                                </Button>
                                                            ) : (elem.type === 'reject-button' && elem.label === 'No') ||
                                                              elem.type === 'agentflowv2-reject-button' ? (
                                                                <Button
                                                                    sx={{
                                                                        width: 'max-content',
                                                                        borderRadius: '20px',
                                                                        background: customization.isDarkMode ? 'transparent' : 'white'
                                                                    }}
                                                                    variant='outlined'
                                                                    color='error'
                                                                    key={index}
                                                                    startIcon={<IconX />}
                                                                    onClick={() => handleActionClick(elem, message.action)}
                                                                >
                                                                    {elem.type === 'agentflowv2-reject-button'
                                                                        ? '拒绝'
                                                                        : elem.label === 'No'
                                                                        ? '否'
                                                                        : elem.label}
                                                                </Button>
                                                            ) : (
                                                                <Button
                                                                    sx={{ width: 'max-content', borderRadius: '20px', background: 'white' }}
                                                                    variant='outlined'
                                                                    key={index}
                                                                    onClick={() => handleActionClick(elem, message.action)}
                                                                >
                                                                    {elem.label}
                                                                </Button>
                                                            )}
                                                        </>
                                                    )
                                                })}
                                            </div>
                                        )}
                                        {message.type === 'apiMessage' && message.id ? (
                                            <>
                                                <Box
                                                    sx={{
                                                        display: 'flex',
                                                        alignItems: 'center',
                                                        justifyContent: 'start',
                                                        gap: 1
                                                    }}
                                                >
                                                    {isTTSEnabled && (
                                                        <IconButton
                                                            size='small'
                                                            onClick={() =>
                                                                isTTSPlaying[message.id]
                                                                    ? handleTTSStop(message.id)
                                                                    : handleTTSClick(message.id, message.message)
                                                            }
                                                            disabled={isTTSLoading[message.id]}
                                                            sx={{
                                                                backgroundColor: ttsAudio[message.id] ? 'primary.main' : 'transparent',
                                                                color: ttsAudio[message.id] ? 'white' : 'inherit',
                                                                '&:hover': {
                                                                    backgroundColor: ttsAudio[message.id] ? 'primary.dark' : 'action.hover'
                                                                }
                                                            }}
                                                        >
                                                            {isTTSLoading[message.id] ? (
                                                                <CircularProgress size={16} />
                                                            ) : isTTSPlaying[message.id] ? (
                                                                <IconCircleDot style={{ width: '20px', height: '20px' }} color={'red'} />
                                                            ) : (
                                                                <IconVolume
                                                                    style={{ width: '20px', height: '20px' }}
                                                                    color={customization.isDarkMode ? 'white' : '#1e88e5'}
                                                                />
                                                            )}
                                                        </IconButton>
                                                    )}
                                                    {chatFeedbackStatus && (
                                                        <>
                                                            <CopyToClipboardButton
                                                                onClick={() => copyMessageToClipboard(message.message)}
                                                            />
                                                            {!message.feedback ||
                                                            message.feedback.rating === '' ||
                                                            message.feedback.rating === 'THUMBS_UP' ? (
                                                                <ThumbsUpButton
                                                                    isDisabled={message.feedback && message.feedback.rating === 'THUMBS_UP'}
                                                                    rating={message.feedback ? message.feedback.rating : ''}
                                                                    onClick={() => onThumbsUpClick(message.id)}
                                                                />
                                                            ) : null}
                                                            {!message.feedback ||
                                                            message.feedback.rating === '' ||
                                                            message.feedback.rating === 'THUMBS_DOWN' ? (
                                                                <ThumbsDownButton
                                                                    isDisabled={
                                                                        message.feedback && message.feedback.rating === 'THUMBS_DOWN'
                                                                    }
                                                                    rating={message.feedback ? message.feedback.rating : ''}
                                                                    onClick={() => onThumbsDownClick(message.id)}
                                                                />
                                                            ) : null}
                                                        </>
                                                    )}
                                                </Box>
                                            </>
                                        ) : null}
                                    </div>
                                </Box>
                            )
                        })}
                </div>
            </div>

            {messages && messages.length === 1 && starterPrompts.length > 0 && (
                <div style={{ position: 'relative' }}>
                    <StarterPromptsCard
                        sx={{ bottom: previews && previews.length > 0 ? 70 : 0 }}
                        starterPrompts={starterPrompts || []}
                        onPromptClick={handlePromptClick}
                        isGrid={isDialog}
                    />
                </div>
            )}

            {messages && messages.length > 2 && followUpPromptsStatus && followUpPrompts.length > 0 && (
                <>
                    <Divider sx={{ width: '100%' }} />
                    <Box sx={{ display: 'flex', flexDirection: 'column', position: 'relative', pt: 1.5 }}>
                        <Stack sx={{ flexDirection: 'row', alignItems: 'center', px: 1.5, gap: 0.5 }}>
                            <IconSparkles size={12} />
                            <Typography sx={{ fontSize: '0.75rem' }} variant='body2'>
                                试试这些提示词
                            </Typography>
                        </Stack>
                        <FollowUpPromptsCard
                            sx={{ bottom: previews && previews.length > 0 ? 70 : 0 }}
                            followUpPrompts={followUpPrompts || []}
                            onPromptClick={handleFollowUpPromptClick}
                            isGrid={isDialog}
                        />
                    </Box>
                </>
            )}

            <Divider sx={{ width: '100%' }} />

            <div className='center'>
                {previews && previews.length > 0 && (
                    <Box sx={{ width: '100%', mb: 1.5, display: 'flex', alignItems: 'center' }}>
                        {previews.map((item, index) => (
                            <Fragment key={index}>{previewDisplay(item)}</Fragment>
                        ))}
                    </Box>
                )}
                {isRecording ? (
                    <>
                        {recordingNotSupported ? (
                            <div className='overlay'>
                                <div className='browser-not-supporting-audio-recording-box'>
                                    <Typography variant='body1'>录音需要使用支持此功能的现代浏览器，例如 Chrome 或 Firefox。</Typography>
                                    <Button
                                        variant='contained'
                                        color='error'
                                        size='small'
                                        type='button'
                                        onClick={() => onRecordingCancelled()}
                                    >
                                        知道了
                                    </Button>
                                </div>
                            </div>
                        ) : (
                            <Box
                                sx={{
                                    width: '100%',
                                    height: '54px',
                                    px: 2,
                                    border: '1px solid',
                                    borderRadius: 3,
                                    backgroundColor: customization.isDarkMode ? '#32353b' : '#fafafa',
                                    borderColor: 'rgba(0, 0, 0, 0.23)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between'
                                }}
                            >
                                <div className='recording-elapsed-time'>
                                    <span className='red-recording-dot'>
                                        <IconCircleDot />
                                    </span>
                                    <Typography id='elapsed-time'>00:00</Typography>
                                    {isLoadingRecording && <Typography ml={1.5}>发送中……</Typography>}
                                </div>
                                <div className='recording-control-buttons-container'>
                                    <IconButton onClick={onRecordingCancelled} size='small'>
                                        <IconX
                                            color={loading || !chatflowid ? '#9e9e9e' : customization.isDarkMode ? 'white' : '#1e88e5'}
                                        />
                                    </IconButton>
                                    <IconButton onClick={onRecordingStopped} size='small'>
                                        <IconSend
                                            color={loading || !chatflowid ? '#9e9e9e' : customization.isDarkMode ? 'white' : '#1e88e5'}
                                        />
                                    </IconButton>
                                </div>
                            </Box>
                        )}
                    </>
                ) : (
                    <form style={{ width: '100%' }} onSubmit={handleSubmit}>
                        <OutlinedInput
                            inputRef={inputRef}
                            // eslint-disable-next-line
                            autoFocus
                            sx={{ width: '100%' }}
                            disabled={getInputDisabled()}
                            onKeyDown={handleEnter}
                            id='userInput'
                            name='userInput'
                            placeholder={loading ? '正在等待回复……' : '请输入您的问题……'}
                            value={userInput}
                            onChange={onChange}
                            multiline={true}
                            maxRows={isDialog ? 7 : 2}
                            startAdornment={
                                <>
                                    {isChatFlowAvailableForImageUploads && !isChatFlowAvailableForFileUploads && (
                                        <InputAdornment position='start' sx={{ ml: 2 }}>
                                            <IconButton
                                                onClick={handleImageUploadClick}
                                                type='button'
                                                disabled={getInputDisabled()}
                                                edge='start'
                                            >
                                                <IconPhotoPlus
                                                    color={getInputDisabled() ? '#9e9e9e' : customization.isDarkMode ? 'white' : '#1e88e5'}
                                                />
                                            </IconButton>
                                        </InputAdornment>
                                    )}
                                    {!isChatFlowAvailableForImageUploads && isChatFlowAvailableForFileUploads && (
                                        <InputAdornment position='start' sx={{ ml: 2 }}>
                                            <IconButton
                                                onClick={handleFileUploadClick}
                                                type='button'
                                                disabled={getInputDisabled()}
                                                edge='start'
                                            >
                                                <IconPaperclip
                                                    color={getInputDisabled() ? '#9e9e9e' : customization.isDarkMode ? 'white' : '#1e88e5'}
                                                />
                                            </IconButton>
                                        </InputAdornment>
                                    )}
                                    {isChatFlowAvailableForImageUploads && isChatFlowAvailableForFileUploads && (
                                        <InputAdornment position='start' sx={{ ml: 2 }}>
                                            <IconButton
                                                onClick={handleImageUploadClick}
                                                type='button'
                                                disabled={getInputDisabled()}
                                                edge='start'
                                            >
                                                <IconPhotoPlus
                                                    color={getInputDisabled() ? '#9e9e9e' : customization.isDarkMode ? 'white' : '#1e88e5'}
                                                />
                                            </IconButton>
                                            <IconButton
                                                sx={{ ml: 0 }}
                                                onClick={handleFileUploadClick}
                                                type='button'
                                                disabled={getInputDisabled()}
                                                edge='start'
                                            >
                                                <IconPaperclip
                                                    color={getInputDisabled() ? '#9e9e9e' : customization.isDarkMode ? 'white' : '#1e88e5'}
                                                />
                                            </IconButton>
                                        </InputAdornment>
                                    )}
                                    {!isChatFlowAvailableForImageUploads && !isChatFlowAvailableForFileUploads && <Box sx={{ pl: 1 }} />}
                                </>
                            }
                            endAdornment={
                                <>
                                    {isChatFlowAvailableForSpeech && (
                                        <InputAdornment position='end'>
                                            <IconButton
                                                onClick={() => onMicrophonePressed()}
                                                type='button'
                                                disabled={getInputDisabled()}
                                                edge='end'
                                            >
                                                <IconMicrophone
                                                    className={'start-recording-button'}
                                                    color={getInputDisabled() ? '#9e9e9e' : customization.isDarkMode ? 'white' : '#1e88e5'}
                                                />
                                            </IconButton>
                                        </InputAdornment>
                                    )}
                                    {!isAgentCanvas && (
                                        <InputAdornment position='end' sx={{ paddingRight: '15px' }}>
                                            <IconButton type='submit' disabled={getInputDisabled()} edge='end'>
                                                {loading ? (
                                                    <div>
                                                        <CircularProgress color='inherit' size={20} />
                                                    </div>
                                                ) : (
                                                    // Send icon SVG in input field
                                                    <IconSend
                                                        color={
                                                            getInputDisabled() ? '#9e9e9e' : customization.isDarkMode ? 'white' : '#1e88e5'
                                                        }
                                                    />
                                                )}
                                            </IconButton>
                                        </InputAdornment>
                                    )}
                                    {isAgentCanvas && (
                                        <>
                                            {!loading && (
                                                <InputAdornment position='end' sx={{ paddingRight: '15px' }}>
                                                    <IconButton type='submit' disabled={getInputDisabled()} edge='end'>
                                                        <IconSend
                                                            color={
                                                                getInputDisabled()
                                                                    ? '#9e9e9e'
                                                                    : customization.isDarkMode
                                                                    ? 'white'
                                                                    : '#1e88e5'
                                                            }
                                                        />
                                                    </IconButton>
                                                </InputAdornment>
                                            )}
                                            {loading && (
                                                <InputAdornment position='end' sx={{ padding: '15px', mr: 1 }}>
                                                    <IconButton
                                                        edge='end'
                                                        title={isMessageStopping ? '正在停止……' : '停止'}
                                                        style={{ border: !isMessageStopping ? '2px solid red' : 'none' }}
                                                        onClick={() => handleAbort()}
                                                        disabled={isMessageStopping}
                                                    >
                                                        {isMessageStopping ? (
                                                            <div>
                                                                <CircularProgress color='error' size={20} />
                                                            </div>
                                                        ) : (
                                                            <IconSquareFilled size={15} color='red' />
                                                        )}
                                                    </IconButton>
                                                </InputAdornment>
                                            )}
                                        </>
                                    )}
                                </>
                            }
                        />
                        {isChatFlowAvailableForImageUploads && (
                            <input
                                style={{ display: 'none' }}
                                multiple
                                ref={imgUploadRef}
                                type='file'
                                onChange={handleFileChange}
                                accept={imageUploadAllowedTypes || '*'}
                            />
                        )}
                        {isChatFlowAvailableForFileUploads && (
                            <input
                                style={{ display: 'none' }}
                                multiple
                                ref={fileUploadRef}
                                type='file'
                                onChange={handleFileChange}
                                accept={getFileUploadAllowedTypes()}
                            />
                        )}
                    </form>
                )}
            </div>
            <SourceDocDialog show={sourceDialogOpen} dialogProps={sourceDialogProps} onCancel={() => setSourceDialogOpen(false)} />
            <ChatFeedbackContentDialog
                show={showFeedbackContentDialog}
                onCancel={() => setShowFeedbackContentDialog(false)}
                onConfirm={submitFeedbackContent}
            />
            <Dialog
                maxWidth='md'
                fullWidth
                open={openFeedbackDialog}
                onClose={() => {
                    setOpenFeedbackDialog(false)
                    setPendingActionData(null)
                    setFeedback('')
                }}
            >
                <DialogTitle variant='h5'>提供反馈</DialogTitle>
                <DialogContent>
                    <TextField
                        // eslint-disable-next-line
                        autoFocus
                        margin='dense'
                        label='反馈内容'
                        fullWidth
                        multiline
                        rows={4}
                        value={feedback}
                        onChange={(e) => setFeedback(e.target.value)}
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={handleSubmitFeedback}>取消</Button>
                    <Button onClick={handleSubmitFeedback} variant='contained'>
                        提交
                    </Button>
                </DialogActions>
            </Dialog>
        </div>
    )
}

ChatMessage.propTypes = {
    open: PropTypes.bool,
    chatflowid: PropTypes.string,
    isAgentCanvas: PropTypes.bool,
    isDialog: PropTypes.bool,
    previews: PropTypes.array,
    setPreviews: PropTypes.func
}

export default memo(ChatMessage)
