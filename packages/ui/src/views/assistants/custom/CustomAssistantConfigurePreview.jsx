import { cloneDeep, set } from 'lodash'
import { memo, useEffect, useState, useRef } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate, useParams } from 'react-router-dom'
import { FullPageChat } from 'flowise-embed-react'
import PropTypes from 'prop-types'

// Hooks
import useApi from '@/hooks/useApi'
import useConfirm from '@/hooks/useConfirm'

// Material-UI
import { IconButton, Avatar, ButtonBase, Toolbar, Box, Button, Grid, OutlinedInput, Stack, Typography } from '@mui/material'
import { useTheme } from '@mui/material/styles'
import {
    IconCode,
    IconArrowLeft,
    IconDeviceFloppy,
    IconSettings,
    IconX,
    IconTrash,
    IconWand,
    IconArrowsMaximize
} from '@tabler/icons-react'

// Project import
import MainCard from '@/ui-component/cards/MainCard'
import { BackdropLoader } from '@/ui-component/loading/BackdropLoader'
import DocStoreInputHandler from '@/views/docstore/DocStoreInputHandler'
import { Dropdown } from '@/ui-component/dropdown/Dropdown'
import { StyledFab } from '@/ui-component/button/StyledFab'
import ErrorBoundary from '@/ErrorBoundary'
import { TooltipWithParser } from '@/ui-component/tooltip/TooltipWithParser'
import { MultiDropdown } from '@/ui-component/dropdown/MultiDropdown'
import APICodeDialog from '@/views/chatflows/APICodeDialog'
import ViewMessagesDialog from '@/ui-component/dialog/ViewMessagesDialog'
import ChatflowConfigurationDialog from '@/ui-component/dialog/ChatflowConfigurationDialog'
import ViewLeadsDialog from '@/ui-component/dialog/ViewLeadsDialog'
import Settings from '@/views/settings'
import ConfirmDialog from '@/ui-component/dialog/ConfirmDialog'
import PromptGeneratorDialog from '@/ui-component/dialog/PromptGeneratorDialog'
import { Available } from '@/ui-component/rbac/available'
import ExpandTextDialog from '@/ui-component/dialog/ExpandTextDialog'
import { SwitchInput } from '@/ui-component/switch/Switch'

// API
import assistantsApi from '@/api/assistants'
import nodesApi from '@/api/nodes'
import documentstoreApi from '@/api/documentstore'

// Const
import { baseURL } from '@/store/constant'
import { SET_CHATFLOW, closeSnackbar as closeSnackbarAction, enqueueSnackbar as enqueueSnackbarAction } from '@/store/actions'

// Utils
import { initNode, showHideInputParams } from '@/utils/genericHelper'
import { getErrorMessage } from '@/utils/getErrorMessage'
import useNotifier from '@/utils/useNotifier'
import { toolAgentFlow } from './toolAgentFlow'
import {
    CUSTOM_ASSISTANT_DEFAULT_INSTRUCTION,
    deriveCustomAssistantToolNodeId,
    deriveDocumentStoreRetrieverToolName,
    isExpectedCustomAssistantResource,
    isCustomAssistantBackingFlowReady,
    parseCustomAssistantDetails,
    validateCustomAssistantSaveResponse
} from './customAssistantDetails'

const CUSTOM_ASSISTANT_CONFLICT_MESSAGE = '助手或关联流程已在其他会话中更新。当前未保存内容已保留，请重新加载后再保存。'

// ===========================|| CustomAssistantConfigurePreview ||=========================== //

const MemoizedFullPageChat = memo(
    ({ ...props }) => (
        <div>
            <FullPageChat {...props}></FullPageChat>
        </div>
    ),
    (prevProps, nextProps) => prevProps.chatflow === nextProps.chatflow
)

MemoizedFullPageChat.displayName = 'MemoizedFullPageChat'

MemoizedFullPageChat.propTypes = {
    chatflow: PropTypes.object
}

const CustomAssistantConfigurePreview = () => {
    const navigate = useNavigate()
    const theme = useTheme()
    const settingsRef = useRef()
    const saveInFlightRef = useRef(false)
    const expectedBackingFlowIdRef = useRef()
    const customization = useSelector((state) => state.customization)

    const getSpecificAssistantApi = useApi(assistantsApi.getSpecificAssistant)
    const getChatModelsApi = useApi(assistantsApi.getChatModels)
    const getDocStoresApi = useApi(assistantsApi.getDocStores)
    const getToolsApi = useApi(assistantsApi.getTools)
    const getSpecificChatflowApi = useApi(assistantsApi.getCustomAssistantFlow)

    const { id: customAssistantId } = useParams()
    const expectedAssistantIdRef = useRef(customAssistantId)
    const routeLoadAbortControllerRef = useRef()

    const [chatModelsComponents, setChatModelsComponents] = useState([])
    const [chatModelsOptions, setChatModelsOptions] = useState([])
    const [selectedChatModel, setSelectedChatModel] = useState({})
    const [selectedCustomAssistant, setSelectedCustomAssistant] = useState({})
    const [customAssistantInstruction, setCustomAssistantInstruction] = useState(CUSTOM_ASSISTANT_DEFAULT_INSTRUCTION)
    const [customAssistantFlowId, setCustomAssistantFlowId] = useState()
    const [documentStoreOptions, setDocumentStoreOptions] = useState([])
    const [selectedDocumentStores, setSelectedDocumentStores] = useState([])
    const [toolComponents, setToolComponents] = useState([])
    const [toolOptions, setToolOptions] = useState([])
    const [selectedTools, setSelectedTools] = useState([])
    const [assistantSnapshot, setAssistantSnapshot] = useState(null)
    const [chatflowSnapshot, setChatflowSnapshot] = useState(null)
    const [validatedBackingFlow, setValidatedBackingFlow] = useState(null)
    const [loadedAssistantId, setLoadedAssistantId] = useState(null)

    const [apiDialogOpen, setAPIDialogOpen] = useState(false)
    const [apiDialogProps, setAPIDialogProps] = useState({})
    const [viewMessagesDialogOpen, setViewMessagesDialogOpen] = useState(false)
    const [viewMessagesDialogProps, setViewMessagesDialogProps] = useState({})
    const [viewLeadsDialogOpen, setViewLeadsDialogOpen] = useState(false)
    const [viewLeadsDialogProps, setViewLeadsDialogProps] = useState({})
    const [chatflowConfigurationDialogOpen, setChatflowConfigurationDialogOpen] = useState(false)
    const [chatflowConfigurationDialogProps, setChatflowConfigurationDialogProps] = useState({})
    const [isSettingsOpen, setSettingsOpen] = useState(false)
    const [assistantPromptGeneratorDialogOpen, setAssistantPromptGeneratorDialogOpen] = useState(false)
    const [assistantPromptGeneratorDialogProps, setAssistantPromptGeneratorDialogProps] = useState({})
    const [showExpandDialog, setShowExpandDialog] = useState(false)
    const [expandDialogProps, setExpandDialogProps] = useState({})

    const [loading, setLoading] = useState(false)
    const [loadingAssistant, setLoadingAssistant] = useState(true)
    const [error, setError] = useState(null)
    const [assistantDetailsError, setAssistantDetailsError] = useState(null)

    const isAssistantSnapshotReady =
        loadedAssistantId === customAssistantId &&
        assistantSnapshot?.type === 'CUSTOM' &&
        typeof assistantSnapshot.updatedDate === 'string' &&
        typeof assistantSnapshot.details === 'string'
    const isBackingFlowReady = isCustomAssistantBackingFlowReady(customAssistantFlowId, chatflowSnapshot)
    const activeBackingFlow =
        isBackingFlowReady && isCustomAssistantBackingFlowReady(customAssistantFlowId, validatedBackingFlow) ? validatedBackingFlow : null
    const isChatflowSnapshotReady =
        !customAssistantFlowId ||
        (isBackingFlowReady &&
            typeof chatflowSnapshot.updatedDate === 'string' &&
            typeof chatflowSnapshot.name === 'string' &&
            typeof chatflowSnapshot.flowData === 'string')
    const isSaveSnapshotReady = isAssistantSnapshotReady && isChatflowSnapshotReady
    const isSaveDisabled = loading || Boolean(assistantDetailsError) || !isSaveSnapshotReady

    const dispatch = useDispatch()
    const { confirm } = useConfirm()

    // ==============================|| Snackbar ||============================== //
    useNotifier()
    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))

    const handleChatModelDataChange = ({ inputParam, newValue }) => {
        setSelectedChatModel((prevData) => {
            const updatedData = { ...prevData }
            updatedData.inputs[inputParam.name] = newValue
            updatedData.inputParams = showHideInputParams(updatedData)
            return updatedData
        })
    }

    const handleToolDataChange =
        (toolIndex) =>
        ({ inputParam, newValue }) => {
            setSelectedTools((prevTools) => {
                const updatedTools = [...prevTools]
                const updatedTool = { ...updatedTools[toolIndex] }
                updatedTool.inputs[inputParam.name] = newValue
                updatedTool.inputParams = showHideInputParams(updatedTool)
                updatedTools[toolIndex] = updatedTool
                return updatedTools
            })
        }

    const displayWarning = () => {
        enqueueSnackbar({
            message: '请填写所有必填字段。',
            options: {
                key: new Date().getTime() + Math.random(),
                variant: 'warning',
                action: (key) => (
                    <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                        <IconX />
                    </Button>
                )
            }
        })
    }

    const checkInputParamsMandatory = () => {
        let canSubmit = true
        const visibleInputParams = showHideInputParams(selectedChatModel).filter(
            (inputParam) => !inputParam.hidden && inputParam.display !== false
        )
        for (const inputParam of visibleInputParams) {
            if (!inputParam.optional && (!selectedChatModel.inputs[inputParam.name] || !selectedChatModel.credential)) {
                if (inputParam.type === 'credential' && !selectedChatModel.credential) {
                    canSubmit = false
                    break
                } else if (inputParam.type !== 'credential' && !selectedChatModel.inputs[inputParam.name]) {
                    canSubmit = false
                    break
                }
            }
        }

        if (selectedTools.length > 0) {
            for (let i = 0; i < selectedTools.length; i++) {
                const tool = selectedTools[i]
                const visibleInputParams = showHideInputParams(tool).filter(
                    (inputParam) => !inputParam.hidden && inputParam.display !== false
                )
                for (const inputParam of visibleInputParams) {
                    if (!inputParam.optional && (!tool.inputs[inputParam.name] || !tool.credential)) {
                        if (inputParam.type === 'credential' && !tool.credential) {
                            canSubmit = false
                            break
                        } else if (inputParam.type !== 'credential' && !tool.inputs[inputParam.name]) {
                            canSubmit = false
                            break
                        }
                    }
                }
            }
        }

        return canSubmit
    }

    const checkMandatoryFields = () => {
        let canSubmit = true

        if (!selectedChatModel || !selectedChatModel.name) {
            canSubmit = false
        }

        canSubmit = checkInputParamsMandatory() && canSubmit

        if (selectedTools.some((tool) => !tool?.name)) {
            canSubmit = false
        }

        // check if any of the description is empty
        if (selectedDocumentStores.length > 0) {
            for (let i = 0; i < selectedDocumentStores.length; i++) {
                if (!selectedDocumentStores[i].description) {
                    canSubmit = false
                    break
                }
            }
        }

        if (!canSubmit) {
            displayWarning()
        }
        return canSubmit
    }

    const onSaveAndProcess = async () => {
        if (!saveInFlightRef.current && !isSaveDisabled && checkMandatoryFields()) {
            const targetAssistantId = loadedAssistantId
            if (!targetAssistantId || expectedAssistantIdRef.current !== targetAssistantId) return
            saveInFlightRef.current = true
            setLoading(true)
            try {
                const flowData = await prepareConfig()
                if (!flowData || expectedAssistantIdRef.current !== targetAssistantId) return
                const assistantDetails = {
                    ...selectedCustomAssistant,
                    chatModel: selectedChatModel,
                    instruction: customAssistantInstruction,
                    flowId: customAssistantFlowId,
                    documentStores: selectedDocumentStores,
                    tools: selectedTools
                }

                const serializedFlowData = JSON.stringify(flowData)
                const saveResp = await assistantsApi.saveCustomAssistant(
                    targetAssistantId,
                    {
                        expectedAssistant: assistantSnapshot,
                        expectedChatflow: chatflowSnapshot,
                        details: JSON.stringify(assistantDetails),
                        flowData: serializedFlowData
                    },
                    { signal: routeLoadAbortControllerRef.current?.signal }
                )
                if (expectedAssistantIdRef.current !== targetAssistantId) return
                const {
                    assistant: savedAssistant,
                    chatflow: savedChatflow,
                    details: savedDetails
                } = validateCustomAssistantSaveResponse(saveResp.data, {
                    assistantId: targetAssistantId,
                    expectedFlowData: serializedFlowData
                })
                setSelectedCustomAssistant(savedDetails)
                setSelectedChatModel(savedDetails.chatModel)
                setCustomAssistantInstruction(savedDetails.instruction)
                setCustomAssistantFlowId(savedDetails.flowId)
                setSelectedDocumentStores(savedDetails.documentStores)
                setSelectedTools(savedDetails.tools)
                expectedBackingFlowIdRef.current = savedDetails.flowId
                setAssistantSnapshot({
                    updatedDate: savedAssistant.updatedDate,
                    details: savedAssistant.details,
                    type: savedAssistant.type
                })
                setChatflowSnapshot({
                    id: savedChatflow.id,
                    updatedDate: savedChatflow.updatedDate,
                    name: savedChatflow.name,
                    flowData: savedChatflow.flowData,
                    type: savedChatflow.type
                })
                setValidatedBackingFlow(savedChatflow)
                setLoadedAssistantId(savedAssistant.id)
                dispatch({ type: SET_CHATFLOW, chatflow: savedChatflow })

                enqueueSnackbar({
                    message: '助手保存成功。',
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
                if (expectedAssistantIdRef.current !== targetAssistantId) return
                const isVersionConflict = (error?.response?.status ?? error?.status) === 409
                if (isVersionConflict) setAssistantDetailsError(CUSTOM_ASSISTANT_CONFLICT_MESSAGE)
                enqueueSnackbar({
                    message: isVersionConflict ? CUSTOM_ASSISTANT_CONFLICT_MESSAGE : `保存助手失败：${getErrorMessage(error, '未知错误')}`,
                    options: {
                        key: new Date().getTime() + Math.random(),
                        variant: 'error',
                        action: (key) => (
                            <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                                <IconX />
                            </Button>
                        )
                    }
                })
            } finally {
                saveInFlightRef.current = false
                if (expectedAssistantIdRef.current === targetAssistantId) setLoading(false)
            }
        }
    }

    const addTools = async (toolAgentId) => {
        const nodes = []
        const edges = []

        for (let i = 0; i < selectedTools.length; i++) {
            const tool = selectedTools[i]
            const toolId = deriveCustomAssistantToolNodeId(tool.name, i)
            const toolNodeData = cloneDeep(tool)
            set(toolNodeData, 'inputs', tool.inputs)

            const toolNodeObj = {
                id: toolId,
                data: {
                    ...toolNodeData,
                    id: toolId
                }
            }
            nodes.push(toolNodeObj)

            const toolEdge = {
                source: toolId,
                sourceHandle: `${toolId}-output-${tool.name}-Tool`,
                target: toolAgentId,
                targetHandle: `${toolAgentId}-input-tools-Tool`,
                type: 'buttonedge',
                id: `${toolId}-${toolId}-output-${tool.name}-Tool-${toolAgentId}-${toolAgentId}-input-tools-Tool`
            }
            edges.push(toolEdge)
        }

        return { nodes, edges }
    }

    const addDocStore = async (toolAgentId) => {
        const docStoreVSNode = await nodesApi.getSpecificNode('documentStoreVS')
        const retrieverToolNode = await nodesApi.getSpecificNode('retrieverTool')

        const nodes = []
        const edges = []

        for (let i = 0; i < selectedDocumentStores.length; i++) {
            const docStoreVSId = `documentStoreVS_${i}`
            const retrieverToolId = `retrieverTool_${i}`

            const docStoreVSNodeData = cloneDeep(initNode(docStoreVSNode.data, docStoreVSId))
            const retrieverToolNodeData = cloneDeep(initNode(retrieverToolNode.data, retrieverToolId))

            set(docStoreVSNodeData, 'inputs.selectedStore', selectedDocumentStores[i].id)
            set(docStoreVSNodeData, 'outputs.output', 'retriever')

            const docStoreOption = documentStoreOptions.find((ds) => ds.name === selectedDocumentStores[i].id)
            const name = deriveDocumentStoreRetrieverToolName(docStoreOption?.label, selectedDocumentStores[i].id, i)
            const desc = selectedDocumentStores[i].description || docStoreOption?.description || ''

            set(retrieverToolNodeData, 'inputs', {
                name,
                description: desc,
                retriever: `{{${docStoreVSId}.data.instance}}`,
                returnSourceDocuments: selectedDocumentStores[i].returnSourceDocuments ?? false
            })

            const docStoreVS = {
                id: docStoreVSId,
                data: {
                    ...docStoreVSNodeData,
                    id: docStoreVSId
                }
            }
            nodes.push(docStoreVS)

            const retrieverTool = {
                id: retrieverToolId,
                data: {
                    ...retrieverToolNodeData,
                    id: retrieverToolId
                }
            }
            nodes.push(retrieverTool)

            const docStoreVSEdge = {
                source: docStoreVSId,
                sourceHandle: `${docStoreVSId}-output-retriever-BaseRetriever`,
                target: retrieverToolId,
                targetHandle: `${retrieverToolId}-input-retriever-BaseRetriever`,
                type: 'buttonedge',
                id: `${docStoreVSId}-${docStoreVSId}-output-retriever-BaseRetriever-${retrieverToolId}-${retrieverToolId}-input-retriever-BaseRetriever`
            }
            edges.push(docStoreVSEdge)

            const retrieverToolEdge = {
                source: retrieverToolId,
                sourceHandle: `${retrieverToolId}-output-retrieverTool-RetrieverTool|DynamicTool|Tool|StructuredTool|Runnable`,
                target: toolAgentId,
                targetHandle: `${toolAgentId}-input-tools-Tool`,
                type: 'buttonedge',
                id: `${retrieverToolId}-${retrieverToolId}-output-retrieverTool-RetrieverTool|DynamicTool|Tool|StructuredTool|Runnable-${toolAgentId}-${toolAgentId}-input-tools-Tool`
            }
            edges.push(retrieverToolEdge)
        }

        return { nodes, edges }
    }

    const prepareConfig = async () => {
        try {
            const config = {}

            const nodes = toolAgentFlow.nodes
            const edges = toolAgentFlow.edges
            const chatModelId = `${selectedChatModel.name}_0`
            const existingChatModelId = nodes.find((node) => node.data.category === 'Chat Models')?.id

            // Replace Chat Model
            let filteredNodes = nodes.filter((node) => node.data.category !== 'Chat Models')
            const toBeReplaceNode = {
                id: chatModelId,
                data: {
                    ...selectedChatModel,
                    id: chatModelId
                }
            }
            filteredNodes.push(toBeReplaceNode)

            // Replace Tool Agent inputs
            const toolAgentNode = filteredNodes.find((node) => node.data.name === 'toolAgent')
            const toolAgentId = toolAgentNode.id
            set(toolAgentNode.data.inputs, 'model', `{{${chatModelId}}}`)
            set(toolAgentNode.data.inputs, 'systemMessage', `${customAssistantInstruction}`)

            const agentTools = []
            if (selectedDocumentStores.length > 0) {
                const retrieverTools = selectedDocumentStores.map((_, index) => `{{retrieverTool_${index}}}`)
                agentTools.push(...retrieverTools)
            }
            if (selectedTools.length > 0) {
                const tools = selectedTools.map((tool, index) => `{{${deriveCustomAssistantToolNodeId(tool.name, index)}}}`)
                agentTools.push(...tools)
            }
            set(toolAgentNode.data.inputs, 'tools', agentTools)

            filteredNodes = filteredNodes.map((node) => (node.id === toolAgentNode.id ? toolAgentNode : node))

            // Go through each edge and loop through each key. Check if the string value of each key includes/contains existingChatModelId, if yes replace with chatModelId
            let filteredEdges = edges.map((edge) => {
                const newEdge = { ...edge }
                Object.keys(newEdge).forEach((key) => {
                    if (newEdge[key].includes(existingChatModelId)) {
                        newEdge[key] = newEdge[key].replaceAll(existingChatModelId, chatModelId)
                    }
                })
                return newEdge
            })

            // Add Doc Store
            if (selectedDocumentStores.length > 0) {
                const { nodes: newNodes, edges: newEdges } = await addDocStore(toolAgentId)
                filteredNodes = [...filteredNodes, ...newNodes]
                filteredEdges = [...filteredEdges, ...newEdges]
            }

            // Add Tools
            if (selectedTools.length > 0) {
                const { nodes: newNodes, edges: newEdges } = await addTools(toolAgentId)
                filteredNodes = [...filteredNodes, ...newNodes]
                filteredEdges = [...filteredEdges, ...newEdges]
            }

            config.nodes = filteredNodes
            config.edges = filteredEdges

            return config
        } catch (error) {
            enqueueSnackbar({
                message: `保存助手失败：${getErrorMessage(error, '未知错误')}`,
                options: {
                    key: new Date().getTime() + Math.random(),
                    variant: 'error',
                    action: (key) => (
                        <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                            <IconX />
                        </Button>
                    )
                }
            })
            return undefined
        }
    }

    const onSettingsItemClick = (setting) => {
        setSettingsOpen(false)
        if (!isBackingFlowReady || !activeBackingFlow) return

        if (setting === 'deleteAssistant') {
            handleDeleteFlow()
        } else if (setting === 'viewMessages') {
            setViewMessagesDialogProps({
                title: '查看消息',
                chatflow: activeBackingFlow,
                isChatflow: false
            })
            setViewMessagesDialogOpen(true)
        } else if (setting === 'viewLeads') {
            setViewLeadsDialogProps({
                title: '查看线索',
                chatflow: activeBackingFlow
            })
            setViewLeadsDialogOpen(true)
        } else if (setting === 'chatflowConfiguration') {
            setChatflowConfigurationDialogProps({
                title: '助手配置',
                chatflow: activeBackingFlow
            })
            setChatflowConfigurationDialogOpen(true)
        }
    }

    const handleDeleteFlow = async () => {
        const targetAssistantId = loadedAssistantId
        if (
            !targetAssistantId ||
            expectedAssistantIdRef.current !== targetAssistantId ||
            !assistantSnapshot ||
            !chatflowSnapshot ||
            !isBackingFlowReady
        )
            return
        const deleteSnapshot = {
            expectedAssistant: assistantSnapshot,
            expectedChatflow: chatflowSnapshot
        }
        const confirmPayload = {
            title: '删除助手',
            description: `确定要删除“${selectedCustomAssistant.name}”吗？`,
            confirmButtonName: '删除',
            cancelButtonName: '取消'
        }
        const isConfirmed = await confirm(confirmPayload)

        if (isConfirmed && expectedAssistantIdRef.current === targetAssistantId) {
            try {
                await assistantsApi.deleteCustomAssistant(targetAssistantId, deleteSnapshot)
                if (expectedAssistantIdRef.current !== targetAssistantId) return
                navigate(-1)
            } catch (error) {
                if (expectedAssistantIdRef.current !== targetAssistantId) return
                const isConflict = error?.response?.status === 409
                enqueueSnackbar({
                    message: isConflict
                        ? '助手或关联流程已发生变化，请重新加载后重试。'
                        : `删除助手失败：${getErrorMessage(error, '未知错误')}`,
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
    }

    const onExpandDialogClicked = (value) => {
        const dialogProps = {
            value,
            inputParam: {
                label: '指令',
                name: 'instructions',
                type: 'string'
            },
            confirmButtonName: '保存',
            cancelButtonName: '取消'
        }
        setExpandDialogProps(dialogProps)
        setShowExpandDialog(true)
    }

    const generateDocStoreToolDesc = async (storeId) => {
        const isValid = checkInputParamsMandatory()
        if (!isValid) {
            displayWarning()
            return
        }

        try {
            setLoading(true)
            const selectedChatModelObj = {
                name: selectedChatModel.name,
                inputs: selectedChatModel.inputs
            }
            const resp = await documentstoreApi.generateDocStoreToolDesc(storeId, { selectedChatModel: selectedChatModelObj })

            if (resp.data) {
                setLoading(false)
                const content = resp.data?.content || resp.data.kwargs?.content
                // replace the description of the selected document store
                const newSelectedDocumentStores = selectedDocumentStores.map((ds) => {
                    if (ds.id === storeId) {
                        return {
                            ...ds,
                            description: content
                        }
                    }
                    return ds
                })
                setSelectedDocumentStores(newSelectedDocumentStores)
                enqueueSnackbar({
                    message: '文档库工具说明生成成功。',
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
        } catch (error) {
            setLoading(false)
            enqueueSnackbar({
                message: `生成文档库工具说明失败：${getErrorMessage(error, '未知错误')}`,
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

    const generateInstruction = async () => {
        const isValid = checkInputParamsMandatory()
        if (!isValid) {
            displayWarning()
            return
        }

        setAssistantPromptGeneratorDialogProps({
            title: '生成指令',
            description: '提供任务的基本信息，即可生成提示词模板。',
            data: { selectedChatModel }
        })
        setAssistantPromptGeneratorDialogOpen(true)
    }

    const onAPIDialogClick = () => {
        if (!isBackingFlowReady || !activeBackingFlow) return
        setAPIDialogProps({
            title: '嵌入网站或通过 API 使用',
            chatflowid: customAssistantFlowId,
            chatflowApiKeyId: activeBackingFlow.apikeyid,
            isSessionMemory: true
        })
        setAPIDialogOpen(true)
    }

    const onDocStoreItemSelected = (docStoreIds) => {
        const docStoresIds = JSON.parse(docStoreIds)
        const newSelectedDocumentStores = []
        for (const docStoreId of docStoresIds) {
            const foundSelectedDocumentStore = selectedDocumentStores.find((ds) => ds.id === docStoreId)
            const foundDocumentStoreOption = documentStoreOptions.find((ds) => ds.name === docStoreId)

            const newDocStore = {
                id: docStoreId,
                name: foundDocumentStoreOption?.label || '',
                description: foundSelectedDocumentStore?.description || foundDocumentStoreOption?.description || '',
                returnSourceDocuments: foundSelectedDocumentStore?.returnSourceDocuments ?? false
            }

            newSelectedDocumentStores.push(newDocStore)
        }
        setSelectedDocumentStores(newSelectedDocumentStores)
    }

    const onDocStoreItemDelete = (docStoreId) => {
        const newSelectedDocumentStores = selectedDocumentStores.filter((ds) => ds.id !== docStoreId)
        setSelectedDocumentStores(newSelectedDocumentStores)
    }

    useEffect(() => {
        getChatModelsApi.request()
        getDocStoresApi.request()
        getToolsApi.request()

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        if (getDocStoresApi.data) {
            // Set options
            const options = getDocStoresApi.data.map((ds) => ({
                label: ds.label,
                name: ds.name,
                description: ds.description
            }))
            setDocumentStoreOptions(options)
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getDocStoresApi.data])

    useEffect(() => {
        if (getToolsApi.data) {
            setToolComponents(getToolsApi.data)

            // Set options
            const options = getToolsApi.data.map((ds) => ({
                label: ds.label,
                name: ds.name,
                description: ds.description
            }))
            setToolOptions(options)
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getToolsApi.data])

    useEffect(() => {
        if (!getChatModelsApi.data) return

        setChatModelsComponents(getChatModelsApi.data)
        setChatModelsOptions(
            getChatModelsApi.data.map((chatModel) => ({
                label: chatModel.label,
                name: chatModel.name,
                imageSrc: `${baseURL}/api/v1/node-icon/${chatModel.name}`
            }))
        )
    }, [getChatModelsApi.data])

    useEffect(() => {
        routeLoadAbortControllerRef.current?.abort()
        const abortController = new AbortController()
        routeLoadAbortControllerRef.current = abortController
        expectedAssistantIdRef.current = customAssistantId
        expectedBackingFlowIdRef.current = undefined
        getSpecificAssistantApi.reset()
        getSpecificChatflowApi.reset()
        saveInFlightRef.current = false
        setLoadedAssistantId(null)
        setSelectedCustomAssistant({})
        setSelectedChatModel({})
        setCustomAssistantInstruction(CUSTOM_ASSISTANT_DEFAULT_INSTRUCTION)
        setCustomAssistantFlowId(undefined)
        setSelectedDocumentStores([])
        setSelectedTools([])
        setAssistantSnapshot(null)
        setChatflowSnapshot(null)
        setValidatedBackingFlow(null)
        setAssistantDetailsError(null)
        setError(null)
        setLoading(false)
        setAPIDialogOpen(false)
        setSettingsOpen(false)
        dispatch({ type: SET_CHATFLOW, chatflow: null })

        if (customAssistantId && getChatModelsApi.data) {
            setLoadingAssistant(true)
            getSpecificAssistantApi.request(customAssistantId, { signal: abortController.signal })
        } else {
            setLoadingAssistant(Boolean(customAssistantId))
        }

        return () => abortController.abort()

        // useApi request/reset are intentionally scoped by this route generation.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [customAssistantId, getChatModelsApi.data])

    useEffect(() => {
        if (getSpecificAssistantApi.data) {
            setLoadingAssistant(false)
            const expectedAssistantId = expectedAssistantIdRef.current
            if (
                expectedAssistantId !== customAssistantId ||
                !isExpectedCustomAssistantResource(expectedAssistantId, getSpecificAssistantApi.data)
            ) {
                setLoadedAssistantId(null)
                setAssistantSnapshot(null)
                setError('助手响应与当前页面不匹配，请重新加载后重试。')
                return
            }
            let assistantDetails
            try {
                assistantDetails = parseCustomAssistantDetails(getSpecificAssistantApi.data.details)
            } catch {
                setAssistantDetailsError('助手详情格式无效，已保留当前数据。请重新加载后再保存。')
                return
            }

            setAssistantDetailsError(null)
            setError(null)
            setLoadedAssistantId(expectedAssistantId)
            setSelectedCustomAssistant(assistantDetails)
            setSelectedChatModel(assistantDetails.chatModel)
            setCustomAssistantInstruction(assistantDetails.instruction)
            setCustomAssistantFlowId(assistantDetails.flowId)
            setSelectedDocumentStores(assistantDetails.documentStores)
            setSelectedTools(assistantDetails.tools)
            expectedBackingFlowIdRef.current = assistantDetails.flowId
            setAssistantSnapshot({
                updatedDate: getSpecificAssistantApi.data.updatedDate,
                details: getSpecificAssistantApi.data.details,
                type: getSpecificAssistantApi.data.type
            })
            setChatflowSnapshot(null)
            setValidatedBackingFlow(null)
            dispatch({ type: SET_CHATFLOW, chatflow: null })

            if (assistantDetails.flowId) {
                getSpecificChatflowApi.request(expectedAssistantId, { signal: routeLoadAbortControllerRef.current?.signal })
            }
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getSpecificAssistantApi.data])

    useEffect(() => {
        if (getSpecificChatflowApi.data) {
            const chatflow = getSpecificChatflowApi.data
            const expectedFlowId = expectedBackingFlowIdRef.current
            if (
                expectedAssistantIdRef.current !== customAssistantId ||
                loadedAssistantId !== customAssistantId ||
                !isCustomAssistantBackingFlowReady(expectedFlowId, chatflow) ||
                typeof chatflow.updatedDate !== 'string' ||
                typeof chatflow.name !== 'string' ||
                typeof chatflow.flowData !== 'string'
            ) {
                setChatflowSnapshot(null)
                setValidatedBackingFlow(null)
                dispatch({ type: SET_CHATFLOW, chatflow: null })
                setError('关联流程响应与当前助手不匹配，请重新加载后重试。')
                return
            }
            setError(null)
            dispatch({ type: SET_CHATFLOW, chatflow })
            setValidatedBackingFlow(chatflow)
            setChatflowSnapshot({
                id: chatflow.id,
                updatedDate: chatflow.updatedDate,
                name: chatflow.name,
                flowData: chatflow.flowData,
                type: chatflow.type
            })
        } else if (getSpecificChatflowApi.error) {
            setChatflowSnapshot(null)
            setValidatedBackingFlow(null)
            dispatch({ type: SET_CHATFLOW, chatflow: null })
            setError(`获取失败：${getErrorMessage(getSpecificChatflowApi.error, '未知错误')}`)
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getSpecificChatflowApi.data, getSpecificChatflowApi.error, customAssistantId, loadedAssistantId])

    useEffect(() => {
        if (getSpecificAssistantApi.error && expectedAssistantIdRef.current === customAssistantId) {
            setLoadingAssistant(false)
            setError(getSpecificAssistantApi.error)
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getSpecificAssistantApi.error])

    useEffect(() => {
        if (getChatModelsApi.error) {
            setError(getChatModelsApi.error)
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getChatModelsApi.error])

    useEffect(() => {
        if (getDocStoresApi.error) {
            setError(getDocStoresApi.error)
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getDocStoresApi.error])

    const defaultWidth = () => {
        if (isBackingFlowReady && activeBackingFlow && !loadingAssistant) {
            return 6
        }
        return 12
    }

    const pageHeight = () => {
        return window.innerHeight - 130
    }

    return (
        <>
            <MainCard>
                {error ? (
                    <ErrorBoundary error={error} />
                ) : (
                    <Stack flexDirection='column'>
                        {assistantDetailsError && (
                            <Typography role='alert' color='error' sx={{ mb: 2 }}>
                                {assistantDetailsError}
                            </Typography>
                        )}
                        <Box>
                            <Grid container spacing='2'>
                                <Grid item xs={12} md={defaultWidth()} lg={defaultWidth()} sm={defaultWidth()}>
                                    <div
                                        style={{
                                            display: 'flex',
                                            flexDirection: 'column',
                                            paddingRight: 15
                                        }}
                                    >
                                        <Box sx={{ flexGrow: 1, py: 1.25, width: '100%' }}>
                                            <Toolbar
                                                disableGutters={true}
                                                sx={{
                                                    p: 0,
                                                    display: 'flex',
                                                    justifyContent: 'space-between',
                                                    width: '100%'
                                                }}
                                            >
                                                <Box sx={{ display: 'flex', alignItems: 'center', flexDirection: 'row' }}>
                                                    <StyledFab
                                                        size='small'
                                                        color='secondary'
                                                        aria-label='返回'
                                                        title='返回'
                                                        onClick={() => navigate(-1)}
                                                    >
                                                        <IconArrowLeft />
                                                    </StyledFab>
                                                    <Typography sx={{ ml: 2, mr: 2 }} variant='h3'>
                                                        {selectedCustomAssistant?.name ?? ''}
                                                    </Typography>
                                                </Box>
                                                <div style={{ flex: 1 }}></div>
                                                {isBackingFlowReady && activeBackingFlow && !loadingAssistant && (
                                                    <ButtonBase
                                                        title='API 端点'
                                                        sx={{ borderRadius: '50%', mr: 2 }}
                                                        onClick={onAPIDialogClick}
                                                    >
                                                        <Avatar
                                                            variant='rounded'
                                                            sx={{
                                                                ...theme.typography.commonAvatar,
                                                                ...theme.typography.mediumAvatar,
                                                                transition: 'all .2s ease-in-out',
                                                                background: theme.palette.canvasHeader.deployLight,
                                                                color: theme.palette.canvasHeader.deployDark,
                                                                '&:hover': {
                                                                    background: theme.palette.canvasHeader.deployDark,
                                                                    color: theme.palette.canvasHeader.deployLight
                                                                }
                                                            }}
                                                            color='inherit'
                                                        >
                                                            <IconCode stroke={1.5} size='1.3rem' />
                                                        </Avatar>
                                                    </ButtonBase>
                                                )}
                                                <Available permission={'assistants:update'}>
                                                    <ButtonBase
                                                        title='保存'
                                                        sx={{ borderRadius: '50%', mr: 2 }}
                                                        disabled={isSaveDisabled}
                                                        onClick={onSaveAndProcess}
                                                    >
                                                        <Avatar
                                                            variant='rounded'
                                                            sx={{
                                                                ...theme.typography.commonAvatar,
                                                                ...theme.typography.mediumAvatar,
                                                                transition: 'all .2s ease-in-out',
                                                                background: theme.palette.canvasHeader.saveLight,
                                                                color: theme.palette.canvasHeader.saveDark,
                                                                '&:hover': {
                                                                    background: theme.palette.canvasHeader.saveDark,
                                                                    color: theme.palette.canvasHeader.saveLight
                                                                }
                                                            }}
                                                            color='inherit'
                                                        >
                                                            <IconDeviceFloppy stroke={1.5} size='1.3rem' />
                                                        </Avatar>
                                                    </ButtonBase>
                                                </Available>
                                                {isBackingFlowReady && activeBackingFlow && !loadingAssistant && (
                                                    <ButtonBase
                                                        ref={settingsRef}
                                                        title='设置'
                                                        sx={{ borderRadius: '50%' }}
                                                        onClick={() => setSettingsOpen(!isSettingsOpen)}
                                                    >
                                                        <Avatar
                                                            variant='rounded'
                                                            sx={{
                                                                ...theme.typography.commonAvatar,
                                                                ...theme.typography.mediumAvatar,
                                                                transition: 'all .2s ease-in-out',
                                                                background: theme.palette.canvasHeader.settingsLight,
                                                                color: theme.palette.canvasHeader.settingsDark,
                                                                '&:hover': {
                                                                    background: theme.palette.canvasHeader.settingsDark,
                                                                    color: theme.palette.canvasHeader.settingsLight
                                                                }
                                                            }}
                                                        >
                                                            <IconSettings stroke={1.5} size='1.3rem' />
                                                        </Avatar>
                                                    </ButtonBase>
                                                )}
                                                {!customAssistantFlowId && !loadingAssistant && (
                                                    <Available permission={'assistants:delete'}>
                                                        <ButtonBase ref={settingsRef} title='删除助手' sx={{ borderRadius: '50%' }}>
                                                            <Avatar
                                                                variant='rounded'
                                                                sx={{
                                                                    ...theme.typography.commonAvatar,
                                                                    ...theme.typography.mediumAvatar,
                                                                    transition: 'all .2s ease-in-out',
                                                                    background: theme.palette.error.light,
                                                                    color: theme.palette.error.dark,
                                                                    '&:hover': {
                                                                        background: theme.palette.error.dark,
                                                                        color: theme.palette.error.light
                                                                    }
                                                                }}
                                                                onClick={handleDeleteFlow}
                                                            >
                                                                <IconTrash stroke={1.5} size='1.3rem' />
                                                            </Avatar>
                                                        </ButtonBase>
                                                    </Available>
                                                )}
                                            </Toolbar>
                                        </Box>
                                        <Box
                                            sx={{
                                                p: 2,
                                                mt: 1,
                                                mb: 1,
                                                border: 1,
                                                borderColor: theme.palette.grey[900] + 25,
                                                borderRadius: 2
                                            }}
                                        >
                                            <div style={{ display: 'flex', flexDirection: 'row' }}>
                                                <Typography>
                                                    选择模型<span style={{ color: 'red' }}>&nbsp;*</span>
                                                </Typography>
                                            </div>
                                            <Dropdown
                                                key={JSON.stringify(selectedChatModel)}
                                                name={'chatModel'}
                                                options={chatModelsOptions ?? []}
                                                onSelect={(newValue) => {
                                                    if (!newValue) {
                                                        setSelectedChatModel({})
                                                    } else {
                                                        const foundChatComponent = chatModelsComponents.find(
                                                            (chatModel) => chatModel.name === newValue
                                                        )
                                                        if (foundChatComponent) {
                                                            const chatModelId = `${foundChatComponent.name}_0`
                                                            const clonedComponent = cloneDeep(foundChatComponent)
                                                            const initChatModelData = initNode(clonedComponent, chatModelId)
                                                            setSelectedChatModel(initChatModelData)
                                                        }
                                                    }
                                                }}
                                                value={selectedChatModel ? selectedChatModel?.name : 'choose an option'}
                                            />
                                        </Box>
                                        <Box
                                            sx={{
                                                p: 2,
                                                mt: 1,
                                                mb: 1,
                                                border: 1,
                                                borderColor: theme.palette.grey[900] + 25,
                                                borderRadius: 2
                                            }}
                                        >
                                            <Stack sx={{ position: 'relative', alignItems: 'center' }} direction='row'>
                                                <Typography>
                                                    指令<span style={{ color: 'red' }}>&nbsp;*</span>
                                                </Typography>
                                                <div style={{ flex: 1 }}></div>
                                                <IconButton
                                                    size='small'
                                                    sx={{
                                                        height: 25,
                                                        width: 25
                                                    }}
                                                    title='展开'
                                                    color='secondary'
                                                    onClick={() => onExpandDialogClicked(customAssistantInstruction)}
                                                >
                                                    <IconArrowsMaximize />
                                                </IconButton>
                                                {selectedChatModel?.name && (
                                                    <Button
                                                        title='使用模型生成指令'
                                                        sx={{ borderRadius: 20 }}
                                                        size='small'
                                                        variant='text'
                                                        onClick={() => generateInstruction()}
                                                        startIcon={<IconWand size={20} />}
                                                    >
                                                        生成
                                                    </Button>
                                                )}
                                            </Stack>
                                            <OutlinedInput
                                                sx={{ mt: 1, width: '100%' }}
                                                type={'text'}
                                                multiline={true}
                                                rows={6}
                                                value={customAssistantInstruction}
                                                onChange={(event) => setCustomAssistantInstruction(event.target.value)}
                                            />
                                        </Box>
                                        <Box
                                            sx={{
                                                p: 2,
                                                mt: 1,
                                                mb: 1,
                                                border: 1,
                                                borderColor: theme.palette.grey[900] + 25,
                                                borderRadius: 2
                                            }}
                                        >
                                            <Stack sx={{ position: 'relative', alignItems: 'center' }} direction='row'>
                                                <Typography>知识（文档库）</Typography>
                                                <TooltipWithParser title='为助手提供来自不同文档库的上下文。使用前需先完成文档库数据写入。' />
                                            </Stack>
                                            <MultiDropdown
                                                key={JSON.stringify(selectedDocumentStores)}
                                                name={JSON.stringify(selectedDocumentStores)}
                                                options={documentStoreOptions ?? []}
                                                onSelect={(newValue) => {
                                                    if (!newValue) {
                                                        setSelectedDocumentStores([])
                                                    } else {
                                                        onDocStoreItemSelected(newValue)
                                                    }
                                                }}
                                                value={selectedDocumentStores.map((ds) => ds.id) ?? 'choose an option'}
                                            />
                                            {selectedDocumentStores.length > 0 && (
                                                <Stack sx={{ mt: 3, position: 'relative', alignItems: 'center' }} direction='row'>
                                                    <Typography>
                                                        知识库说明<span style={{ color: 'red' }}>&nbsp;*</span>
                                                    </Typography>
                                                    <TooltipWithParser title='说明文档库包含的内容，帮助人工智能判断何时以及如何检索正确信息。' />
                                                </Stack>
                                            )}
                                            {selectedDocumentStores.map((ds, index) => {
                                                return (
                                                    <Box sx={{ mt: 1, mb: 2 }} key={index}>
                                                        <Stack sx={{ position: 'relative', alignItems: 'center' }} direction='row'>
                                                            <div
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
                                                                <span style={{ color: 'rgb(116,66,16)', marginRight: 10 }}>{ds.name}</span>
                                                                <IconButton
                                                                    sx={{ height: 15, width: 15, p: 0 }}
                                                                    onClick={() => onDocStoreItemDelete(ds.id)}
                                                                >
                                                                    <IconX />
                                                                </IconButton>
                                                            </div>
                                                            <div style={{ flex: 1 }}></div>
                                                            {selectedChatModel?.name && (
                                                                <Available permission='documentStores:upsert-config'>
                                                                    <Button
                                                                        title='使用模型生成说明'
                                                                        sx={{ borderRadius: 20 }}
                                                                        size='small'
                                                                        variant='text'
                                                                        onClick={() => generateDocStoreToolDesc(ds.id)}
                                                                        startIcon={<IconWand size={20} />}
                                                                    >
                                                                        生成
                                                                    </Button>
                                                                </Available>
                                                            )}
                                                        </Stack>
                                                        <OutlinedInput
                                                            sx={{ mt: 1, width: '100%' }}
                                                            type={'text'}
                                                            multiline={true}
                                                            rows={3}
                                                            value={ds.description}
                                                            onChange={(event) => {
                                                                const newSelectedDocumentStores = [...selectedDocumentStores]
                                                                newSelectedDocumentStores[index].description = event.target.value
                                                                setSelectedDocumentStores(newSelectedDocumentStores)
                                                            }}
                                                        />
                                                        <Stack sx={{ mt: 2, position: 'relative', alignItems: 'center' }} direction='row'>
                                                            <Typography>返回来源文档</Typography>
                                                            <TooltipWithParser title='返回用于回答问题的原始文档' />
                                                        </Stack>
                                                        <SwitchInput
                                                            value={ds.returnSourceDocuments ?? false}
                                                            onChange={(newValue) => {
                                                                const newSelectedDocumentStores = [...selectedDocumentStores]
                                                                newSelectedDocumentStores[index].returnSourceDocuments = newValue
                                                                setSelectedDocumentStores(newSelectedDocumentStores)
                                                            }}
                                                        />
                                                    </Box>
                                                )
                                            })}
                                        </Box>
                                        {selectedChatModel && Object.keys(selectedChatModel).length > 0 && (
                                            <Box
                                                sx={{
                                                    p: 0,
                                                    mt: 1,
                                                    mb: 1,
                                                    border: 1,
                                                    borderColor: theme.palette.grey[900] + 25,
                                                    borderRadius: 2
                                                }}
                                            >
                                                {showHideInputParams(selectedChatModel)
                                                    .filter((inputParam) => !inputParam.hidden && inputParam.display !== false)
                                                    .map((inputParam, index) => (
                                                        <DocStoreInputHandler
                                                            key={index}
                                                            inputParam={inputParam}
                                                            data={selectedChatModel}
                                                            onNodeDataChange={handleChatModelDataChange}
                                                        />
                                                    ))}
                                            </Box>
                                        )}
                                        <Box
                                            sx={{
                                                p: 2,
                                                mt: 1,
                                                mb: 1,
                                                border: 1,
                                                borderColor: theme.palette.grey[900] + 25,
                                                borderRadius: 2
                                            }}
                                        >
                                            <Stack sx={{ position: 'relative', alignItems: 'center' }} direction='row'>
                                                <Typography>工具</Typography>
                                                <TooltipWithParser title='工具是您的助手可以执行的操作' />
                                            </Stack>
                                            {selectedTools.map((tool, index) => {
                                                return (
                                                    <Box
                                                        sx={{
                                                            border: 1,
                                                            borderColor: theme.palette.grey[900] + 25,
                                                            borderRadius: 2,
                                                            mt: 2,
                                                            mb: 2
                                                        }}
                                                        key={index}
                                                    >
                                                        <Box sx={{ pl: 2, pr: 2, pt: 2, pb: 0 }}>
                                                            <div style={{ display: 'flex', flexDirection: 'row' }}>
                                                                <Typography>
                                                                    工具<span style={{ color: 'red' }}>&nbsp;*</span>
                                                                </Typography>
                                                                <div style={{ flex: 1 }}></div>
                                                                <IconButton
                                                                    aria-label='删除工具'
                                                                    color='error'
                                                                    sx={{ height: 15, width: 15, p: 0 }}
                                                                    onClick={() => {
                                                                        const newSelectedTools = selectedTools.filter((t, i) => i !== index)
                                                                        setSelectedTools(newSelectedTools)
                                                                    }}
                                                                >
                                                                    <IconTrash />
                                                                </IconButton>
                                                            </div>
                                                            <Dropdown
                                                                key={JSON.stringify(tool)}
                                                                name={tool.name}
                                                                options={toolOptions ?? []}
                                                                onSelect={(newValue) => {
                                                                    if (!newValue) {
                                                                        const newSelectedTools = [...selectedTools]
                                                                        newSelectedTools[index] = {}
                                                                        setSelectedTools(newSelectedTools)
                                                                    } else {
                                                                        const foundToolComponent = toolComponents.find(
                                                                            (tool) => tool.name === newValue
                                                                        )
                                                                        if (foundToolComponent) {
                                                                            const toolId = `${foundToolComponent.name}_${index}`
                                                                            const clonedComponent = cloneDeep(foundToolComponent)
                                                                            const initToolData = initNode(clonedComponent, toolId)
                                                                            const newSelectedTools = [...selectedTools]
                                                                            newSelectedTools[index] = initToolData
                                                                            setSelectedTools(newSelectedTools)
                                                                        }
                                                                    }
                                                                }}
                                                                value={tool?.name || 'choose an option'}
                                                            />
                                                        </Box>
                                                        {tool && Object.keys(tool).length === 0 && (
                                                            <Box sx={{ pl: 2, pr: 2, pt: 0, pb: 2 }} />
                                                        )}
                                                        {tool && Object.keys(tool).length > 0 && (
                                                            <Box
                                                                sx={{
                                                                    p: 0,
                                                                    mt: 2,
                                                                    mb: 1
                                                                }}
                                                            >
                                                                {showHideInputParams(tool)
                                                                    .filter(
                                                                        (inputParam) => !inputParam.hidden && inputParam.display !== false
                                                                    )
                                                                    .map((inputParam, inputIndex) => (
                                                                        <DocStoreInputHandler
                                                                            key={inputIndex}
                                                                            inputParam={inputParam}
                                                                            data={tool}
                                                                            onNodeDataChange={handleToolDataChange(index)}
                                                                        />
                                                                    ))}
                                                            </Box>
                                                        )}
                                                    </Box>
                                                )
                                            })}
                                            <Button
                                                fullWidth
                                                title='添加工具'
                                                sx={{ mt: 1, mb: 1, borderRadius: 20 }}
                                                variant='outlined'
                                                onClick={() => setSelectedTools([...selectedTools, {}])}
                                            >
                                                添加工具
                                            </Button>
                                        </Box>
                                        {selectedChatModel && Object.keys(selectedChatModel).length > 0 && (
                                            <Available permission={'assistants:update'}>
                                                <Button
                                                    fullWidth
                                                    title='保存助手'
                                                    sx={{
                                                        mt: 1,
                                                        mb: 1,
                                                        borderRadius: 20,
                                                        background: 'linear-gradient(45deg, #673ab7 30%, #1e88e5 90%)'
                                                    }}
                                                    variant='contained'
                                                    disabled={isSaveDisabled}
                                                    onClick={onSaveAndProcess}
                                                >
                                                    保存助手
                                                </Button>
                                            </Available>
                                        )}
                                    </div>
                                </Grid>
                                {isBackingFlowReady && activeBackingFlow && !loadingAssistant && (
                                    <Grid item xs={12} md={6} lg={6} sm={6}>
                                        <Box sx={{ mt: 2 }}>
                                            {customization.isDarkMode && (
                                                <MemoizedFullPageChat
                                                    chatflowid={customAssistantFlowId}
                                                    chatflow={activeBackingFlow}
                                                    apiHost={baseURL}
                                                    chatflowConfig={{}}
                                                    theme={{
                                                        button: {
                                                            backgroundColor: '#32353b',
                                                            iconColor: '#ffffff'
                                                        },
                                                        chatWindow: {
                                                            height: pageHeight(),
                                                            showTitle: true,
                                                            backgroundColor: '#23262c',
                                                            title: '  预览',
                                                            welcomeMessage: '您好！有什么可以帮您？',
                                                            errorMessage: '抱歉，处理请求时出现错误，请稍后重试。',
                                                            botMessage: {
                                                                backgroundColor: '#32353b',
                                                                textColor: '#ffffff'
                                                            },
                                                            userMessage: {
                                                                backgroundColor: '#191b1f',
                                                                textColor: '#ffffff'
                                                            },
                                                            textInput: {
                                                                placeholder: '请输入您的问题',
                                                                backgroundColor: '#32353b',
                                                                textColor: '#ffffff'
                                                            },
                                                            footer: {
                                                                showFooter: false
                                                            }
                                                        }
                                                    }}
                                                />
                                            )}
                                            {!customization.isDarkMode && (
                                                <MemoizedFullPageChat
                                                    chatflowid={customAssistantFlowId}
                                                    chatflow={activeBackingFlow}
                                                    apiHost={baseURL}
                                                    chatflowConfig={{}}
                                                    theme={{
                                                        button: {
                                                            backgroundColor: '#eeeeee',
                                                            iconColor: '#333333'
                                                        },
                                                        chatWindow: {
                                                            height: pageHeight(),
                                                            showTitle: true,
                                                            backgroundColor: '#fafafa',
                                                            title: '  预览',
                                                            welcomeMessage: '您好！有什么可以帮您？',
                                                            errorMessage: '抱歉，处理请求时出现错误，请稍后重试。',
                                                            botMessage: {
                                                                backgroundColor: '#ffffff',
                                                                textColor: '#303235'
                                                            },
                                                            userMessage: {
                                                                backgroundColor: '#f7f8ff',
                                                                textColor: '#303235'
                                                            },
                                                            textInput: {
                                                                placeholder: '请输入您的问题',
                                                                backgroundColor: '#ffffff',
                                                                textColor: '#303235'
                                                            },
                                                            footer: {
                                                                showFooter: false
                                                            }
                                                        }
                                                    }}
                                                />
                                            )}
                                        </Box>
                                    </Grid>
                                )}
                            </Grid>
                        </Box>
                    </Stack>
                )}
            </MainCard>
            {loading && <BackdropLoader open={loading} />}
            {apiDialogOpen && isBackingFlowReady && activeBackingFlow && (
                <APICodeDialog show={apiDialogOpen} dialogProps={apiDialogProps} onCancel={() => setAPIDialogOpen(false)} />
            )}
            {isSettingsOpen && isBackingFlowReady && activeBackingFlow && (
                <Settings
                    chatflow={activeBackingFlow}
                    isSettingsOpen={isSettingsOpen}
                    anchorEl={settingsRef.current}
                    onClose={() => setSettingsOpen(false)}
                    onSettingsItemClick={onSettingsItemClick}
                    isCustomAssistant={true}
                />
            )}
            {isBackingFlowReady && activeBackingFlow && (
                <>
                    <ViewMessagesDialog
                        show={viewMessagesDialogOpen}
                        dialogProps={viewMessagesDialogProps}
                        onCancel={() => setViewMessagesDialogOpen(false)}
                    />
                    <ViewLeadsDialog
                        show={viewLeadsDialogOpen}
                        dialogProps={viewLeadsDialogProps}
                        onCancel={() => setViewLeadsDialogOpen(false)}
                    />
                    <ChatflowConfigurationDialog
                        key='chatflowConfiguration'
                        show={chatflowConfigurationDialogOpen}
                        dialogProps={chatflowConfigurationDialogProps}
                        onCancel={() => setChatflowConfigurationDialogOpen(false)}
                    />
                </>
            )}
            <PromptGeneratorDialog
                show={assistantPromptGeneratorDialogOpen}
                dialogProps={assistantPromptGeneratorDialogProps}
                onCancel={() => setAssistantPromptGeneratorDialogOpen(false)}
                onConfirm={(generatedInstruction) => {
                    setCustomAssistantInstruction(generatedInstruction)
                    setAssistantPromptGeneratorDialogOpen(false)
                }}
            />
            <ExpandTextDialog
                show={showExpandDialog}
                dialogProps={expandDialogProps}
                onCancel={() => setShowExpandDialog(false)}
                onConfirm={(newValue) => {
                    setCustomAssistantInstruction(newValue)
                    setShowExpandDialog(false)
                }}
            ></ExpandTextDialog>
            <ConfirmDialog />
        </>
    )
}

export default CustomAssistantConfigurePreview
