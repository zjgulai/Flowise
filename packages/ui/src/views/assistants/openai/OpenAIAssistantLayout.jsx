import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'

// material-ui
import { Alert, AlertTitle, Box, Button, Link, Stack, Skeleton } from '@mui/material'

// project imports
import MainCard from '@/ui-component/cards/MainCard'
import ItemCard from '@/ui-component/cards/ItemCard'
import AssistantDialog from './AssistantDialog'
import ViewHeader from '@/layout/MainLayout/ViewHeader'

// API
import assistantsApi from '@/api/assistants'

import AssistantEmptySVG from '@/assets/images/assistant_empty.svg'
import { gridSpacing } from '@/store/constant'
import { buildOpenAIAssistantCardIndex, filterOpenAIAssistantCards } from './openAIAssistantList'

// ==============================|| OpenAIAssistantLayout ||============================== //

const OpenAIAssistantLayout = () => {
    const navigate = useNavigate()

    const [isLoading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [assistants, setAssistants] = useState([])
    const [showDialog, setShowDialog] = useState(false)
    const [dialogProps, setDialogProps] = useState({})
    const mountedRef = useRef(false)
    const loadGenerationRef = useRef(0)
    const loadAbortControllerRef = useRef(null)
    const [search, setSearch] = useState('')
    const onSearchChange = (event) => {
        setSearch(event.target.value)
    }

    const edit = (selectedAssistant) => {
        const dialogProp = {
            title: '编辑助手',
            type: 'EDIT',
            cancelButtonName: '取消',
            confirmButtonName: '保存',
            data: selectedAssistant
        }
        setDialogProps(dialogProp)
        setShowDialog(true)
    }

    const loadAssistants = useCallback(async () => {
        loadAbortControllerRef.current?.abort()
        const abortController = new AbortController()
        loadAbortControllerRef.current = abortController
        const generation = ++loadGenerationRef.current
        const isCurrent = () =>
            mountedRef.current &&
            !abortController.signal.aborted &&
            loadGenerationRef.current === generation &&
            loadAbortControllerRef.current === abortController

        setLoading(true)
        setError('')
        try {
            const response = await assistantsApi.getAllAssistants('OPENAI', { signal: abortController.signal })
            if (!isCurrent()) return
            if (!Array.isArray(response?.data)) throw new Error('invalid_assistant_list_response')
            setAssistants(response.data)
        } catch (requestError) {
            if (
                !isCurrent() ||
                requestError?.code === 'ERR_CANCELED' ||
                requestError?.name === 'CanceledError' ||
                requestError?.name === 'AbortError'
            ) {
                return
            }
            setError('加载 OpenAI 助手失败，请稍后重试。')
        } finally {
            if (isCurrent()) setLoading(false)
        }
    }, [])

    const onConfirm = () => {
        setShowDialog(false)
        void loadAssistants()
    }

    const assistantCardIndex = useMemo(() => buildOpenAIAssistantCardIndex(assistants), [assistants])
    const visibleAssistants = useMemo(
        () => filterOpenAIAssistantCards(assistantCardIndex.cards, search),
        [assistantCardIndex.cards, search]
    )
    const invalidAssistantCount = assistantCardIndex.invalidCount

    useEffect(() => {
        mountedRef.current = true
        void loadAssistants()
        return () => {
            mountedRef.current = false
            loadGenerationRef.current += 1
            loadAbortControllerRef.current?.abort()
            loadAbortControllerRef.current = null
        }
    }, [loadAssistants])

    return (
        <>
            <MainCard>
                <Stack flexDirection='column' sx={{ gap: 3 }}>
                    <Alert severity='warning' variant='outlined'>
                        <AlertTitle>OpenAI 助手 API 将于 2026 年 8 月 26 日停止服务</AlertTitle>
                        已停用新建旧版 OpenAI 助手及新增 OpenAI 端资源；现有助手可查看、编辑、同步、解绑、删除与迁移。保存会同时更新 OpenAI
                        端助手和 Flowise 本地记录，但不会新建 OpenAI 端资源。助手本身可通过明确范围确认进行清理。请迁移到自定义助手或 OpenAI
                        响应 API。{' '}
                        <Link href='https://developers.openai.com/api/docs/assistants/migration' target='_blank' rel='noopener noreferrer'>
                            查看 OpenAI 官方迁移指南
                        </Link>
                    </Alert>
                    <ViewHeader
                        isBackButton={true}
                        onSearchChange={onSearchChange}
                        search={true}
                        searchPlaceholder='搜索助手'
                        title='OpenAI 助手'
                        description='仅用于查看、维护和迁移现有 OpenAI 助手'
                        onBack={() => navigate(-1)}
                    >
                        <Button variant='contained' sx={{ borderRadius: 2, height: 40 }} onClick={() => navigate('/assistants/custom')}>
                            前往自定义助手
                        </Button>
                    </ViewHeader>
                    {error && (
                        <Alert
                            severity='error'
                            action={
                                <Button color='inherit' size='small' onClick={() => void loadAssistants()}>
                                    重试
                                </Button>
                            }
                        >
                            {error}
                        </Alert>
                    )}
                    {invalidAssistantCount > 0 && (
                        <Alert severity='info'>检测到 {invalidAssistantCount} 条无效助手记录，已安全跳过；请由管理员检查数据。</Alert>
                    )}
                    {isLoading ? (
                        <Box display='grid' gridTemplateColumns='repeat(3, 1fr)' gap={gridSpacing}>
                            <Skeleton variant='rounded' height={160} />
                            <Skeleton variant='rounded' height={160} />
                            <Skeleton variant='rounded' height={160} />
                        </Box>
                    ) : (
                        <Box display='grid' gridTemplateColumns='repeat(3, 1fr)' gap={gridSpacing}>
                            {visibleAssistants.map((assistant) => (
                                <ItemCard
                                    data={{
                                        name: assistant.name,
                                        description: assistant.description,
                                        iconSrc: assistant.iconSrc
                                    }}
                                    key={assistant.resource.id}
                                    onClick={() => edit(assistant.resource)}
                                />
                            ))}
                        </Box>
                    )}
                    {!isLoading && !error && visibleAssistants.length === 0 && (
                        <Stack sx={{ alignItems: 'center', justifyContent: 'center' }} flexDirection='column'>
                            <Box sx={{ p: 2, height: 'auto' }}>
                                <img
                                    style={{ objectFit: 'cover', height: '20vh', width: 'auto' }}
                                    src={AssistantEmptySVG}
                                    alt='暂无 OpenAI 助手'
                                />
                            </Box>
                            <div>
                                {assistants.length === 0
                                    ? '尚未添加 OpenAI 助手'
                                    : search.trim()
                                    ? '未找到匹配的 OpenAI 助手'
                                    : '没有可显示的有效 OpenAI 助手'}
                            </div>
                        </Stack>
                    )}
                </Stack>
            </MainCard>
            <AssistantDialog
                show={showDialog}
                dialogProps={dialogProps}
                onCancel={() => setShowDialog(false)}
                onConfirm={onConfirm}
            ></AssistantDialog>
        </>
    )
}

export default OpenAIAssistantLayout
