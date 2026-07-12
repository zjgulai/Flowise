import { useEffect, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { z } from 'zod/v3'

// material-ui
import { Alert, Box, Button, Divider, Icon, List, ListItemText, OutlinedInput, Stack, Typography, useTheme } from '@mui/material'

// project imports
import { StyledButton } from '@/ui-component/button/StyledButton'
import { Input } from '@/ui-component/input/Input'
import { BackdropLoader } from '@/ui-component/loading/BackdropLoader'

// API
import accountApi from '@/api/account.api'
import loginMethodApi from '@/api/loginmethod'
import ssoApi from '@/api/sso'

// Hooks
import useApi from '@/hooks/useApi'
import { useConfig } from '@/store/context/ConfigContext'
import { useError } from '@/store/context/ErrorContext'

// utils
import useNotifier from '@/utils/useNotifier'
import { passwordSchema } from '@/utils/validation'

// Icons
import Auth0SSOLoginIcon from '@/assets/images/auth0.svg'
import GithubSSOLoginIcon from '@/assets/images/github.svg'
import GoogleSSOLoginIcon from '@/assets/images/google.svg'
import AzureSSOLoginIcon from '@/assets/images/microsoft-azure.svg'
import { store } from '@/store'
import { loginSuccess } from '@/store/reducers/authSlice'
import { IconCircleCheck, IconExclamationCircle } from '@tabler/icons-react'

// ==============================|| Register ||============================== //

// IMPORTANT: when updating this schema, update the schema on the server as well
// packages/server/src/enterprise/Interface.Enterprise.ts
const RegisterEnterpriseUserSchema = z
    .object({
        username: z.string().min(1, '名称是必填项'),
        email: z.string().min(1, '邮箱是必填项').email('邮箱地址无效'),
        password: passwordSchema,
        confirmPassword: z.string().min(1, '确认密码是必填项'),
        token: z.string().min(1, '邀请码是必填项')
    })
    .refine((data) => data.password === data.confirmPassword, {
        message: '密码不一致',
        path: ['confirmPassword']
    })

const RegisterCloudUserSchema = z
    .object({
        username: z.string().min(1, '名称是必填项'),
        email: z.string().min(1, '邮箱是必填项').email('邮箱地址无效'),
        password: passwordSchema,
        confirmPassword: z.string().min(1, '确认密码是必填项')
    })
    .refine((data) => data.password === data.confirmPassword, {
        message: '密码不一致',
        path: ['confirmPassword']
    })

const RegisterPage = () => {
    const theme = useTheme()
    useNotifier()
    const { isEnterpriseLicensed, isCloud, isOpenSource, loading: configLoading } = useConfig()

    const usernameInput = {
        label: '用户名',
        name: 'username',
        type: 'text',
        placeholder: '张三'
    }

    const passwordInput = {
        label: '密码',
        name: 'password',
        type: 'password',
        placeholder: '********'
    }

    const confirmPasswordInput = {
        label: '确认密码',
        name: 'confirmPassword',
        type: 'password',
        placeholder: '********'
    }

    const emailInput = {
        label: '邮箱',
        name: 'email',
        type: 'email',
        placeholder: 'user@company.com'
    }

    const inviteCodeInput = {
        label: '邀请码',
        name: 'inviteCode',
        type: 'text'
    }

    const [params] = useSearchParams()

    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [token, setToken] = useState(params.get('token') ?? '')
    const [username, setUsername] = useState('')
    const [configuredSsoProviders, setConfiguredSsoProviders] = useState([])

    const [loading, setLoading] = useState(false)
    const [authError, setAuthError] = useState('')
    const [successMsg, setSuccessMsg] = useState('')

    const { authRateLimitError, setAuthRateLimitError } = useError()

    const registerApi = useApi(accountApi.registerAccount)
    const ssoLoginApi = useApi(ssoApi.ssoLogin)
    const getDefaultProvidersApi = useApi(loginMethodApi.getDefaultLoginMethods)
    const navigate = useNavigate()

    const register = async (event) => {
        event.preventDefault()
        setAuthRateLimitError(null)
        if (isEnterpriseLicensed) {
            const result = RegisterEnterpriseUserSchema.safeParse({
                username,
                email,
                token,
                password,
                confirmPassword
            })
            if (result.success) {
                setLoading(true)
                const body = {
                    user: {
                        name: username,
                        email,
                        credential: password,
                        tempToken: token
                    }
                }
                await registerApi.request(body)
            } else {
                const errorMessages = result.error.errors.map((err) => err.message)
                setAuthError(errorMessages.join(', '))
            }
        } else if (isCloud) {
            const formData = new FormData(event.target)
            const referral = formData.get('referral')
            const result = RegisterCloudUserSchema.safeParse({
                username,
                email,
                password,
                confirmPassword
            })
            if (result.success) {
                setLoading(true)
                const body = {
                    user: {
                        name: username,
                        email,
                        credential: password
                    }
                }
                if (referral) {
                    body.user.referral = referral
                }
                await registerApi.request(body)
            } else {
                const errorMessages = result.error.errors.map((err) => err.message)
                setAuthError(errorMessages.join(', '))
            }
        }
    }

    const signInWithSSO = (ssoProvider) => {
        //ssoLoginApi.request(ssoProvider)
        window.location.href = `/api/v1/${ssoProvider}/login`
    }

    useEffect(() => {
        if (registerApi.error) {
            if (isEnterpriseLicensed) {
                setAuthError(`注册用户出错，请联系管理员。 (${registerApi.error?.response?.data?.message})`)
            } else if (isCloud) {
                setAuthError(`注册用户出错，请重试。`)
            }
            setLoading(false)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [registerApi.error])

    useEffect(() => {
        setAuthRateLimitError(null)
        if (!isOpenSource) {
            getDefaultProvidersApi.request()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        if (!configLoading && isOpenSource) {
            navigate('/signin', { replace: true })
        }
    }, [configLoading, isOpenSource, navigate])

    useEffect(() => {
        if (ssoLoginApi.data) {
            store.dispatch(loginSuccess(ssoLoginApi.data))
            navigate(location.state?.path || '/')
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ssoLoginApi.data])

    useEffect(() => {
        if (ssoLoginApi.error) {
            if (ssoLoginApi.error?.response?.status === 401 && ssoLoginApi.error?.response?.data.redirectUrl) {
                window.location.href = ssoLoginApi.error.response.data.redirectUrl
            } else {
                setAuthError(ssoLoginApi.error.message)
            }
        }
    }, [ssoLoginApi.error])

    useEffect(() => {
        if (getDefaultProvidersApi.data && getDefaultProvidersApi.data.providers) {
            //data is an array of objects, store only the provider attribute
            setConfiguredSsoProviders(getDefaultProvidersApi.data.providers.map((provider) => provider))
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getDefaultProvidersApi.data])

    useEffect(() => {
        if (registerApi.data) {
            setLoading(false)
            setAuthError(undefined)
            setConfirmPassword('')
            setPassword('')
            setToken('')
            setUsername('')
            setEmail('')
            if (isEnterpriseLicensed) {
                setSuccessMsg('注册成功，即将跳转到登录页面。')
            } else if (isCloud) {
                setSuccessMsg('请查收邮件并点击验证链接以完成注册。')
            }
            setTimeout(() => {
                navigate('/signin')
            }, 3000)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [registerApi.data])

    if (configLoading || isOpenSource) {
        return null
    }

    return (
        <>
            <Box
                sx={{
                    width: '100%',
                    maxHeight: '100vh',
                    overflowY: 'auto',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    padding: '24px'
                }}
            >
                <Stack flexDirection='column' sx={{ width: '100%', maxWidth: '480px', gap: 3 }}>
                    {authError && (
                        <Alert icon={<IconExclamationCircle />} variant='filled' severity='error'>
                            {authError.split(', ').length > 0 ? (
                                <List dense sx={{ py: 0 }}>
                                    {authError.split(', ').map((error, index) => (
                                        <ListItemText key={index} primary={error} primaryTypographyProps={{ color: '#fff !important' }} />
                                    ))}
                                </List>
                            ) : (
                                authError
                            )}
                        </Alert>
                    )}
                    {authRateLimitError && (
                        <Alert icon={<IconExclamationCircle />} variant='filled' severity='error'>
                            {authRateLimitError}
                        </Alert>
                    )}
                    {successMsg && (
                        <Alert icon={<IconCircleCheck />} variant='filled' severity='success'>
                            {successMsg}
                        </Alert>
                    )}
                    <Stack sx={{ gap: 1 }}>
                        <Typography variant='h1'>注册</Typography>
                        <Typography variant='body2' sx={{ color: theme.palette.grey[600] }}>
                            已有账户？{' '}
                            <Link style={{ color: theme.palette.primary.main }} to='/signin'>
                                登录
                            </Link>
                            .
                        </Typography>
                    </Stack>
                    <form onSubmit={register} data-rewardful>
                        <Stack sx={{ width: '100%', flexDirection: 'column', alignItems: 'left', justifyContent: 'center', gap: 2 }}>
                            <Box>
                                <div style={{ display: 'flex', flexDirection: 'row' }}>
                                    <Typography>
                                        姓名<span style={{ color: 'red' }}>&nbsp;*</span>
                                    </Typography>
                                    <div style={{ flexGrow: 1 }}></div>
                                </div>
                                <Input
                                    inputParam={usernameInput}
                                    placeholder='显示名称'
                                    onChange={(newValue) => setUsername(newValue)}
                                    value={username}
                                    showDialog={false}
                                />
                                <Typography variant='caption'>
                                    <i>仅用于显示。</i>
                                </Typography>
                            </Box>
                            <Box>
                                <div style={{ display: 'flex', flexDirection: 'row' }}>
                                    <Typography>
                                        Email<span style={{ color: 'red' }}>&nbsp;*</span>
                                    </Typography>
                                    <div style={{ flexGrow: 1 }}></div>
                                </div>
                                <Input
                                    inputParam={emailInput}
                                    onChange={(newValue) => setEmail(newValue)}
                                    value={email}
                                    showDialog={false}
                                />
                                <Typography variant='caption'>
                                    <i>请使用有效的邮箱地址，将用作登录账号。</i>
                                </Typography>
                            </Box>
                            {isEnterpriseLicensed && (
                                <Box>
                                    <div style={{ display: 'flex', flexDirection: 'row' }}>
                                        <Typography>
                                            邀请码<span style={{ color: 'red' }}>&nbsp;*</span>
                                        </Typography>
                                        <div style={{ flexGrow: 1 }}></div>
                                    </div>
                                    <OutlinedInput
                                        fullWidth
                                        type='string'
                                        placeholder='粘贴邀请码'
                                        multiline={false}
                                        inputParam={inviteCodeInput}
                                        onChange={(e) => setToken(e.target.value)}
                                        value={token}
                                    />
                                    <Typography variant='caption'>
                                        <i>请复制您应该在邮箱中收到的令牌。</i>
                                    </Typography>
                                </Box>
                            )}
                            <Box>
                                <div style={{ display: 'flex', flexDirection: 'row' }}>
                                    <Typography>
                                        Password<span style={{ color: 'red' }}>&nbsp;*</span>
                                    </Typography>
                                    <div style={{ flexGrow: 1 }}></div>
                                </div>
                                <Input inputParam={passwordInput} onChange={(newValue) => setPassword(newValue)} value={password} />
                                <Typography variant='caption'>
                                    <i>
                                        Password must be at least 8 characters long and contain at least one lowercase letter, one uppercase
                                        letter, one digit, and one special character.
                                    </i>
                                </Typography>
                            </Box>
                            <Box>
                                <div style={{ display: 'flex', flexDirection: 'row' }}>
                                    <Typography>
                                        Confirm Password<span style={{ color: 'red' }}>&nbsp;*</span>
                                    </Typography>
                                    <div style={{ flexGrow: 1 }}></div>
                                </div>
                                <Input
                                    inputParam={confirmPasswordInput}
                                    onChange={(newValue) => setConfirmPassword(newValue)}
                                    value={confirmPassword}
                                />
                                <Typography variant='caption'>
                                    <i>确认密码，必须与上面输入的密码一致。</i>
                                </Typography>
                            </Box>
                            <StyledButton variant='contained' style={{ borderRadius: 12, height: 40, marginRight: 5 }} type='submit'>
                                创建账户
                            </StyledButton>
                            {configuredSsoProviders.length > 0 && <Divider sx={{ width: '100%' }}>OR</Divider>}
                            {configuredSsoProviders &&
                                configuredSsoProviders.map(
                                    (ssoProvider) =>
                                        //https://learn.microsoft.com/en-us/entra/identity-platform/howto-add-branding-in-apps
                                        ssoProvider === 'azure' && (
                                            <Button
                                                key={ssoProvider}
                                                variant='outlined'
                                                style={{ borderRadius: 12, height: 45, marginRight: 5, lineHeight: 0 }}
                                                onClick={() => signInWithSSO(ssoProvider)}
                                                startIcon={
                                                    <Icon>
                                                        <img src={AzureSSOLoginIcon} alt={'MicrosoftSSO'} width={20} height={20} />
                                                    </Icon>
                                                }
                                            >
                                                使用 Microsoft 登录
                                            </Button>
                                        )
                                )}
                            {configuredSsoProviders &&
                                configuredSsoProviders.map(
                                    (ssoProvider) =>
                                        ssoProvider === 'google' && (
                                            <Button
                                                key={ssoProvider}
                                                variant='outlined'
                                                style={{ borderRadius: 12, height: 45, marginRight: 5, lineHeight: 0 }}
                                                onClick={() => signInWithSSO(ssoProvider)}
                                                startIcon={
                                                    <Icon>
                                                        <img src={GoogleSSOLoginIcon} alt={'GoogleSSO'} width={20} height={20} />
                                                    </Icon>
                                                }
                                            >
                                                使用 Google 登录
                                            </Button>
                                        )
                                )}
                            {configuredSsoProviders &&
                                configuredSsoProviders.map(
                                    (ssoProvider) =>
                                        ssoProvider === 'auth0' && (
                                            <Button
                                                key={ssoProvider}
                                                variant='outlined'
                                                style={{ borderRadius: 12, height: 45, marginRight: 5, lineHeight: 0 }}
                                                onClick={() => signInWithSSO(ssoProvider)}
                                                startIcon={
                                                    <Icon>
                                                        <img src={Auth0SSOLoginIcon} alt={'Auth0SSO'} width={20} height={20} />
                                                    </Icon>
                                                }
                                            >
                                                使用 Auth0 登录
                                            </Button>
                                        )
                                )}
                            {configuredSsoProviders &&
                                configuredSsoProviders.map(
                                    (ssoProvider) =>
                                        ssoProvider === 'github' && (
                                            <Button
                                                key={ssoProvider}
                                                variant='outlined'
                                                style={{ borderRadius: 12, height: 45, marginRight: 5, lineHeight: 0 }}
                                                onClick={() => signInWithSSO(ssoProvider)}
                                                startIcon={
                                                    <Icon>
                                                        <img src={GithubSSOLoginIcon} alt={'GithubSSO'} width={20} height={20} />
                                                    </Icon>
                                                }
                                            >
                                                使用 Github 登录
                                            </Button>
                                        )
                                )}
                        </Stack>
                    </form>
                </Stack>
            </Box>
            {loading && <BackdropLoader open={loading} />}
        </>
    )
}

export default RegisterPage
