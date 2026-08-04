import { useEffect, useState } from 'react'
import zhCN from 'date-fns/locale/zh-CN'
import DatePicker, { registerLocale } from 'react-datepicker'
import 'react-datepicker/dist/react-datepicker.css'

// material-ui
import {
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogContentText,
    DialogTitle,
    FormControl,
    Grid,
    IconButton,
    InputLabel,
    MenuItem,
    Select,
    Stack,
    TextField,
    Tooltip,
    useTheme
} from '@mui/material'

// project imports
import ErrorBoundary from '@/ErrorBoundary'
import ViewHeader from '@/layout/MainLayout/ViewHeader'
import MainCard from '@/ui-component/cards/MainCard'
import { Available } from '@/ui-component/rbac/available'

// API
import executionsApi from '@/api/executions'
import useApi from '@/hooks/useApi'
import { useSelector } from 'react-redux'

// icons
import execution_empty from '@/assets/images/executions_empty.svg'
import { IconTrash } from '@tabler/icons-react'

// const
import TablePagination, { DEFAULT_ITEMS_PER_PAGE } from '@/ui-component/pagination/TablePagination'
import { ExecutionsListTable } from '@/ui-component/table/ExecutionsListTable'
import { omit } from 'lodash'
import { ExecutionDetails } from './ExecutionDetails'

registerLocale('zh-CN', zhCN)

// ==============================|| AGENT EXECUTIONS ||============================== //

const AgentExecutions = () => {
    const theme = useTheme()
    const customization = useSelector((state) => state.customization)
    const borderColor = theme.palette.grey[900] + 25

    const getAllExecutions = useApi(executionsApi.getAllExecutions)
    const deleteExecutionsApi = useApi(executionsApi.deleteExecutions)
    const getExecutionByIdApi = useApi(executionsApi.getExecutionById)

    const [error, setError] = useState(null)
    const [isLoading, setLoading] = useState(true)
    const [executions, setExecutions] = useState([])
    const [openDrawer, setOpenDrawer] = useState(false)
    const [selectedExecutionData, setSelectedExecutionData] = useState([])
    const [selectedMetadata, setSelectedMetadata] = useState({})
    const [selectedExecutionIds, setSelectedExecutionIds] = useState([])
    const [openDeleteDialog, setOpenDeleteDialog] = useState(false)
    const [filters, setFilters] = useState({
        state: '',
        startDate: null,
        endDate: null,
        agentflowId: '',
        agentflowName: '',
        sessionId: ''
    })

    const handleFilterChange = (field, value) => {
        setFilters({
            ...filters,
            [field]: value
        })
    }

    const onDateChange = (field, date) => {
        const updatedDate = new Date(date)
        updatedDate.setHours(0, 0, 0, 0)

        setFilters({
            ...filters,
            [field]: updatedDate
        })
    }

    /* Table Pagination */
    const [currentPage, setCurrentPage] = useState(1)
    const [pageLimit, setPageLimit] = useState(() => Number(localStorage.getItem('executionsPageSize') || DEFAULT_ITEMS_PER_PAGE))
    const [total, setTotal] = useState(0)
    const onChange = (page, pageLimit) => {
        setCurrentPage(page)
        setPageLimit(pageLimit)
        localStorage.setItem('executionsPageSize', pageLimit)
        applyFilters(page, pageLimit)
    }

    const applyFilters = (page, limit) => {
        setLoading(true)
        // Ensure page and limit are numbers, not objects
        const pageNum = typeof page === 'number' ? page : currentPage
        const limitNum = typeof limit === 'number' ? limit : pageLimit

        const params = {
            page: pageNum,
            limit: limitNum
        }

        if (filters.state) params.state = filters.state

        // Create date strings that preserve the exact date values
        if (filters.startDate) {
            const date = new Date(filters.startDate)
            // Format date as YYYY-MM-DD and set to start of day in UTC
            // This ensures the server sees the same date we've selected regardless of timezone
            const year = date.getFullYear()
            const month = String(date.getMonth() + 1).padStart(2, '0')
            const day = String(date.getDate()).padStart(2, '0')
            params.startDate = `${year}-${month}-${day}T00:00:00.000Z`
        }

        if (filters.endDate) {
            const date = new Date(filters.endDate)
            // Format date as YYYY-MM-DD and set to end of day in UTC
            const year = date.getFullYear()
            const month = String(date.getMonth() + 1).padStart(2, '0')
            const day = String(date.getDate()).padStart(2, '0')
            params.endDate = `${year}-${month}-${day}T23:59:59.999Z`
        }

        if (filters.agentflowId) params.agentflowId = filters.agentflowId
        if (filters.agentflowName) params.agentflowName = filters.agentflowName
        if (filters.sessionId) params.sessionId = filters.sessionId

        getAllExecutions.request(params)
    }

    const resetFilters = () => {
        setFilters({
            state: '',
            startDate: null,
            endDate: null,
            agentflowId: '',
            agentflowName: '',
            sessionId: ''
        })
        setCurrentPage(1)
        getAllExecutions.request({ page: 1, limit: pageLimit })
    }

    const handleExecutionSelectionChange = (selectedIds) => {
        setSelectedExecutionIds(selectedIds)
    }

    const handleDeleteDialogOpen = () => {
        if (selectedExecutionIds.length > 0) {
            setOpenDeleteDialog(true)
        }
    }

    const handleDeleteDialogClose = () => {
        setOpenDeleteDialog(false)
    }

    const handleDeleteExecutions = () => {
        deleteExecutionsApi.request(selectedExecutionIds)
        setOpenDeleteDialog(false)
    }

    useEffect(() => {
        getAllExecutions.request({ page: 1, limit: DEFAULT_ITEMS_PER_PAGE })

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        if (getAllExecutions.data) {
            try {
                const { data, total } = getAllExecutions.data
                if (!Array.isArray(data)) return
                setExecutions(data)
                setTotal(total)
            } catch {
                setExecutions([])
                setTotal(0)
            }
        }
    }, [getAllExecutions.data])

    useEffect(() => {
        setLoading(getAllExecutions.loading)
    }, [getAllExecutions.loading])

    useEffect(() => {
        setError(getAllExecutions.error)
    }, [getAllExecutions.error])

    useEffect(() => {
        if (deleteExecutionsApi.data) {
            // Refresh the executions list
            getAllExecutions.request({
                page: currentPage,
                limit: pageLimit
            })
            setSelectedExecutionIds([])
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [deleteExecutionsApi.data])

    useEffect(() => {
        if (getExecutionByIdApi.data) {
            const execution = getExecutionByIdApi.data
            const executionDetails =
                typeof execution.executionData === 'string' ? JSON.parse(execution.executionData) : execution.executionData
            setSelectedExecutionData(executionDetails)
            const newMetadata = {
                ...omit(execution, ['executionData']),
                agentflow: {
                    ...selectedMetadata.agentflow
                }
            }
            setSelectedMetadata(newMetadata)
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getExecutionByIdApi.data])

    return (
        <MainCard>
            {error ? (
                <ErrorBoundary error={error} />
            ) : (
                <Stack flexDirection='column' sx={{ gap: 3 }}>
                    <ViewHeader title='执行记录' description='监控并管理智能体流程的执行情况' />

                    {/* Filter Section */}
                    <Box sx={{ mb: 2, width: '100%' }}>
                        <Grid container spacing={2} alignItems='center'>
                            <Grid item xs={12} md={2}>
                                <FormControl fullWidth size='small'>
                                    <InputLabel id='state-select-label'>状态</InputLabel>
                                    <Select
                                        labelId='state-select-label'
                                        value={filters.state}
                                        label='状态'
                                        onChange={(e) => handleFilterChange('state', e.target.value)}
                                        size='small'
                                        sx={{
                                            '& .MuiOutlinedInput-notchedOutline': {
                                                borderColor: borderColor
                                            },
                                            '& .MuiSvgIcon-root': {
                                                color: customization.isDarkMode ? '#fff' : 'inherit'
                                            }
                                        }}
                                    >
                                        <MenuItem value=''>全部</MenuItem>
                                        <MenuItem value='INPROGRESS'>执行中</MenuItem>
                                        <MenuItem value='FINISHED'>已完成</MenuItem>
                                        <MenuItem value='ERROR'>错误</MenuItem>
                                        <MenuItem value='TERMINATED'>已终止</MenuItem>
                                        <MenuItem value='TIMEOUT'>超时</MenuItem>
                                        <MenuItem value='STOPPED'>已停止</MenuItem>
                                    </Select>
                                </FormControl>
                            </Grid>
                            <Grid item xs={12} md={2}>
                                <DatePicker
                                    selected={filters.startDate}
                                    onChange={(date) => onDateChange('startDate', date)}
                                    locale='zh-CN'
                                    dateFormat='yyyy-MM-dd'
                                    previousMonthAriaLabel='上个月'
                                    nextMonthAriaLabel='下个月'
                                    previousYearAriaLabel='上一年'
                                    nextYearAriaLabel='下一年'
                                    selectsStart
                                    startDate={filters.startDate}
                                    className='form-control'
                                    wrapperClassName='datePicker'
                                    maxDate={new Date()}
                                    customInput={
                                        <TextField
                                            size='small'
                                            label='开始日期'
                                            fullWidth
                                            sx={{
                                                '& .MuiOutlinedInput-notchedOutline': {
                                                    borderColor: borderColor
                                                }
                                            }}
                                        />
                                    }
                                />
                            </Grid>
                            <Grid sx={{ ml: -1 }} item xs={12} md={2}>
                                <DatePicker
                                    selected={filters.endDate}
                                    onChange={(date) => onDateChange('endDate', date)}
                                    locale='zh-CN'
                                    dateFormat='yyyy-MM-dd'
                                    previousMonthAriaLabel='上个月'
                                    nextMonthAriaLabel='下个月'
                                    previousYearAriaLabel='上一年'
                                    nextYearAriaLabel='下一年'
                                    selectsEnd
                                    endDate={filters.endDate}
                                    className='form-control'
                                    wrapperClassName='datePicker'
                                    minDate={filters.startDate}
                                    maxDate={new Date()}
                                    customInput={
                                        <TextField
                                            size='small'
                                            label='结束日期'
                                            fullWidth
                                            sx={{
                                                '& .MuiOutlinedInput-notchedOutline': {
                                                    borderColor: borderColor
                                                }
                                            }}
                                        />
                                    }
                                />
                            </Grid>
                            <Grid sx={{ ml: -1 }} item xs={12} md={2}>
                                <TextField
                                    fullWidth
                                    label='智能体流程'
                                    value={filters.agentflowName}
                                    onChange={(e) => handleFilterChange('agentflowName', e.target.value)}
                                    size='small'
                                    sx={{
                                        '& .MuiOutlinedInput-notchedOutline': {
                                            borderColor: borderColor
                                        }
                                    }}
                                />
                            </Grid>
                            <Grid sx={{ ml: -1 }} item xs={12} md={2}>
                                <TextField
                                    fullWidth
                                    label='会话 ID'
                                    value={filters.sessionId}
                                    onChange={(e) => handleFilterChange('sessionId', e.target.value)}
                                    size='small'
                                    sx={{
                                        '& .MuiOutlinedInput-notchedOutline': {
                                            borderColor: borderColor
                                        }
                                    }}
                                />
                            </Grid>
                            <Grid item xs={12} md={2}>
                                <Stack direction='row' spacing={1}>
                                    <Button
                                        variant='contained'
                                        color='primary'
                                        onClick={() => applyFilters(currentPage, pageLimit)}
                                        size='small'
                                    >
                                        应用
                                    </Button>
                                    <Button variant='outlined' onClick={resetFilters} size='small'>
                                        重置
                                    </Button>
                                    <Available permissions={['executions:delete']}>
                                        <Tooltip title='删除选中的执行记录'>
                                            <span>
                                                <IconButton
                                                    sx={{ height: 30, width: 30 }}
                                                    size='small'
                                                    color='error'
                                                    onClick={handleDeleteDialogOpen}
                                                    edge='end'
                                                    disabled={selectedExecutionIds.length === 0}
                                                >
                                                    <IconTrash />
                                                </IconButton>
                                            </span>
                                        </Tooltip>
                                    </Available>
                                </Stack>
                            </Grid>
                        </Grid>
                    </Box>

                    {executions?.length > 0 && (
                        <>
                            <ExecutionsListTable
                                data={executions}
                                isLoading={isLoading}
                                onSelectionChange={handleExecutionSelectionChange}
                                onExecutionRowClick={(execution) => {
                                    setOpenDrawer(true)
                                    const executionDetails =
                                        typeof execution.executionData === 'string'
                                            ? JSON.parse(execution.executionData)
                                            : execution.executionData
                                    setSelectedExecutionData(executionDetails)
                                    setSelectedMetadata(omit(execution, ['executionData']))
                                }}
                            />

                            {/* Pagination and Page Size Controls */}
                            {!isLoading && total > 0 && (
                                <TablePagination currentPage={currentPage} limit={pageLimit} total={total} onChange={onChange} />
                            )}

                            <ExecutionDetails
                                open={openDrawer}
                                execution={selectedExecutionData}
                                metadata={selectedMetadata}
                                onClose={() => setOpenDrawer(false)}
                                onProceedSuccess={() => {
                                    setOpenDrawer(false)
                                    getAllExecutions.request()
                                }}
                                onUpdateSharing={() => {
                                    getAllExecutions.request()
                                }}
                                onRefresh={(executionId) => {
                                    getAllExecutions.request()
                                    getExecutionByIdApi.request(executionId)
                                }}
                            />
                        </>
                    )}

                    {/* Delete Confirmation Dialog */}
                    <Dialog
                        open={openDeleteDialog}
                        onClose={handleDeleteDialogClose}
                        aria-labelledby='alert-dialog-title'
                        aria-describedby='alert-dialog-description'
                    >
                        <DialogTitle id='alert-dialog-title'>确认删除</DialogTitle>
                        <DialogContent>
                            <DialogContentText id='alert-dialog-description'>
                                确定要删除选中的 {selectedExecutionIds.length} 条执行记录吗？此操作无法撤销。
                            </DialogContentText>
                        </DialogContent>
                        <DialogActions>
                            <Button onClick={handleDeleteDialogClose} color='primary'>
                                取消
                            </Button>
                            <Button onClick={handleDeleteExecutions} color='error'>
                                删除
                            </Button>
                        </DialogActions>
                    </Dialog>

                    {!isLoading && (!executions || executions.length === 0) && (
                        <Stack sx={{ alignItems: 'center', justifyContent: 'center' }} flexDirection='column'>
                            <Box sx={{ p: 2, height: 'auto' }}>
                                <img
                                    style={{ objectFit: 'cover', height: '20vh', width: 'auto' }}
                                    src={execution_empty}
                                    alt='execution_empty'
                                />
                            </Box>
                            <div>暂无执行记录</div>
                        </Stack>
                    )}
                </Stack>
            )}
        </MainCard>
    )
}

export default AgentExecutions
