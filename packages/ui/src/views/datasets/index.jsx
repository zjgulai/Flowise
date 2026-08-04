import { useEffect, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import moment from 'moment/moment'
import { useNavigate } from 'react-router-dom'

// material-ui
import {
    Skeleton,
    Box,
    Stack,
    TableContainer,
    Paper,
    Table,
    TableHead,
    TableRow,
    TableCell,
    TableBody,
    IconButton,
    Button
} from '@mui/material'
import { useTheme } from '@mui/material/styles'

// project imports
import MainCard from '@/ui-component/cards/MainCard'
import ConfirmDialog from '@/ui-component/dialog/ConfirmDialog'
import AddEditDatasetDialog from './AddEditDatasetDialog'
import ViewHeader from '@/layout/MainLayout/ViewHeader'
import ErrorBoundary from '@/ErrorBoundary'
import { StyledTableCell, StyledTableRow } from '@/ui-component/table/TableStyles'
import { StyledPermissionButton } from '@/ui-component/button/RBACButtons'
import { Available } from '@/ui-component/rbac/available'
import TablePagination, { DEFAULT_ITEMS_PER_PAGE } from '@/ui-component/pagination/TablePagination'

// API
import { closeSnackbar as closeSnackbarAction, enqueueSnackbar as enqueueSnackbarAction } from '@/store/actions'
import useConfirm from '@/hooks/useConfirm'
import datasetsApi from '@/api/dataset'

// Hooks
import useApi from '@/hooks/useApi'
import useNotifier from '@/utils/useNotifier'
import { getErrorMessage } from '@/utils/getErrorMessage'

// icons
import empty_datasetSVG from '@/assets/images/empty_datasets.svg'
import { IconTrash, IconEdit, IconPlus, IconX } from '@tabler/icons-react'

// Utils
import { truncateString } from '@/utils/genericHelper'

import { useError } from '@/store/context/ErrorContext'

// ==============================|| Datasets ||============================== //

const EvalDatasets = () => {
    const navigate = useNavigate()
    const theme = useTheme()
    const { confirm } = useConfirm()
    const { error } = useError()

    const customization = useSelector((state) => state.customization)

    useNotifier()
    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))

    const [search, setSearch] = useState('')
    const dispatch = useDispatch()
    const [isLoading, setLoading] = useState(true)
    const [datasets, setDatasets] = useState([])
    const [showDatasetDialog, setShowDatasetDialog] = useState(false)
    const [datasetDialogProps, setDatasetDialogProps] = useState({})
    const getAllDatasets = useApi(datasetsApi.getAllDatasets)

    /* Table Pagination */
    const [currentPage, setCurrentPage] = useState(1)
    const [pageLimit, setPageLimit] = useState(DEFAULT_ITEMS_PER_PAGE)
    const [total, setTotal] = useState(0)
    const onChange = (page, pageLimit) => {
        setCurrentPage(page)
        setPageLimit(pageLimit)
        refresh(page, pageLimit)
    }

    const refresh = (page, limit) => {
        setLoading(true)
        const params = {
            page: page || currentPage,
            limit: limit || pageLimit
        }
        getAllDatasets.request(params)
    }

    const goToRows = (selectedDataset) => {
        navigate(`/dataset_rows/${selectedDataset.id}?page=1&limit=10`)
    }

    const onSearchChange = (event) => {
        setSearch(event.target.value)
    }

    const addNew = () => {
        const dialogProp = {
            type: 'ADD',
            cancelButtonName: '取消',
            confirmButtonName: '添加',
            data: {}
        }
        setDatasetDialogProps(dialogProp)
        setShowDatasetDialog(true)
    }

    const edit = (dataset) => {
        const dialogProp = {
            type: 'EDIT',
            cancelButtonName: '取消',
            confirmButtonName: '保存',
            data: dataset
        }
        setDatasetDialogProps(dialogProp)
        setShowDatasetDialog(true)
    }

    const deleteDataset = async (dataset) => {
        const confirmPayload = {
            title: '删除数据集',
            description: `确定删除数据集“${dataset.name}”吗？`,
            confirmButtonName: '删除',
            cancelButtonName: '取消'
        }
        const isConfirmed = await confirm(confirmPayload)

        if (isConfirmed) {
            try {
                const deleteResp = await datasetsApi.deleteDataset(dataset.id)
                if (deleteResp.data) {
                    enqueueSnackbar({
                        message: '数据集已删除',
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
                enqueueSnackbar({
                    message: `删除数据集失败：${getErrorMessage(error)}`,
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

    const onConfirm = () => {
        setShowDatasetDialog(false)
        refresh()
    }

    function filterDatasets(data) {
        return data.name.toLowerCase().indexOf(search.toLowerCase()) > -1
    }

    useEffect(() => {
        refresh(currentPage, pageLimit)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        if (getAllDatasets.data) {
            setDatasets(getAllDatasets.data?.data)
            setTotal(getAllDatasets.data?.total)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getAllDatasets.data])

    useEffect(() => {
        setLoading(getAllDatasets.loading)
    }, [getAllDatasets.loading])

    return (
        <>
            <MainCard>
                {error ? (
                    <ErrorBoundary error={error} />
                ) : (
                    <Stack flexDirection='column' sx={{ gap: 3 }}>
                        <ViewHeader
                            isBackButton={false}
                            isEditButton={false}
                            onSearchChange={onSearchChange}
                            search={true}
                            title='数据集'
                            description=''
                        >
                            <StyledPermissionButton
                                permissionId={'datasets:create'}
                                variant='contained'
                                sx={{ borderRadius: 2, height: '100%' }}
                                onClick={addNew}
                                startIcon={<IconPlus />}
                            >
                                新增数据集
                            </StyledPermissionButton>
                        </ViewHeader>
                        {!isLoading && datasets.length <= 0 ? (
                            <Stack sx={{ alignItems: 'center', justifyContent: 'center' }} flexDirection='column'>
                                <Box sx={{ p: 2, height: 'auto' }}>
                                    <img
                                        style={{ objectFit: 'cover', height: '20vh', width: 'auto' }}
                                        src={empty_datasetSVG}
                                        alt='暂无数据集'
                                    />
                                </Box>
                                <div>暂无数据集</div>
                            </Stack>
                        ) : (
                            <>
                                <TableContainer
                                    sx={{ border: 1, borderColor: theme.palette.grey[900] + 25, borderRadius: 2 }}
                                    component={Paper}
                                >
                                    <Table sx={{ minWidth: 650 }}>
                                        <TableHead
                                            sx={{
                                                backgroundColor: customization.isDarkMode
                                                    ? theme.palette.common.black
                                                    : theme.palette.grey[100],
                                                height: 56
                                            }}
                                        >
                                            <TableRow>
                                                <TableCell>名称</TableCell>
                                                <TableCell>描述</TableCell>
                                                <TableCell>行</TableCell>
                                                <TableCell>最近更新时间</TableCell>
                                                <Available permission={'datasets:update,datasets:create'}>
                                                    <TableCell> </TableCell>
                                                </Available>
                                                <Available permission={'datasets:delete'}>
                                                    <TableCell> </TableCell>
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
                                                        <Available permission={'datasets:update,datasets:create'}>
                                                            <Skeleton variant='text' />
                                                        </Available>
                                                        <Available permission={'datasets:delete'}>
                                                            <Skeleton variant='text' />
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
                                                        <Available permission={'datasets:update,datasets:create'}>
                                                            <Skeleton variant='text' />
                                                        </Available>
                                                        <Available permission={'datasets:delete'}>
                                                            <Skeleton variant='text' />
                                                        </Available>
                                                    </StyledTableRow>
                                                </>
                                            ) : (
                                                <>
                                                    {datasets.filter(filterDatasets).map((ds, index) => (
                                                        <StyledTableRow
                                                            hover
                                                            key={index}
                                                            sx={{ cursor: 'pointer', '&:last-child td, &:last-child th': { border: 0 } }}
                                                        >
                                                            <TableCell onClick={() => goToRows(ds)} component='th' scope='row'>
                                                                {ds.name}
                                                            </TableCell>
                                                            <TableCell
                                                                onClick={() => goToRows(ds)}
                                                                style={{ wordWrap: 'break-word', flexWrap: 'wrap', width: '40%' }}
                                                            >
                                                                {truncateString(ds?.description, 200)}
                                                            </TableCell>
                                                            <TableCell onClick={() => goToRows(ds)}>{ds?.rowCount}</TableCell>
                                                            <TableCell onClick={() => goToRows(ds)}>
                                                                {moment(ds.updatedDate).format('YYYY-MM-DD HH:mm:ss')}
                                                            </TableCell>
                                                            <Available permission={'datasets:update,datasets:create'}>
                                                                <TableCell>
                                                                    <IconButton title='编辑' color='primary' onClick={() => edit(ds)}>
                                                                        <IconEdit />
                                                                    </IconButton>
                                                                </TableCell>
                                                            </Available>
                                                            <Available permission={'datasets:delete'}>
                                                                <TableCell>
                                                                    <IconButton
                                                                        title='删除'
                                                                        color='error'
                                                                        onClick={() => deleteDataset(ds)}
                                                                    >
                                                                        <IconTrash />
                                                                    </IconButton>
                                                                </TableCell>
                                                            </Available>
                                                        </StyledTableRow>
                                                    ))}
                                                </>
                                            )}
                                        </TableBody>
                                    </Table>
                                </TableContainer>
                                {/* Pagination and Page Size Controls */}
                                <TablePagination currentPage={currentPage} limit={pageLimit} total={total} onChange={onChange} />
                            </>
                        )}
                    </Stack>
                )}
            </MainCard>
            <AddEditDatasetDialog
                show={showDatasetDialog}
                dialogProps={datasetDialogProps}
                onCancel={() => setShowDatasetDialog(false)}
                onConfirm={onConfirm}
            ></AddEditDatasetDialog>
            <ConfirmDialog />
        </>
    )
}

export default EvalDatasets
