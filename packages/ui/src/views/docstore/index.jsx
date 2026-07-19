import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDispatch } from 'react-redux'

// material-ui
import { Box, Button, IconButton, ListItemIcon, ListItemText, Menu, MenuItem, Stack, ToggleButton, ToggleButtonGroup } from '@mui/material'
import { useTheme } from '@mui/material/styles'

// project imports
import ErrorBoundary from '@/ErrorBoundary'
import ViewHeader from '@/layout/MainLayout/ViewHeader'
import { useError } from '@/store/context/ErrorContext'
import { StyledPermissionButton } from '@/ui-component/button/RBACButtons'
import DocumentStoreCard from '@/ui-component/cards/DocumentStoreCard'
import MainCard from '@/ui-component/cards/MainCard'
import TablePagination, { DEFAULT_ITEMS_PER_PAGE } from '@/ui-component/pagination/TablePagination'
import AddDocStoreDialog from '@/views/docstore/AddDocStoreDialog'
import DeleteDocStoreDialog from '@/views/docstore/DeleteDocStoreDialog'

// API
import documentsApi from '@/api/documentstore'
import { useAuth } from '@/hooks/useAuth'
import useApi from '@/hooks/useApi'

// icons
import { IconDotsVertical, IconEdit, IconLayoutGrid, IconList, IconPlus, IconTrash, IconX } from '@tabler/icons-react'
import doc_store_empty from '@/assets/images/doc_store_empty.svg'

// const
import { baseURL, gridSpacing } from '@/store/constant'
import { DocumentStoreTable } from '@/ui-component/table/DocumentStoreTable'
import { closeSnackbar as closeSnackbarAction, enqueueSnackbar as enqueueSnackbarAction } from '@/store/actions'

// utils
import useNotifier from '@/utils/useNotifier'

// ==============================|| DOCUMENTS ||============================== //
const getDocStoreActionButtonSx = (theme) => ({
    p: 0.5,
    color: theme.palette.text.primary,
    backgroundColor: theme.palette.mode === 'dark' ? theme.palette.background.default : theme.palette.background.paper,
    border: `1px solid ${theme.palette.divider}`,
    '&:hover': {
        backgroundColor: theme.palette.action.hover,
        borderColor: theme.palette.text.secondary
    }
})

const Documents = () => {
    const theme = useTheme()
    const dispatch = useDispatch()
    const navigate = useNavigate()
    const { hasPermission } = useAuth()
    const getAllDocumentStores = useApi(documentsApi.getAllDocumentStores)
    const { error } = useError()
    useNotifier()

    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))

    const [isLoading, setLoading] = useState(true)
    const [images, setImages] = useState({})
    const [search, setSearch] = useState('')
    const [showDialog, setShowDialog] = useState(false)
    const [dialogProps, setDialogProps] = useState({})
    const [docStores, setDocStores] = useState([])
    const [view, setView] = useState(localStorage.getItem('docStoreDisplayStyle') || 'card')
    const [actionMenuAnchorEl, setActionMenuAnchorEl] = useState(null)
    const [selectedDocumentStore, setSelectedDocumentStore] = useState(null)
    const [showDeleteDocStoreDialog, setShowDeleteDocStoreDialog] = useState(false)
    const [deleteDocStoreDialogProps, setDeleteDocStoreDialogProps] = useState({})

    const canRenameDocumentStore = hasPermission('documentStores:create,documentStores:update')
    const canDeleteDocumentStore = hasPermission('documentStores:delete')
    const canManageDocumentStore = canRenameDocumentStore || canDeleteDocumentStore
    const isActionMenuOpen = Boolean(actionMenuAnchorEl)

    const handleChange = (event, nextView) => {
        if (nextView === null) return
        localStorage.setItem('docStoreDisplayStyle', nextView)
        setView(nextView)
    }

    function filterDocStores(data) {
        return (
            (data?.name || '').toLowerCase().indexOf(search.toLowerCase()) > -1 ||
            (data?.description || '').toLowerCase().indexOf(search.toLowerCase()) > -1
        )
    }

    const onSearchChange = (event) => {
        setSearch(event.target.value)
        setCurrentPage(1)
    }

    const getDeleteErrorMessage = (error) => {
        const responseData = error?.response?.data

        if (typeof responseData === 'string' && responseData.trim()) {
            return responseData
        }

        const responseMessage = responseData && typeof responseData === 'object' ? responseData.message || responseData.error : undefined
        if (typeof responseMessage === 'string' && responseMessage.trim()) {
            return responseMessage
        }

        const status = error?.response?.status
        if (status) return `服务请求失败（${status}）`

        if (typeof error?.message === 'string' && error.message.trim()) {
            return error.message
        }

        return '未知错误'
    }

    const goToDocumentStore = (id) => {
        navigate('/document-stores/' + id)
    }

    const addNew = () => {
        const dialogProp = {
            title: '添加新文档库',
            type: 'ADD',
            cancelButtonName: '取消',
            confirmButtonName: '添加'
        }
        setDialogProps(dialogProp)
        setShowDialog(true)
    }

    const onConfirm = (docStoreId, updatedDocStoreData) => {
        setShowDialog(false)

        // For rename from list/table, update locally to avoid full-table loading skeleton flash.
        if (dialogProps?.type === 'EDIT' && docStoreId) {
            setDocStores((prev) =>
                prev.map((store) =>
                    store.id === docStoreId
                        ? {
                              ...store,
                              ...(updatedDocStoreData || {})
                          }
                        : store
                )
            )
            return
        }

        applyFilters(currentPage, pageLimit)
    }

    const handleActionMenuOpen = (event, documentStore) => {
        event.preventDefault()
        event.stopPropagation()
        setSelectedDocumentStore(documentStore)
        setActionMenuAnchorEl(event.currentTarget)
    }

    const handleActionMenuClose = () => {
        setActionMenuAnchorEl(null)
        setSelectedDocumentStore(null)
    }

    const renameDocumentStore = () => {
        if (!selectedDocumentStore) return
        const dialogProp = {
            title: '重命名文档库',
            type: 'EDIT',
            cancelButtonName: '取消',
            confirmButtonName: '保存',
            data: {
                id: selectedDocumentStore.id,
                name: selectedDocumentStore.name,
                description: selectedDocumentStore.description
            }
        }
        handleActionMenuClose()
        setDialogProps(dialogProp)
        setShowDialog(true)
    }

    const deleteDocumentStore = () => {
        if (!selectedDocumentStore) return
        const documentStoreToDelete = selectedDocumentStore
        handleActionMenuClose()

        let description = `确定删除文档库“${documentStoreToDelete.name}”吗？删除后它将从列表中移除。`

        if (
            documentStoreToDelete.recordManagerConfig &&
            documentStoreToDelete.vectorStoreConfig &&
            Object.keys(documentStoreToDelete.recordManagerConfig).length > 0 &&
            Object.keys(documentStoreToDelete.vectorStoreConfig).length > 0
        ) {
            description = `确定删除文档库“${documentStoreToDelete.name}”吗？此操作还会删除向量数据库中的实际数据，且无法撤销。`
        }

        setDeleteDocStoreDialogProps({
            title: '删除',
            description,
            vectorStoreConfig: documentStoreToDelete.vectorStoreConfig,
            recordManagerConfig: documentStoreToDelete.recordManagerConfig,
            type: 'STORE',
            storeId: documentStoreToDelete.id
        })
        setShowDeleteDocStoreDialog(true)
    }

    const onDocStoreDelete = async (type) => {
        setShowDeleteDocStoreDialog(false)
        if (type !== 'STORE') return

        const storeId = deleteDocStoreDialogProps?.storeId
        if (!storeId) return

        try {
            const deleteResp = await documentsApi.deleteDocumentStore(storeId)
            if (deleteResp.data) {
                enqueueSnackbar({
                    message: '文档库已删除',
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
                // Update list instantly instead of full refetch/skeleton.
                setDocStores((prev) => prev.filter((store) => store.id !== storeId))
                setImages((prev) => {
                    const nextImages = { ...prev }
                    delete nextImages[storeId]
                    return nextImages
                })
                setTotal((prev) => Math.max(0, prev - 1))
            }
        } catch (error) {
            const errorMessage = getDeleteErrorMessage(error)

            enqueueSnackbar({
                message: `删除文档库失败：${errorMessage}`,
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
        const searchTimer = setTimeout(() => applyFilters(1, pageLimit, search), search ? 300 : 0)

        return () => clearTimeout(searchTimer)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [search])

    /* Table Pagination */
    const [currentPage, setCurrentPage] = useState(1)
    const [pageLimit, setPageLimit] = useState(() => Number(localStorage.getItem('docStorePageSize') || DEFAULT_ITEMS_PER_PAGE))
    const [total, setTotal] = useState(0)
    const onChange = (page, pageLimit) => {
        setCurrentPage(page)
        setPageLimit(pageLimit)
        localStorage.setItem('docStorePageSize', pageLimit)
        applyFilters(page, pageLimit, search)
    }

    const applyFilters = (page, limit, searchTerm = search, sort = {}) => {
        setLoading(true)
        const params = {
            page: page || currentPage,
            limit: limit || pageLimit,
            search: searchTerm.trim(),
            orderBy: sort.orderBy || localStorage.getItem('doc_store_orderBy') || 'name',
            order: sort.order || localStorage.getItem('doc_store_order') || 'desc'
        }
        getAllDocumentStores.request(params)
    }

    const onSortChange = (orderBy, order) => {
        setCurrentPage(1)
        applyFilters(1, pageLimit, search, { orderBy, order })
    }

    useEffect(() => {
        if (getAllDocumentStores.data) {
            try {
                const { data, total } = getAllDocumentStores.data
                if (!Array.isArray(data)) return
                const loaderImages = {}

                for (let i = 0; i < data.length; i += 1) {
                    const loaders = data[i].loaders ?? []

                    let totalChunks = 0
                    let totalChars = 0
                    loaderImages[data[i].id] = []
                    for (let j = 0; j < loaders.length; j += 1) {
                        const imageSrc = `${baseURL}/api/v1/node-icon/${loaders[j].loaderId}`
                        if (!loaderImages[data[i].id].includes(imageSrc)) {
                            loaderImages[data[i].id].push(imageSrc)
                        }
                        totalChunks += loaders[j]?.totalChunks ?? 0
                        totalChars += loaders[j]?.totalChars ?? 0
                    }
                    data[i].totalDocs = loaders?.length ?? 0
                    data[i].totalChunks = totalChunks
                    data[i].totalChars = totalChars
                }
                setDocStores(data)
                setTotal(total)
                setImages(loaderImages)
            } catch (e) {
                console.error(e)
            }
        }
    }, [getAllDocumentStores.data])

    useEffect(() => {
        setLoading(getAllDocumentStores.loading)
    }, [getAllDocumentStores.loading])

    const hasDocStores = docStores && docStores.length > 0

    return (
        <MainCard>
            {error ? (
                <ErrorBoundary error={error} />
            ) : (
                <Stack flexDirection='column' sx={{ gap: 3 }}>
                    <ViewHeader
                        onSearchChange={onSearchChange}
                        search={hasDocStores}
                        searchPlaceholder='搜索名称'
                        title='文档库'
                        description='存储并更新用于大模型检索的文档（RAG）'
                    >
                        {hasDocStores && (
                            <ToggleButtonGroup
                                sx={{ borderRadius: 2, maxHeight: 40 }}
                                value={view}
                                color='primary'
                                exclusive
                                onChange={handleChange}
                            >
                                <ToggleButton
                                    sx={{
                                        borderColor: theme.palette.grey[900] + 25,
                                        borderRadius: 2,
                                        color: theme?.customization?.isDarkMode ? 'white' : 'inherit'
                                    }}
                                    variant='contained'
                                    value='card'
                                    title='卡片视图'
                                >
                                    <IconLayoutGrid />
                                </ToggleButton>
                                <ToggleButton
                                    sx={{
                                        borderColor: theme.palette.grey[900] + 25,
                                        borderRadius: 2,
                                        color: theme?.customization?.isDarkMode ? 'white' : 'inherit'
                                    }}
                                    variant='contained'
                                    value='list'
                                    title='列表视图'
                                >
                                    <IconList />
                                </ToggleButton>
                            </ToggleButtonGroup>
                        )}
                        <StyledPermissionButton
                            permissionId={'documentStores:create'}
                            variant='contained'
                            sx={{ borderRadius: 2, height: '100%' }}
                            onClick={addNew}
                            startIcon={<IconPlus />}
                            id='btn_createDocumentStore'
                        >
                            新增文档库
                        </StyledPermissionButton>
                    </ViewHeader>
                    {!hasDocStores ? (
                        <Stack sx={{ alignItems: 'center', justifyContent: 'center' }} flexDirection='column'>
                            <Box sx={{ p: 2, height: 'auto' }}>
                                <img
                                    style={{ objectFit: 'cover', height: '20vh', width: 'auto' }}
                                    src={doc_store_empty}
                                    alt='doc_store_empty'
                                />
                            </Box>
                            <div>暂无文档库</div>
                        </Stack>
                    ) : (
                        <React.Fragment>
                            {!view || view === 'card' ? (
                                <Box
                                    display='grid'
                                    gridTemplateColumns={{ xs: '1fr', md: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' }}
                                    gap={gridSpacing}
                                >
                                    {docStores?.filter(filterDocStores).map((data) => (
                                        <Box key={data.id} sx={{ position: 'relative' }}>
                                            <DocumentStoreCard
                                                images={images[data.id]}
                                                data={data}
                                                hasActions={canManageDocumentStore}
                                                onClick={() => goToDocumentStore(data.id)}
                                            />
                                            {canManageDocumentStore && (
                                                <IconButton
                                                    size='small'
                                                    aria-label='文档库操作'
                                                    sx={{
                                                        position: 'absolute',
                                                        top: 16,
                                                        right: 10,
                                                        zIndex: 2,
                                                        width: 30,
                                                        height: 30,
                                                        ...getDocStoreActionButtonSx(theme),
                                                        [theme.breakpoints.down('sm')]: {
                                                            top: 8,
                                                            right: 8,
                                                            width: 28,
                                                            height: 28
                                                        }
                                                    }}
                                                    onClick={(event) => handleActionMenuOpen(event, data)}
                                                >
                                                    <IconDotsVertical size={18} />
                                                </IconButton>
                                            )}
                                        </Box>
                                    ))}
                                </Box>
                            ) : (
                                <DocumentStoreTable
                                    isLoading={isLoading}
                                    data={docStores?.filter(filterDocStores)}
                                    images={images}
                                    onRowClick={(row) => goToDocumentStore(row.id)}
                                    showActions={canManageDocumentStore}
                                    onActionMenuClick={handleActionMenuOpen}
                                    actionButtonSx={getDocStoreActionButtonSx(theme)}
                                    onSortChange={onSortChange}
                                />
                            )}
                            {/* Pagination and Page Size Controls */}
                            <TablePagination currentPage={currentPage} limit={pageLimit} total={total} onChange={onChange} />
                        </React.Fragment>
                    )}
                </Stack>
            )}
            {showDialog && (
                <AddDocStoreDialog
                    dialogProps={dialogProps}
                    show={showDialog}
                    onCancel={() => setShowDialog(false)}
                    onConfirm={onConfirm}
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
            <Menu
                anchorEl={actionMenuAnchorEl}
                open={isActionMenuOpen}
                onClose={handleActionMenuClose}
                transformOrigin={{ horizontal: 'right', vertical: 'top' }}
                anchorOrigin={{ horizontal: 'right', vertical: 'bottom' }}
            >
                {canRenameDocumentStore && (
                    <MenuItem onClick={renameDocumentStore}>
                        <ListItemIcon>
                            <IconEdit size={16} />
                        </ListItemIcon>
                        <ListItemText>重命名</ListItemText>
                    </MenuItem>
                )}
                {canDeleteDocumentStore && (
                    <MenuItem onClick={deleteDocumentStore}>
                        <ListItemIcon>
                            <IconTrash size={16} />
                        </ListItemIcon>
                        <ListItemText>删除</ListItemText>
                    </MenuItem>
                )}
            </Menu>
        </MainCard>
    )
}

export default Documents
