import { useEffect, useState } from 'react'
import { useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'

// material-ui
import { Box, Chip, IconButton, Stack, ToggleButton, ToggleButtonGroup } from '@mui/material'
import { useTheme } from '@mui/material/styles'

// project imports
import AgentsEmptySVG from '@/assets/images/agents_empty.svg'
import ErrorBoundary from '@/ErrorBoundary'
import ViewHeader from '@/layout/MainLayout/ViewHeader'
import { gridSpacing } from '@/store/constant'
import { StyledPermissionButton } from '@/ui-component/button/RBACButtons'
import ItemCard from '@/ui-component/cards/ItemCard'
import MainCard from '@/ui-component/cards/MainCard'
import ConfirmDialog from '@/ui-component/dialog/ConfirmDialog'
import TablePagination, { DEFAULT_ITEMS_PER_PAGE } from '@/ui-component/pagination/TablePagination'
import { FlowListTable } from '@/ui-component/table/FlowListTable'

// API
import chatflowsApi from '@/api/chatflows'

// Hooks
import useApi from '@/hooks/useApi'

// const
import { AGENTFLOW_ICONS, baseURL } from '@/store/constant'
import { useError } from '@/store/context/ErrorContext'

// icons
import { IconAlertTriangle, IconLayoutGrid, IconList, IconPlus, IconX } from '@tabler/icons-react'

// ==============================|| AGENTS ||============================== //

const Agentflows = () => {
    const navigate = useNavigate()
    const theme = useTheme()
    const customization = useSelector((state) => state.customization)

    const [isLoading, setLoading] = useState(true)
    const [images, setImages] = useState({})
    const [icons, setIcons] = useState({})
    const [scheduleStatuses, setScheduleStatuses] = useState({})
    const [search, setSearch] = useState('')
    const { error, setError } = useError()

    const getAllAgentflows = useApi(chatflowsApi.getAllAgentflows)
    const [view, setView] = useState(localStorage.getItem('agentFlowDisplayStyle') || 'card')
    const [agentflowVersion, setAgentflowVersion] = useState(localStorage.getItem('agentFlowVersion') || 'v2')
    const [showDeprecationNotice, setShowDeprecationNotice] = useState(true)

    /* Table Pagination */
    const [currentPage, setCurrentPage] = useState(1)
    const [pageLimit, setPageLimit] = useState(() => Number(localStorage.getItem('agentFlowPageSize') || DEFAULT_ITEMS_PER_PAGE))
    const [total, setTotal] = useState(0)

    const onChange = (page, pageLimit) => {
        setCurrentPage(page)
        setPageLimit(pageLimit)
        localStorage.setItem('agentFlowPageSize', pageLimit)
        refresh(page, pageLimit, agentflowVersion, search)
    }

    const refresh = (page, limit, nextView, searchTerm = search, sort = {}) => {
        const params = {
            page: page || currentPage,
            limit: limit || pageLimit,
            search: searchTerm.trim(),
            orderBy: sort.orderBy || localStorage.getItem('agentcanvas_orderBy') || 'updatedDate',
            order: sort.order || localStorage.getItem('agentcanvas_order') || 'desc'
        }
        getAllAgentflows.request(nextView === 'v2' ? 'AGENTFLOW' : 'MULTIAGENT', params)
    }

    const onSortChange = (orderBy, order) => {
        setCurrentPage(1)
        refresh(1, pageLimit, agentflowVersion, search, { orderBy, order })
    }

    const handleChange = (event, nextView) => {
        if (nextView === null) return
        localStorage.setItem('agentFlowDisplayStyle', nextView)
        setView(nextView)
    }

    const handleVersionChange = (event, nextView) => {
        if (nextView === null) return
        localStorage.setItem('agentFlowVersion', nextView)
        setAgentflowVersion(nextView)
        setCurrentPage(1)
        refresh(1, pageLimit, nextView, search)
    }

    const onSearchChange = (event) => {
        setSearch(event.target.value)
        setCurrentPage(1)
    }

    function filterFlows(data) {
        return (
            data.name.toLowerCase().indexOf(search.toLowerCase()) > -1 ||
            (data.category && data.category.toLowerCase().indexOf(search.toLowerCase()) > -1) ||
            data.id.toLowerCase().indexOf(search.toLowerCase()) > -1
        )
    }

    const addNew = () => {
        if (agentflowVersion === 'v2') {
            navigate('/v2/agentcanvas')
        } else {
            navigate('/agentcanvas')
        }
    }

    const goToCanvas = (selectedAgentflow) => {
        if (selectedAgentflow.type === 'AGENTFLOW') {
            navigate(`/v2/agentcanvas/${selectedAgentflow.id}`)
        } else {
            navigate(`/agentcanvas/${selectedAgentflow.id}`)
        }
    }

    const handleDismissDeprecationNotice = () => {
        setShowDeprecationNotice(false)
    }

    useEffect(() => {
        const searchTimer = setTimeout(() => refresh(1, pageLimit, agentflowVersion, search), search ? 300 : 0)

        return () => clearTimeout(searchTimer)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [search])

    useEffect(() => {
        if (getAllAgentflows.error) {
            setError(getAllAgentflows.error)
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getAllAgentflows.error])

    useEffect(() => {
        setLoading(getAllAgentflows.loading)
    }, [getAllAgentflows.loading])

    useEffect(() => {
        if (getAllAgentflows.data) {
            try {
                const agentflows = getAllAgentflows.data?.data
                setTotal(getAllAgentflows.data?.total)
                const images = {}
                const icons = {}
                const scheduleConfiguredIds = []
                for (let i = 0; i < agentflows.length; i += 1) {
                    const flowDataStr = agentflows[i].flowData
                    const flowData = JSON.parse(flowDataStr)
                    const nodes = flowData.nodes || []
                    images[agentflows[i].id] = []
                    icons[agentflows[i].id] = []
                    let isScheduleFlow = false
                    for (let j = 0; j < nodes.length; j += 1) {
                        const node = nodes[j]
                        if (node.data?.name === 'startAgentflow' && node.data?.inputs?.startInputType === 'scheduleInput') {
                            isScheduleFlow = true
                        }
                        if (node.data.name === 'stickyNote' || node.data.name === 'stickyNoteAgentflow') continue
                        const foundIcon = AGENTFLOW_ICONS.find((icon) => icon.name === node.data.name)
                        if (foundIcon) {
                            icons[agentflows[i].id].push(foundIcon)
                        } else {
                            const imageSrc = `${baseURL}/api/v1/node-icon/${node.data.name}`
                            if (!images[agentflows[i].id].some((img) => img.imageSrc === imageSrc)) {
                                images[agentflows[i].id].push({
                                    imageSrc,
                                    label: node.data.label
                                })
                            }
                        }
                    }
                    if (isScheduleFlow) scheduleConfiguredIds.push(agentflows[i].id)
                }
                setImages(images)
                setIcons(icons)

                const initialStatuses = {}
                scheduleConfiguredIds.forEach((id) => {
                    initialStatuses[id] = { isScheduled: true, enabled: false, loading: true }
                })
                setScheduleStatuses(initialStatuses)

                if (scheduleConfiguredIds.length > 0) {
                    Promise.all(
                        scheduleConfiguredIds.map((id) =>
                            chatflowsApi
                                .getScheduleStatus(id)
                                .then((res) => ({ id, data: res.data }))
                                .catch(() => ({ id, error: true }))
                        )
                    ).then((results) => {
                        setScheduleStatuses((prev) => {
                            const next = { ...prev }
                            results.forEach(({ id, data, error }) => {
                                if (next[id]) {
                                    next[id] = {
                                        ...next[id],
                                        enabled: data?.enabled === true,
                                        nextRunAt: data?.record?.nextRunAt || null,
                                        cronExpression: data?.record?.cronExpression || null,
                                        loading: false,
                                        error: error === true
                                    }
                                }
                            })
                            return next
                        })
                    })
                }
            } catch {
                setError(new Error('agentflow_data_invalid'))
            }
        }
    }, [getAllAgentflows.data, setError])

    return (
        <MainCard>
            {error ? (
                <ErrorBoundary error={error} />
            ) : (
                <Stack flexDirection='column' sx={{ gap: 3 }}>
                    <ViewHeader
                        onSearchChange={onSearchChange}
                        search={true}
                        searchPlaceholder='搜索名称或分类'
                        title='智能体流程'
                        description='多智能体系统，工作流编排'
                    >
                        <ToggleButtonGroup
                            sx={{ borderRadius: 2, maxHeight: 40 }}
                            value={agentflowVersion}
                            color='primary'
                            exclusive
                            onChange={handleVersionChange}
                        >
                            <ToggleButton
                                sx={{
                                    borderColor: theme.palette.grey[900] + 25,
                                    borderRadius: 2,
                                    color: customization.isDarkMode ? 'white' : 'inherit'
                                }}
                                variant='contained'
                                value='v2'
                                title='V2'
                            >
                                <Chip sx={{ mr: 1 }} label='新功能' size='small' color='primary' />
                                V2
                            </ToggleButton>
                            <ToggleButton
                                sx={{
                                    borderColor: theme.palette.grey[900] + 25,
                                    borderRadius: 2,
                                    color: customization.isDarkMode ? 'white' : 'inherit'
                                }}
                                variant='contained'
                                value='v1'
                                title='V1'
                            >
                                V1
                            </ToggleButton>
                        </ToggleButtonGroup>
                        <ToggleButtonGroup
                            sx={{ borderRadius: 2, maxHeight: 40 }}
                            value={view}
                            disabled={total === 0}
                            color='primary'
                            exclusive
                            onChange={handleChange}
                        >
                            <ToggleButton
                                sx={{
                                    borderColor: theme.palette.grey[900] + 25,
                                    borderRadius: 2,
                                    color: customization.isDarkMode ? 'white' : 'inherit'
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
                                    color: customization.isDarkMode ? 'white' : 'inherit'
                                }}
                                variant='contained'
                                value='list'
                                title='列表视图'
                            >
                                <IconList />
                            </ToggleButton>
                        </ToggleButtonGroup>
                        <StyledPermissionButton
                            permissionId={'agentflows:create'}
                            variant='contained'
                            onClick={addNew}
                            startIcon={<IconPlus />}
                            sx={{ borderRadius: 2, height: 40 }}
                        >
                            新建
                        </StyledPermissionButton>
                    </ViewHeader>

                    {/* Deprecation Notice For V1 */}
                    {agentflowVersion === 'v1' && showDeprecationNotice && (
                        <Box
                            sx={{
                                display: 'flex',
                                alignItems: 'center',
                                padding: 2,
                                background: customization.isDarkMode
                                    ? 'linear-gradient(135deg,rgba(165, 128, 6, 0.31) 0%, #ffcc802f 100%)'
                                    : 'linear-gradient(135deg, #fff8e17a 0%, #ffcc804a 100%)',
                                color: customization.isDarkMode ? 'white' : '#333333',
                                fontWeight: 400,
                                borderRadius: 2,
                                gap: 1.5
                            }}
                        >
                            <IconAlertTriangle
                                size={20}
                                style={{
                                    color: customization.isDarkMode ? '#ffcc80' : '#f57c00',
                                    flexShrink: 0
                                }}
                            />
                            <Box sx={{ flex: 1 }}>
                                <strong>V1 智能体流程已弃用。</strong> 建议迁移到 V2 以获得更好的性能和持续支持。
                            </Box>
                            <IconButton
                                aria-label='关闭 V1 弃用提示'
                                size='small'
                                onClick={handleDismissDeprecationNotice}
                                sx={{
                                    color: customization.isDarkMode ? '#ffcc80' : '#f57c00',
                                    '&:hover': {
                                        backgroundColor: 'rgba(255, 204, 128, 0.1)'
                                    }
                                }}
                            >
                                <IconX size={16} />
                            </IconButton>
                        </Box>
                    )}
                    {!isLoading && total > 0 && (
                        <>
                            {!view || view === 'card' ? (
                                <Box
                                    display='grid'
                                    gridTemplateColumns={{ xs: '1fr', md: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' }}
                                    gap={gridSpacing}
                                >
                                    {getAllAgentflows.data?.data.filter(filterFlows).map((data, index) => (
                                        <ItemCard
                                            key={index}
                                            onClick={() => goToCanvas(data)}
                                            data={data}
                                            images={images[data.id]}
                                            icons={icons[data.id]}
                                            scheduleStatus={scheduleStatuses[data.id]}
                                        />
                                    ))}
                                </Box>
                            ) : (
                                <FlowListTable
                                    isAgentCanvas={true}
                                    isAgentflowV2={agentflowVersion === 'v2'}
                                    data={getAllAgentflows.data?.data}
                                    images={images}
                                    icons={icons}
                                    scheduleStatuses={scheduleStatuses}
                                    isLoading={isLoading}
                                    filterFunction={filterFlows}
                                    updateFlowsApi={getAllAgentflows}
                                    setError={setError}
                                    currentPage={currentPage}
                                    pageLimit={pageLimit}
                                    onSortChange={onSortChange}
                                />
                            )}
                            {/* Pagination and Page Size Controls */}
                            <TablePagination currentPage={currentPage} limit={pageLimit} total={total} onChange={onChange} />
                        </>
                    )}

                    {!isLoading && total === 0 && (
                        <Stack sx={{ alignItems: 'center', justifyContent: 'center' }} flexDirection='column'>
                            <Box sx={{ p: 2, height: 'auto' }}>
                                <img
                                    style={{ objectFit: 'cover', height: '12vh', width: 'auto' }}
                                    src={AgentsEmptySVG}
                                    alt='AgentsEmptySVG'
                                />
                            </Box>
                            <div>暂无智能体</div>
                        </Stack>
                    )}
                </Stack>
            )}
            <ConfirmDialog />
        </MainCard>
    )
}

export default Agentflows
