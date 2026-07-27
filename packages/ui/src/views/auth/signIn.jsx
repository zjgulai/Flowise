import { useEffect, useState } from 'react'
import { useSelector } from 'react-redux'
import { Link, useLocation, useNavigate } from 'react-router-dom'

import { Alert, Box, Chip, Stack, Typography } from '@mui/material'
import { LoadingButton } from '@mui/lab'
import { IconArrowRight, IconCheck, IconExclamationCircle, IconLock, IconRoute, IconShieldCheck } from '@tabler/icons-react'

import { Input } from '@/ui-component/input/Input'
import useApi from '@/hooks/useApi'
import { useError } from '@/store/context/ErrorContext'
import authApi from '@/api/auth'
import useNotifier from '@/utils/useNotifier'
import { parseSignInError } from './signInError'
import { loginSuccess, logoutSuccess } from '@/store/reducers/authSlice'
import { store } from '@/store'

const SAFE_LOGIN_ERROR = '无法登录，请确认管理员邮箱和密码后重试。'

const assuranceItems = [
    {
        icon: IconRoute,
        title: '流程集中编排',
        description: '在一个工作台管理智能体、知识与自动化链路。'
    },
    {
        icon: IconShieldCheck,
        title: '权限边界清晰',
        description: '当前版本仅向既有授权管理员开放。'
    },
    {
        icon: IconLock,
        title: '数据留在控制域',
        description: '登录不会触发模型调用或创建新的业务账户。'
    }
]

const SignInPage = () => {
    useSelector((state) => state.customization)
    useNotifier()

    const usernameInput = {
        label: '管理员邮箱',
        name: 'username',
        type: 'email',
        placeholder: 'admin@company.com',
        autoComplete: 'username',
        ariaLabel: '管理员邮箱'
    }
    const passwordInput = {
        label: '密码',
        name: 'password',
        type: 'password',
        placeholder: '请输入管理员密码',
        autoComplete: 'current-password',
        ariaLabel: '管理员密码',
        enablePasswordToggle: true,
        showPasswordLabel: '显示密码',
        hidePasswordLabel: '隐藏密码'
    }
    const [usernameVal, setUsernameVal] = useState('')
    const [passwordVal, setPasswordVal] = useState('')
    const [authError, setAuthError] = useState(undefined)
    const [loading, setLoading] = useState(false)
    const { authRateLimitError, setAuthRateLimitError } = useError()

    const loginApi = useApi(authApi.login)
    const navigate = useNavigate()
    const location = useLocation()

    const doLogin = (event) => {
        event.preventDefault()
        setAuthRateLimitError(null)
        setAuthError(undefined)

        if (!usernameVal.trim() || !passwordVal) {
            setAuthError('请输入管理员邮箱和密码。')
            return
        }

        setLoading(true)
        loginApi.request({ email: usernameVal.trim(), password: passwordVal })
    }

    useEffect(() => {
        if (!loginApi.error) return

        setLoading(false)
        const status = loginApi.error?.response?.status
        const redirectUrl = loginApi.error?.response?.data?.redirectUrl
        if (status === 401 && redirectUrl === '/license-expired') {
            window.location.href = redirectUrl
            return
        }
        setAuthError(SAFE_LOGIN_ERROR)
    }, [loginApi.error])

    useEffect(() => {
        store.dispatch(logoutSuccess())
        setAuthRateLimitError(null)
    }, [setAuthRateLimitError])

    useEffect(() => {
        const queryParams = new URLSearchParams(location.search)
        const parsedError = parseSignInError(queryParams.get('error'))
        if (parsedError) setAuthError(SAFE_LOGIN_ERROR)
    }, [location.search])

    useEffect(() => {
        if (!loginApi.data) return

        setLoading(false)
        store.dispatch(loginSuccess(loginApi.data))
        navigate(location.state?.path || '/')
    }, [location.state?.path, loginApi.data, navigate])

    return (
        <Box
            component='main'
            sx={{
                width: '100%',
                minHeight: '100vh',
                display: 'grid',
                gridTemplateColumns: { xs: '1fr', lg: 'minmax(0, 1.08fr) minmax(480px, 0.92fr)' },
                backgroundColor: '#F5F2EA'
            }}
        >
            <Box
                component='section'
                aria-label='产品介绍'
                sx={{
                    position: 'relative',
                    overflow: 'hidden',
                    minHeight: { xs: 220, sm: 280, lg: '100vh' },
                    px: { xs: 3, sm: 6, lg: 8, xl: 12 },
                    py: { xs: 3, sm: 5, lg: 7 },
                    color: '#F8F5EC',
                    backgroundColor: '#0C2230',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    '&::after': {
                        content: '""',
                        position: 'absolute',
                        width: { xs: 240, lg: 520 },
                        height: { xs: 240, lg: 520 },
                        right: { xs: -130, lg: -210 },
                        bottom: { xs: -175, lg: -220 },
                        border: '1px solid rgba(130, 203, 183, 0.26)',
                        borderRadius: '50%',
                        boxShadow: '0 0 0 72px rgba(130, 203, 183, 0.035), 0 0 0 144px rgba(130, 203, 183, 0.025)'
                    }
                }}
            >
                <Stack spacing={{ xs: 3, lg: 8 }} sx={{ position: 'relative', zIndex: 1 }}>
                    <Stack direction='row' alignItems='center' spacing={1.5}>
                        <Box
                            aria-hidden='true'
                            sx={{
                                width: 34,
                                height: 34,
                                display: 'grid',
                                placeItems: 'center',
                                border: '1px solid rgba(248, 245, 236, 0.48)',
                                borderRadius: '9px',
                                transform: 'rotate(45deg)'
                            }}
                        >
                            <Box sx={{ width: 10, height: 10, bgcolor: '#82CBB7', borderRadius: '2px' }} />
                        </Box>
                        <Typography sx={{ fontSize: 20, fontWeight: 700, letterSpacing: '0.04em' }}>FlowAgentic</Typography>
                        <Chip
                            label='管理控制台'
                            size='small'
                            sx={{ color: '#C9DED7', bgcolor: 'rgba(130, 203, 183, 0.1)', border: '1px solid rgba(130, 203, 183, 0.24)' }}
                        />
                    </Stack>

                    <Stack spacing={2.5} sx={{ maxWidth: 680 }}>
                        <Typography
                            component='h1'
                            sx={{
                                fontSize: { xs: 32, sm: 44, lg: 58, xl: 66 },
                                lineHeight: 1.08,
                                fontWeight: 650,
                                letterSpacing: '-0.045em',
                                maxWidth: 650
                            }}
                        >
                            让每一次智能流转，
                            <Box component='span' sx={{ color: '#82CBB7' }}>
                                都有清晰的控制边界
                            </Box>
                        </Typography>
                        <Typography
                            sx={{ color: 'rgba(237, 241, 236, 0.68)', fontSize: { xs: 15, lg: 18 }, lineHeight: 1.8, maxWidth: 570 }}
                        >
                            面向团队的智能体编排与知识工作台。把复杂流程收进可观察、可管理、可回退的统一控制面。
                        </Typography>
                    </Stack>

                    <Box sx={{ display: { xs: 'none', lg: 'grid' }, gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 1.5 }}>
                        {assuranceItems.map(({ icon: AssuranceIcon, title, description }) => (
                            <Stack
                                key={title}
                                spacing={1.5}
                                sx={{
                                    p: 2.25,
                                    minHeight: 168,
                                    borderTop: '1px solid rgba(248, 245, 236, 0.22)',
                                    bgcolor: 'rgba(255,255,255,0.025)'
                                }}
                            >
                                <AssuranceIcon size={22} color='#82CBB7' stroke={1.6} />
                                <Typography sx={{ fontWeight: 650, fontSize: 15 }}>{title}</Typography>
                                <Typography sx={{ color: 'rgba(237, 241, 236, 0.58)', fontSize: 13, lineHeight: 1.65 }}>
                                    {description}
                                </Typography>
                            </Stack>
                        ))}
                    </Box>
                </Stack>

                <Stack direction='row' alignItems='center' spacing={1} sx={{ position: 'relative', zIndex: 1, mt: { xs: 4, lg: 8 } }}>
                    <Box
                        sx={{
                            width: 7,
                            height: 7,
                            borderRadius: '50%',
                            bgcolor: '#82CBB7',
                            boxShadow: '0 0 0 5px rgba(130, 203, 183, 0.11)'
                        }}
                    />
                    <Typography sx={{ color: 'rgba(237, 241, 236, 0.64)', fontSize: 13 }}>管理员专属入口 · 新用户注册已关闭</Typography>
                </Stack>
            </Box>

            <Box
                component='section'
                aria-label='管理员登录'
                sx={{
                    px: { xs: 3, sm: 8, lg: 8, xl: 12 },
                    py: { xs: 5, sm: 7, lg: 6 },
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minWidth: 0
                }}
            >
                <Stack sx={{ width: '100%', maxWidth: 480 }} spacing={4}>
                    <Stack spacing={1.5}>
                        <Stack direction='row' alignItems='center' spacing={1}>
                            <IconCheck size={17} color='#16725D' />
                            <Typography sx={{ color: '#16725D', fontSize: 13, fontWeight: 700, letterSpacing: '0.08em' }}>
                                仅限授权管理员
                            </Typography>
                        </Stack>
                        <Typography
                            component='h2'
                            sx={{ color: '#142833', fontSize: { xs: 32, sm: 40 }, fontWeight: 700, letterSpacing: '-0.035em' }}
                        >
                            管理员登录
                        </Typography>
                        <Typography sx={{ color: '#607079', fontSize: 15, lineHeight: 1.7 }}>
                            使用现有管理员账号进入工作台。当前不开放新用户注册。
                        </Typography>
                    </Stack>

                    <Stack aria-live='polite' spacing={1.5}>
                        {authRateLimitError && (
                            <Alert icon={<IconExclamationCircle />} severity='error'>
                                {authRateLimitError}
                            </Alert>
                        )}
                        {authError && (
                            <Alert icon={<IconExclamationCircle />} severity='error'>
                                {authError}
                            </Alert>
                        )}
                    </Stack>

                    <Box component='form' onSubmit={doLogin} noValidate>
                        <Stack spacing={2.75}>
                            <Box
                                sx={{
                                    '& .MuiOutlinedInput-root': { bgcolor: '#FCFBF7' },
                                    '& .Mui-focused .MuiOutlinedInput-notchedOutline': { borderWidth: 2 }
                                }}
                            >
                                <Typography component='label' htmlFor='username' sx={{ color: '#253B45', fontSize: 14, fontWeight: 650 }}>
                                    管理员邮箱
                                </Typography>
                                <Input inputParam={usernameInput} onChange={setUsernameVal} value={usernameVal} />
                            </Box>
                            <Box
                                sx={{
                                    '& .MuiOutlinedInput-root': { bgcolor: '#FCFBF7' },
                                    '& .Mui-focused .MuiOutlinedInput-notchedOutline': { borderWidth: 2 }
                                }}
                            >
                                <Stack direction='row' alignItems='center' justifyContent='space-between'>
                                    <Typography
                                        component='label'
                                        htmlFor='password'
                                        sx={{ color: '#253B45', fontSize: 14, fontWeight: 650 }}
                                    >
                                        密码
                                    </Typography>
                                    <Link
                                        to='/forgot-password'
                                        style={{ color: '#16725D', fontSize: 13, fontWeight: 600, textDecoration: 'none' }}
                                    >
                                        忘记密码？
                                    </Link>
                                </Stack>
                                <Input inputParam={passwordInput} onChange={setPasswordVal} value={passwordVal} />
                            </Box>
                            <LoadingButton
                                loading={loading}
                                variant='contained'
                                type='submit'
                                endIcon={<IconArrowRight size={18} />}
                                sx={{
                                    minHeight: 50,
                                    borderRadius: '8px',
                                    bgcolor: '#0C2230',
                                    fontSize: 15,
                                    fontWeight: 700,
                                    boxShadow: 'none',
                                    '&:hover': { bgcolor: '#163747', boxShadow: '0 8px 22px rgba(12, 34, 48, 0.18)' }
                                }}
                            >
                                进入工作台
                            </LoadingButton>
                        </Stack>
                    </Box>

                    <Box sx={{ pt: 2.5, borderTop: '1px solid #D9D6CD' }}>
                        <Typography sx={{ color: '#78858A', fontSize: 12.5, lineHeight: 1.7 }}>
                            登录即表示你正在访问受保护的管理区域。系统会记录必要的安全活动，但不会在登录阶段调用外部模型服务。
                        </Typography>
                    </Box>
                </Stack>
            </Box>
        </Box>
    )
}

export default SignInPage
