import { useEffect, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import * as PropTypes from 'prop-types'
import { useNavigate, useParams } from 'react-router-dom'

// material-ui
import {
    Box,
    Stack,
    Typography,
    TableContainer,
    Paper,
    Table,
    TableHead,
    TableRow,
    TableCell,
    TableBody,
    Chip,
    Menu,
    MenuItem,
    Divider,
    Button,
    Skeleton
} from '@mui/material'
import { alpha, styled, useTheme } from '@mui/material/styles'
import { tableCellClasses } from '@mui/material/TableCell'

// project imports
import MainCard from '@/ui-component/cards/MainCard'
import AddDocStoreDialog from '@/views/docstore/AddDocStoreDialog'
import { BackdropLoader } from '@/ui-component/loading/BackdropLoader'
import DocumentLoaderListDialog from '@/views/docstore/DocumentLoaderListDialog'
import ErrorBoundary from '@/ErrorBoundary'
import { StyledButton } from '@/ui-component/button/StyledButton'
import ViewHeader from '@/layout/MainLayout/ViewHeader'
import DeleteDocStoreDialog from './DeleteDocStoreDialog'
import { Available } from '@/ui-component/rbac/available'
import { PermissionIconButton, StyledPermissionButton } from '@/ui-component/button/RBACButtons'
import DocumentStoreStatus from '@/views/docstore/DocumentStoreStatus'
import ConfirmDialog from '@/ui-component/dialog/ConfirmDialog'
import DocStoreAPIDialog from './DocStoreAPIDialog'

// API
import documentsApi, {
    DOCUMENT_STORE_VERSION_CONFLICT_MESSAGE,
    isDocumentStoreVersionConflict,
    requireDocumentStoreVersionToken
} from '@/api/documentstore'

// Hooks
import useApi from '@/hooks/useApi'
import useNotifier from '@/utils/useNotifier'
import { useAuth } from '@/hooks/useAuth'
import { getFileName } from '@/utils/genericHelper'
import { getErrorMessage } from '@/utils/getErrorMessage'
import useConfirm from '@/hooks/useConfirm'

// icons
import { IconPlus, IconRefresh, IconX, IconVectorBezier2 } from '@tabler/icons-react'
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown'
import FileDeleteIcon from '@mui/icons-material/Delete'
import FileEditIcon from '@mui/icons-material/Edit'
import FileChunksIcon from '@mui/icons-material/AppRegistration'
import NoteAddIcon from '@mui/icons-material/NoteAdd'
import SearchIcon from '@mui/icons-material/Search'
import RefreshIcon from '@mui/icons-material/Refresh'
import CodeIcon from '@mui/icons-material/Code'
import doc_store_details_emptySVG from '@/assets/images/doc_store_details_empty.svg'

// store
import { closeSnackbar as closeSnackbarAction, enqueueSnackbar as enqueueSnackbarAction } from '@/store/actions'
import { useError } from '@/store/context/ErrorContext'

// ==============================|| DOCUMENTS ||============================== //

const StyledTableCell = styled(TableCell)(({ theme }) => ({
    borderColor: theme.palette.grey[900] + 25,
    padding: '6px 16px',

    [`&.${tableCellClasses.head}`]: {
        color: theme.palette.grey[900]
    },
    [`&.${tableCellClasses.body}`]: {
        fontSize: 14,
        height: 64
    }
}))

const StyledTableRow = styled(TableRow)(() => ({
    // hide last border
    '&:last-child td, &:last-child th': {
        border: 0
    }
}))

const StyledMenu = styled((props) => (
    <Menu
        elevation={0}
        anchorOrigin={{
            vertical: 'bottom',
            horizontal: 'right'
        }}
        transformOrigin={{
            vertical: 'top',
            horizontal: 'right'
        }}
        {...props}
    />
))(({ theme }) => ({
    '& .MuiPaper-root': {
        borderRadius: 6,
        marginTop: theme.spacing(1),
        minWidth: 180,
        boxShadow:
            'rgb(255, 255, 255) 0px 0px 0px 0px, rgba(0, 0, 0, 0.05) 0px 0px 0px 1px, rgba(0, 0, 0, 0.1) 0px 10px 15px -3px, rgba(0, 0, 0, 0.05) 0px 4px 6px -2px',
        '& .MuiMenu-list': {
            padding: '4px 0'
        },
        '& .MuiMenuItem-root': {
            '& .MuiSvgIcon-root': {
                fontSize: 18,
                color: theme.palette.text.secondary,
                marginRight: theme.spacing(1.5)
            },
            '&:active': {
                backgroundColor: alpha(theme.palette.primary.main, theme.palette.action.selectedOpacity)
            }
        }
    }
}))

const DocumentStoreDetails = () => {
    const theme = useTheme()
    const customization = useSelector((state) => state.customization)
    const navigate = useNavigate()
    const dispatch = useDispatch()
    const { hasAssignedWorkspace } = useAuth()
    useNotifier()
    const { confirm } = useConfirm()

    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))
    const { error, setError } = useError()
    const { hasPermission } = useAuth()

    const getSpecificDocumentStore = useApi(documentsApi.getSpecificDocumentStore)

    const [isLoading, setLoading] = useState(true)
    const [isBackdropLoading, setBackdropLoading] = useState(false)
    const [showDialog, setShowDialog] = useState(false)
    const [documentStore, setDocumentStore] = useState({})
    const [dialogProps, setDialogProps] = useState({})
    const [showDocumentLoaderListDialog, setShowDocumentLoaderListDialog] = useState(false)
    const [documentLoaderListDialogProps, setDocumentLoaderListDialogProps] = useState({})
    const [showDeleteDocStoreDialog, setShowDeleteDocStoreDialog] = useState(false)
    const [deleteDocStoreDialogProps, setDeleteDocStoreDialogProps] = useState({})
    const [showDocStoreAPIDialog, setShowDocStoreAPIDialog] = useState(false)
    const [docStoreAPIDialogProps, setDocStoreAPIDialogProps] = useState({})

    const [anchorEl, setAnchorEl] = useState(null)
    const open = Boolean(anchorEl)

    const { storeId } = useParams()

    const openPreviewSettings = (id) => {
        navigate('/document-stores/' + storeId + '/' + id)
    }

    const showStoredChunks = (id) => {
        navigate('/document-stores/chunks/' + storeId + '/' + id)
    }

    const showVectorStoreQuery = (id) => {
        navigate('/document-stores/query/' + id)
    }

    const onDocLoaderSelected = (docLoaderComponentName) => {
        setShowDocumentLoaderListDialog(false)
        navigate('/document-stores/' + storeId + '/' + docLoaderComponentName)
    }

    const showVectorStore = (id) => {
        navigate('/document-stores/vector/' + id)
    }

    const listLoaders = () => {
        const dialogProp = {
            title: '选择文档加载器'
        }
        setDocumentLoaderListDialogProps(dialogProp)
        setShowDocumentLoaderListDialog(true)
    }

    const onDocStoreDelete = async (type, file) => {
        setBackdropLoading(true)
        if (type === 'STORE') {
            try {
                const versionToken = requireDocumentStoreVersionToken(documentStore)
                const deleteResp = await documentsApi.deleteDocumentStore(storeId, versionToken)
                setBackdropLoading(false)
                if (deleteResp.data) {
                    setShowDeleteDocStoreDialog(false)
                    enqueueSnackbar({
                        message: documentStore.vectorStoreConfig
                            ? '本地文档库、加载器和分块已删除；外部向量服务中的数据未自动清理'
                            : '本地文档库、加载器和分块已删除',
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
                    navigate('/document-stores/')
                }
            } catch (error) {
                setBackdropLoading(false)
                if (isDocumentStoreVersionConflict(error)) {
                    setShowDeleteDocStoreDialog(false)
                    setDocumentStore((current) => ({ ...current, versionToken: undefined }))
                    try {
                        const latestResponse = await documentsApi.getSpecificDocumentStore(storeId)
                        requireDocumentStoreVersionToken(latestResponse.data)
                        setDocumentStore(latestResponse.data)
                    } catch {
                        setDocumentStore((current) => ({ ...current, versionToken: undefined }))
                    }
                    enqueueSnackbar({
                        message: DOCUMENT_STORE_VERSION_CONFLICT_MESSAGE,
                        options: { variant: 'warning' }
                    })
                    return
                }
                setError(error)
                enqueueSnackbar({
                    message: `删除文档库失败：${getErrorMessage(error)}`,
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
        } else if (type === 'LOADER') {
            try {
                const versionToken = requireDocumentStoreVersionToken(documentStore)
                const deleteResp = await documentsApi.deleteLoaderFromStore(storeId, file.id, versionToken)
                setBackdropLoading(false)
                if (deleteResp.data) {
                    setShowDeleteDocStoreDialog(false)
                    const advancedVersionToken = requireDocumentStoreVersionToken(deleteResp.data)
                    setDocumentStore((current) => ({ ...current, versionToken: advancedVersionToken }))
                    enqueueSnackbar({
                        message: documentStore.vectorStoreConfig
                            ? '本地加载器和关联分块已删除；外部向量服务中的数据未自动清理'
                            : '本地加载器和关联分块已删除',
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
                }
            } catch (error) {
                setBackdropLoading(false)
                if (isDocumentStoreVersionConflict(error)) {
                    setShowDeleteDocStoreDialog(false)
                    setDocumentStore((current) => ({ ...current, versionToken: undefined }))
                    try {
                        const latestResponse = await documentsApi.getSpecificDocumentStore(storeId)
                        requireDocumentStoreVersionToken(latestResponse.data)
                        setDocumentStore(latestResponse.data)
                    } catch {
                        setDocumentStore((current) => ({ ...current, versionToken: undefined }))
                    }
                    enqueueSnackbar({
                        message: DOCUMENT_STORE_VERSION_CONFLICT_MESSAGE,
                        options: { variant: 'warning' }
                    })
                    return
                }
                setError(error)
                enqueueSnackbar({
                    message: `删除文档加载器失败：${getErrorMessage(error)}`,
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

    const onLoaderDelete = (file, vectorStoreConfig, recordManagerConfig) => {
        // Get the display name in the format "LoaderName (sourceName)"
        const loaderName = file.loaderName || '未知加载器'
        let sourceName = ''

        // Prefer files.name when files array exists and has items
        if (file.files && Array.isArray(file.files) && file.files.length > 0) {
            sourceName = file.files.map((f) => f.name).join(', ')
        } else if (file.source) {
            // Fallback to source logic
            if (typeof file.source === 'string' && file.source.includes('base64')) {
                sourceName = getFileName(file.source)
            } else if (typeof file.source === 'string' && file.source.startsWith('[') && file.source.endsWith(']')) {
                sourceName = JSON.parse(file.source).join(', ')
            } else if (typeof file.source === 'string') {
                sourceName = file.source
            }
        }

        const displayName = sourceName ? `${loaderName} (${sourceName})` : loaderName

        let description = `确定删除“${displayName}”吗？此操作会删除文档库中与其关联的全部文档分块。`

        if (vectorStoreConfig && Object.keys(vectorStoreConfig).length > 0) {
            description += '此操作不会删除外部向量服务中的数据；需按受控清理流程另行处理。本地删除与外部清理无法保证原子性。'
        }

        const props = {
            title: '删除加载器',
            description,
            vectorStoreConfig,
            recordManagerConfig,
            type: 'LOADER',
            file
        }

        setDeleteDocStoreDialogProps(props)
        setShowDeleteDocStoreDialog(true)
    }

    const onStoreDelete = (vectorStoreConfig, recordManagerConfig) => {
        let description = `确定删除文档库“${documentStore?.name}”吗？此操作会删除其中的全部加载器和文档分块。`

        if (vectorStoreConfig && Object.keys(vectorStoreConfig).length > 0) {
            description += '此操作不会删除外部向量服务中的数据；需按受控清理流程另行处理。本地删除与外部清理无法保证原子性。'
        }

        const props = {
            title: '删除文档库',
            description,
            vectorStoreConfig,
            recordManagerConfig,
            type: 'STORE'
        }

        setDeleteDocStoreDialogProps(props)
        setShowDeleteDocStoreDialog(true)
    }

    const onStoreRefresh = async (storeId) => {
        const confirmPayload = {
            title: '刷新全部加载器并更新所有分块？',
            description: '系统将重新处理全部加载器并更新所有分块，这可能需要一些时间。',
            confirmButtonName: '刷新',
            cancelButtonName: '取消'
        }
        const isConfirmed = await confirm(confirmPayload)

        if (isConfirmed) {
            setAnchorEl(null)
            setBackdropLoading(true)
            try {
                const resp = await documentsApi.refreshLoader(storeId, documentStore.versionToken)
                if (resp.data) {
                    requireDocumentStoreVersionToken(resp.data)
                    const latestResponse = await documentsApi.getSpecificDocumentStore(storeId)
                    requireDocumentStoreVersionToken(latestResponse.data)
                    setDocumentStore(latestResponse.data)
                    enqueueSnackbar({
                        message: '文档库刷新成功',
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
                setBackdropLoading(false)
            } catch (error) {
                setBackdropLoading(false)
                if (isDocumentStoreVersionConflict(error)) {
                    setDocumentStore((current) => ({ ...current, versionToken: undefined }))
                    try {
                        const latestResponse = await documentsApi.getSpecificDocumentStore(storeId)
                        requireDocumentStoreVersionToken(latestResponse.data)
                        setDocumentStore(latestResponse.data)
                    } catch {
                        setDocumentStore((current) => ({ ...current, versionToken: undefined }))
                    }
                    enqueueSnackbar({
                        message: DOCUMENT_STORE_VERSION_CONFLICT_MESSAGE,
                        options: { variant: 'warning' }
                    })
                    return
                }
                enqueueSnackbar({
                    message: `刷新文档库失败：${getErrorMessage(error)}`,
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
            }
        }
    }

    const onEditClicked = () => {
        const data = {
            name: documentStore.name,
            description: documentStore.description,
            id: documentStore.id,
            versionToken: documentStore.versionToken
        }
        const dialogProp = {
            title: '编辑文档库',
            type: 'EDIT',
            cancelButtonName: '取消',
            confirmButtonName: '更新',
            data: data
        }
        setDialogProps(dialogProp)
        setShowDialog(true)
    }

    const onConfirm = () => {
        setShowDialog(false)
        getSpecificDocumentStore.request(storeId)
    }

    const handleClick = (event) => {
        event.preventDefault()
        event.stopPropagation()
        setAnchorEl(event.currentTarget)
    }

    const onViewUpsertAPI = (storeId, loaderId) => {
        const props = {
            title: '更新 API',
            storeId,
            loaderId
        }
        setDocStoreAPIDialogProps(props)
        setShowDocStoreAPIDialog(true)
    }

    const handleClose = () => {
        setAnchorEl(null)
    }

    useEffect(() => {
        getSpecificDocumentStore.request(storeId)

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        if (getSpecificDocumentStore.data) {
            const workspaceId = getSpecificDocumentStore.data.workspaceId
            if (!hasAssignedWorkspace(workspaceId)) {
                navigate('/unauthorized')
                return
            }
            setDocumentStore(getSpecificDocumentStore.data)
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getSpecificDocumentStore.data])

    useEffect(() => {
        setLoading(getSpecificDocumentStore.loading)
    }, [getSpecificDocumentStore.loading])

    return (
        <>
            <MainCard>
                {error ? (
                    <ErrorBoundary error={error} onBack={() => navigate('/document-stores')} backLabel='返回文档库列表' />
                ) : (
                    <Stack flexDirection='column' sx={{ gap: 3 }}>
                        <ViewHeader
                            isBackButton={true}
                            isEditButton={hasPermission('documentStores:update')}
                            search={false}
                            title={documentStore?.name}
                            description={documentStore?.description}
                            onBack={() => navigate('/document-stores')}
                            onEdit={() => onEditClicked()}
                        >
                            {(documentStore?.status === 'STALE' || documentStore?.status === 'UPSERTING') && (
                                <PermissionIconButton
                                    permissionId={'documentStores:upsert-config'}
                                    onClick={onConfirm}
                                    size='small'
                                    color='primary'
                                    title='刷新文档库'
                                >
                                    <IconRefresh />
                                </PermissionIconButton>
                            )}
                            <StyledPermissionButton
                                permissionId={'documentStores:add-loader'}
                                variant='contained'
                                sx={{ ml: 2, minWidth: 200, borderRadius: 2, height: '100%', color: 'white' }}
                                startIcon={<IconPlus />}
                                onClick={listLoaders}
                            >
                                添加文档加载器
                            </StyledPermissionButton>
                            <Button
                                id='document-store-header-action-button'
                                aria-controls={open ? 'document-store-header-menu' : undefined}
                                aria-haspopup='true'
                                aria-expanded={open ? 'true' : undefined}
                                variant='outlined'
                                disableElevation
                                color='secondary'
                                onClick={handleClick}
                                sx={{ minWidth: 150 }}
                                endIcon={<KeyboardArrowDownIcon />}
                            >
                                更多操作
                            </Button>
                            <StyledMenu
                                id='document-store-header-menu'
                                MenuListProps={{
                                    'aria-labelledby': 'document-store-header-menu-button'
                                }}
                                anchorEl={anchorEl}
                                open={open}
                                onClose={handleClose}
                            >
                                <MenuItem
                                    disabled={documentStore?.totalChunks <= 0 || documentStore?.status === 'UPSERTING'}
                                    onClick={() => {
                                        handleClose()
                                        showStoredChunks('all')
                                    }}
                                    disableRipple
                                >
                                    <FileChunksIcon />
                                    查看和编辑分块
                                </MenuItem>
                                <Available permission={'documentStores:upsert-config'}>
                                    <MenuItem
                                        disabled={documentStore?.totalChunks <= 0 || documentStore?.status === 'UPSERTING'}
                                        onClick={() => {
                                            handleClose()
                                            showVectorStore(documentStore.id)
                                        }}
                                        disableRipple
                                    >
                                        <NoteAddIcon />
                                        更新全部分块
                                    </MenuItem>
                                </Available>
                                <MenuItem
                                    disabled={documentStore?.totalChunks <= 0 || documentStore?.status !== 'UPSERTED'}
                                    onClick={() => {
                                        handleClose()
                                        showVectorStoreQuery(documentStore.id)
                                    }}
                                    disableRipple
                                >
                                    <SearchIcon />
                                    检索测试
                                </MenuItem>
                                <Available permission={'documentStores:upsert-config'}>
                                    <MenuItem
                                        disabled={documentStore?.totalChunks <= 0 || documentStore?.status !== 'UPSERTED'}
                                        onClick={() => onStoreRefresh(documentStore.id)}
                                        disableRipple
                                        title='重新处理所有加载器并更新所有片段'
                                    >
                                        <RefreshIcon />
                                        刷新
                                    </MenuItem>
                                </Available>
                                <Divider sx={{ my: 0.5 }} />
                                <MenuItem
                                    onClick={() => {
                                        handleClose()
                                        onStoreDelete(documentStore.vectorStoreConfig, documentStore.recordManagerConfig)
                                    }}
                                    disableRipple
                                >
                                    <FileDeleteIcon />
                                    删除
                                </MenuItem>
                            </StyledMenu>
                        </ViewHeader>
                        <DocumentStoreStatus status={documentStore?.status} />
                        {documentStore?.whereUsed?.length > 0 && (
                            <Stack flexDirection='row' sx={{ gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
                                <div
                                    style={{
                                        paddingLeft: '15px',
                                        paddingRight: '15px',
                                        paddingTop: '10px',
                                        paddingBottom: '10px',
                                        fontSize: '0.9rem',
                                        width: 'max-content',
                                        display: 'flex',
                                        flexDirection: 'row',
                                        alignItems: 'center'
                                    }}
                                >
                                    <IconVectorBezier2 style={{ marginRight: 5 }} size={17} />
                                    关联对话流程：
                                </div>
                                {documentStore.whereUsed.map((chatflowUsed, index) => (
                                    <Chip
                                        key={index}
                                        clickable
                                        style={{
                                            width: 'max-content',
                                            borderRadius: '25px',
                                            boxShadow: customization.isDarkMode
                                                ? '0 2px 14px 0 rgb(255 255 255 / 10%)'
                                                : '0 2px 14px 0 rgb(32 40 45 / 10%)'
                                        }}
                                        label={chatflowUsed.name}
                                        onClick={() => navigate('/canvas/' + chatflowUsed.id)}
                                    ></Chip>
                                ))}
                            </Stack>
                        )}
                        {!isLoading && documentStore && !documentStore?.loaders?.length ? (
                            <Stack sx={{ alignItems: 'center', justifyContent: 'center' }} flexDirection='column'>
                                <Box sx={{ p: 2, height: 'auto' }}>
                                    <img
                                        style={{ objectFit: 'cover', height: '16vh', width: 'auto' }}
                                        src={doc_store_details_emptySVG}
                                        alt='文档库暂无内容'
                                    />
                                </Box>
                                <div>尚未添加文档</div>
                                <StyledButton
                                    variant='contained'
                                    sx={{ borderRadius: 2, height: '100%', mt: 2, color: 'white' }}
                                    startIcon={<IconPlus />}
                                    onClick={listLoaders}
                                >
                                    添加文档加载器
                                </StyledButton>
                            </Stack>
                        ) : (
                            <TableContainer
                                sx={{ border: 1, borderColor: theme.palette.grey[900] + 25, borderRadius: 2 }}
                                component={Paper}
                            >
                                <Table sx={{ minWidth: 650 }} aria-label='文档加载器列表'>
                                    <TableHead
                                        sx={{
                                            backgroundColor: customization.isDarkMode
                                                ? theme.palette.common.black
                                                : theme.palette.grey[100],
                                            height: 56
                                        }}
                                    >
                                        <TableRow>
                                            <StyledTableCell>&nbsp;</StyledTableCell>
                                            <StyledTableCell>加载器</StyledTableCell>
                                            <StyledTableCell>分割器</StyledTableCell>
                                            <StyledTableCell>来源</StyledTableCell>
                                            <StyledTableCell>片段</StyledTableCell>
                                            <StyledTableCell>字符数</StyledTableCell>
                                            <Available permission={'documentStores:preview-process,documentStores:delete-loader'}>
                                                <StyledTableCell>操作</StyledTableCell>
                                            </Available>
                                        </TableRow>
                                    </TableHead>
                                    <TableBody>
                                        {isLoading ? (
                                            <>
                                                <StyledTableRow>
                                                    <StyledTableCell>
                                                        <Skeleton variant='text' />
                                                    </StyledTableCell>
                                                    <StyledTableCell>
                                                        <Skeleton variant='text' />
                                                    </StyledTableCell>
                                                    <StyledTableCell>
                                                        <Skeleton variant='text' />
                                                    </StyledTableCell>
                                                    <StyledTableCell>
                                                        <Skeleton variant='text' />
                                                    </StyledTableCell>
                                                    <StyledTableCell>
                                                        <Skeleton variant='text' />
                                                    </StyledTableCell>
                                                    <StyledTableCell>
                                                        <Skeleton variant='text' />
                                                    </StyledTableCell>
                                                    <Available permission={'documentStores:preview-process,documentStores:delete-loader'}>
                                                        <StyledTableCell>
                                                            <Skeleton variant='text' />
                                                        </StyledTableCell>
                                                    </Available>
                                                </StyledTableRow>
                                                <StyledTableRow>
                                                    <StyledTableCell>
                                                        <Skeleton variant='text' />
                                                    </StyledTableCell>
                                                    <StyledTableCell>
                                                        <Skeleton variant='text' />
                                                    </StyledTableCell>
                                                    <StyledTableCell>
                                                        <Skeleton variant='text' />
                                                    </StyledTableCell>
                                                    <StyledTableCell>
                                                        <Skeleton variant='text' />
                                                    </StyledTableCell>
                                                    <StyledTableCell>
                                                        <Skeleton variant='text' />
                                                    </StyledTableCell>
                                                    <StyledTableCell>
                                                        <Skeleton variant='text' />
                                                    </StyledTableCell>
                                                    <Available permission={'documentStores:preview-process,documentStores:delete-loader'}>
                                                        <StyledTableCell>
                                                            <Skeleton variant='text' />
                                                        </StyledTableCell>
                                                    </Available>
                                                </StyledTableRow>
                                            </>
                                        ) : (
                                            <>
                                                {documentStore?.loaders &&
                                                    documentStore?.loaders.length > 0 &&
                                                    documentStore?.loaders.map((loader, index) => (
                                                        <LoaderRow
                                                            key={index}
                                                            index={index}
                                                            loader={loader}
                                                            theme={theme}
                                                            onEditClick={() => openPreviewSettings(loader.id)}
                                                            onViewChunksClick={() => showStoredChunks(loader.id)}
                                                            onDeleteClick={() =>
                                                                onLoaderDelete(
                                                                    loader,
                                                                    documentStore?.vectorStoreConfig,
                                                                    documentStore?.recordManagerConfig
                                                                )
                                                            }
                                                            onChunkUpsert={() =>
                                                                navigate(`/document-stores/vector/${documentStore.id}/${loader.id}`)
                                                            }
                                                            onViewUpsertAPI={() => onViewUpsertAPI(documentStore.id, loader.id)}
                                                        />
                                                    ))}
                                            </>
                                        )}
                                    </TableBody>
                                </Table>
                            </TableContainer>
                        )}
                        {documentStore?.status === 'STALE' && (
                            <div style={{ width: '100%', textAlign: 'center', marginTop: '20px' }}>
                                <Typography
                                    color='warning'
                                    style={{ color: 'darkred', fontWeight: 500, fontStyle: 'italic', fontSize: 12 }}
                                >
                                    部分文件正在处理中，请刷新以获取最新状态。
                                </Typography>
                            </div>
                        )}
                    </Stack>
                )}
            </MainCard>
            {showDialog && (
                <AddDocStoreDialog
                    dialogProps={dialogProps}
                    show={showDialog}
                    onCancel={() => setShowDialog(false)}
                    onConfirm={onConfirm}
                />
            )}
            {showDocumentLoaderListDialog && (
                <DocumentLoaderListDialog
                    show={showDocumentLoaderListDialog}
                    dialogProps={documentLoaderListDialogProps}
                    onCancel={() => setShowDocumentLoaderListDialog(false)}
                    onDocLoaderSelected={onDocLoaderSelected}
                />
            )}
            {showDeleteDocStoreDialog && (
                <DeleteDocStoreDialog
                    show={showDeleteDocStoreDialog}
                    dialogProps={deleteDocStoreDialogProps}
                    onCancel={() => setShowDeleteDocStoreDialog(false)}
                    onDelete={onDocStoreDelete}
                />
            )}
            {showDocStoreAPIDialog && (
                <DocStoreAPIDialog
                    show={showDocStoreAPIDialog}
                    dialogProps={docStoreAPIDialogProps}
                    onCancel={() => setShowDocStoreAPIDialog(false)}
                />
            )}
            {isBackdropLoading && <BackdropLoader open={isBackdropLoading} />}
            <ConfirmDialog />
        </>
    )
}

function LoaderRow(props) {
    const [anchorEl, setAnchorEl] = useState(null)
    const open = Boolean(anchorEl)

    const handleClick = (event) => {
        event.preventDefault()
        event.stopPropagation()
        setAnchorEl(event.currentTarget)
    }

    const handleClose = () => {
        setAnchorEl(null)
    }

    const formatSources = (files, source, loaderName) => {
        let sourceName = ''

        // Prefer files.name when files array exists and has items
        if (files && Array.isArray(files) && files.length > 0) {
            sourceName = files.map((file) => file.name).join(', ')
        } else if (source && typeof source === 'string' && source.includes('base64')) {
            // Fallback to original source logic
            sourceName = getFileName(source)
        } else if (source && typeof source === 'string' && source.startsWith('[') && source.endsWith(']')) {
            sourceName = JSON.parse(source).join(', ')
        } else if (source) {
            sourceName = source
        }

        // Return format: "LoaderName (sourceName)" or just "LoaderName" if no source
        if (!sourceName) {
            return loaderName || '无来源'
        }
        return loaderName ? `${loaderName} (${sourceName})` : sourceName
    }

    return (
        <>
            <TableRow hover key={props.index} sx={{ '&:last-child td, &:last-child th': { border: 0 }, cursor: 'pointer' }}>
                <StyledTableCell onClick={props.onViewChunksClick} scope='row' style={{ width: '5%' }}>
                    <div
                        style={{
                            display: 'flex',
                            width: '20px',
                            height: '20px',
                            backgroundColor: props.loader?.status === 'SYNC' ? '#00e676' : '#ffe57f',
                            borderRadius: '50%'
                        }}
                    ></div>
                </StyledTableCell>
                <StyledTableCell onClick={props.onViewChunksClick} scope='row'>
                    {props.loader.loaderName}
                </StyledTableCell>
                <StyledTableCell onClick={props.onViewChunksClick}>{props.loader.splitterName ?? '无'}</StyledTableCell>
                <StyledTableCell onClick={props.onViewChunksClick}>
                    {formatSources(props.loader.files, props.loader.source)}
                </StyledTableCell>
                <StyledTableCell onClick={props.onViewChunksClick}>
                    {props.loader.totalChunks && <Chip variant='outlined' size='small' label={props.loader.totalChunks.toLocaleString()} />}
                </StyledTableCell>
                <StyledTableCell onClick={props.onViewChunksClick}>
                    {props.loader.totalChars && <Chip variant='outlined' size='small' label={props.loader.totalChars.toLocaleString()} />}
                </StyledTableCell>
                <Available permission={'documentStores:preview-process,documentStores:delete-loader'}>
                    <StyledTableCell>
                        <div>
                            <Button
                                id='document-store-action-button'
                                aria-controls={open ? 'document-store-action-customized-menu' : undefined}
                                aria-haspopup='true'
                                aria-expanded={open ? 'true' : undefined}
                                disableElevation
                                onClick={(e) => handleClick(e)}
                                endIcon={<KeyboardArrowDownIcon />}
                            >
                                操作
                            </Button>
                            <StyledMenu
                                id='document-store-actions-customized-menu'
                                MenuListProps={{
                                    'aria-labelledby': 'document-store-actions-customized-button'
                                }}
                                anchorEl={anchorEl}
                                open={open}
                                onClose={handleClose}
                            >
                                <Available permission={'documentStores:preview-process'}>
                                    <MenuItem
                                        onClick={() => {
                                            handleClose()
                                            props.onEditClick()
                                        }}
                                        disableRipple
                                    >
                                        <FileEditIcon />
                                        预览并处理
                                    </MenuItem>
                                </Available>
                                <Available permission={'documentStores:preview-process'}>
                                    <MenuItem
                                        onClick={() => {
                                            handleClose()
                                            props.onViewChunksClick()
                                        }}
                                        disableRipple
                                    >
                                        <FileChunksIcon />
                                        查看和编辑分块
                                    </MenuItem>
                                </Available>
                                <Available permission={'documentStores:preview-process'}>
                                    <MenuItem
                                        onClick={() => {
                                            handleClose()
                                            props.onChunkUpsert()
                                        }}
                                        disableRipple
                                    >
                                        <NoteAddIcon />
                                        更新分块
                                    </MenuItem>
                                </Available>
                                <Available permission={'documentStores:preview-process'}>
                                    <MenuItem
                                        onClick={() => {
                                            handleClose()
                                            props.onViewUpsertAPI()
                                        }}
                                        disableRipple
                                    >
                                        <CodeIcon />
                                        查看 API
                                    </MenuItem>
                                </Available>
                                <Divider sx={{ my: 0.5 }} />
                                <Available permission={'documentStores:delete-loader'}>
                                    <MenuItem
                                        onClick={() => {
                                            handleClose()
                                            props.onDeleteClick()
                                        }}
                                        disableRipple
                                    >
                                        <FileDeleteIcon />
                                        删除
                                    </MenuItem>
                                </Available>
                            </StyledMenu>
                        </div>
                    </StyledTableCell>
                </Available>
            </TableRow>
        </>
    )
}

LoaderRow.propTypes = {
    loader: PropTypes.any,
    index: PropTypes.number,
    open: PropTypes.bool,
    theme: PropTypes.any,
    onViewChunksClick: PropTypes.func,
    onEditClick: PropTypes.func,
    onDeleteClick: PropTypes.func,
    onChunkUpsert: PropTypes.func,
    onViewUpsertAPI: PropTypes.func
}
export default DocumentStoreDetails
