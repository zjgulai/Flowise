import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { z } from 'zod/v3'

// material-ui
import { Alert, Box, Button, Chip, Divider, Icon, List, ListItemText, Stack, Typography } from '@mui/material'

// project imports
import { StyledButton } from '@/ui-component/button/StyledButton'
import { Input } from '@/ui-component/input/Input'
import { BackdropLoader } from '@/ui-component/loading/BackdropLoader'

// API
import accountApi from '@/api/account.api'
import authApi from '@/api/auth'
import loginMethodApi from '@/api/loginmethod'

// Hooks
import useApi from '@/hooks/useApi'
import { store } from '@/store'
import { loginSuccess } from '@/store/reducers/authSlice'

// utils
import useNotifier from '@/utils/useNotifier'
import { passwordSchema } from '@/utils/validation'

// Icons
import Auth0SSOLoginIcon from '@/assets/images/auth0.svg'
import GoogleSSOLoginIcon from '@/assets/images/google.svg'
import AzureSSOLoginIcon from '@/assets/images/microsoft-azure.svg'
import { useConfig } from '@/store/context/ConfigContext'
import { IconCircleCheck, IconExclamationCircle } from '@tabler/icons-react'

// ==============================|| Organization & Admin User Setup ||============================== //

// IMPORTANT: when updating this schema, update the schema on the server as well
// packages/server/src/enterprise/Interface.Enterprise.ts
const OrgSetupSchema = z
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

const OrganizationSetupPage = () => {
    useNotifier()
    const { isEnterpriseLicensed, isOpenSource } = useConfig()

    const orgNameInput = {
        label: '组织',
        name: 'organization',
        type: 'text',
        placeholder: 'Acme'
    }

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

    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [confirmPassword, setConfirmPassword] = useState('')
    const [username, setUsername] = useState('')
    const [orgName, setOrgName] = useState('')

    const [loading, setLoading] = useState(false)
    const [authError, setAuthError] = useState('')
    const [successMsg, setSuccessMsg] = useState(undefined)

    const loginApi = useApi(authApi.login)
    const registerAccountApi = useApi(accountApi.registerAccount)
    const navigate = useNavigate()

    const getDefaultProvidersApi = useApi(loginMethodApi.getDefaultLoginMethods)
    const [configuredSsoProviders, setConfiguredSsoProviders] = useState([])

    const register = async (event) => {
        event.preventDefault()
        const result = OrgSetupSchema.safeParse({
            orgName,
            username,
            email,
            password,
            confirmPassword
        })
        if (result.success) {
            setLoading(true)
            setAuthError('')

            // Proceed with registration after successful authentication
            const body = {
                user: {
                    name: username,
                    email: email,
                    credential: password
                }
            }
            if (isEnterpriseLicensed) {
                body.organization = {
                    name: orgName
                }
            }
            await registerAccountApi.request(body)
        } else {
            // Handle validation errors
            const errorMessages = result.error.errors.map((error) => error.message)
            setAuthError(errorMessages.join(', '))
        }
    }

    useEffect(() => {
        if (registerAccountApi.error) {
            const errMessage =
                typeof registerAccountApi.error.response.data === 'object'
                    ? registerAccountApi.error.response.data.message
                    : registerAccountApi.error.response.data
            let finalErrMessage = ''
            if (isEnterpriseLicensed) {
                finalErrMessage = `注册组织时出错，请联系管理员。(${errMessage})`
            } else {
                finalErrMessage = `注册账户时出错：${errMessage}`
            }
            setAuthError(finalErrMessage)
            setLoading(false)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [registerAccountApi.error])

    useEffect(() => {
        if (!isOpenSource) {
            getDefaultProvidersApi.request()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        if (getDefaultProvidersApi.data && getDefaultProvidersApi.data.providers) {
            setConfiguredSsoProviders(getDefaultProvidersApi.data.providers.map((provider) => provider))
        }
    }, [getDefaultProvidersApi.data])

    useEffect(() => {
        if (registerAccountApi.data) {
            setAuthError(undefined)
            setConfirmPassword('')
            setPassword('')
            setUsername('')
            setEmail('')
            setSuccessMsg(registerAccountApi.data.message)
            setTimeout(() => {
                const body = {
                    email,
                    password
                }
                loginApi.request(body)
            }, 1000)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [registerAccountApi.data])

    useEffect(() => {
        if (loginApi.data) {
            setLoading(false)
            store.dispatch(loginSuccess(loginApi.data))
            localStorage.setItem('username', loginApi.data.name)
            navigate(location.state?.path || '/')
            //navigate(0)
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loginApi.data])

    const signInWithSSO = (ssoProvider) => {
        window.location.href = `/api/v1/${ssoProvider}/login`
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
                    {successMsg && (
                        <Alert icon={<IconCircleCheck />} variant='filled' severity='success'>
                            {successMsg}
                        </Alert>
                    )}
                    <Stack sx={{ gap: 1 }}>
                        <Typography variant='h1'>设置账户</Typography>
                    </Stack>
                    {(isOpenSource || isEnterpriseLicensed) && (
                        <Typography variant='caption'>账户设置不会建立任何外部连接，您的数据将安全地保存在本地托管服务器上。</Typography>
                    )}
                    <form onSubmit={register}>
                        <Stack sx={{ width: '100%', flexDirection: 'column', alignItems: 'left', justifyContent: 'center', gap: 2 }}>
                            {isEnterpriseLicensed && (
                                <>
                                    <Box>
                                        <div style={{ display: 'flex', flexDirection: 'row' }}>
                                            <Typography>
                                                组织名称:<span style={{ color: 'red' }}>&nbsp;*</span>
                                            </Typography>
                                            <div style={{ flexGrow: 1 }}></div>
                                        </div>
                                        <Input
                                            inputParam={orgNameInput}
                                            placeholder='组织名称'
                                            onChange={(newValue) => setOrgName(newValue)}
                                            value={orgName}
                                            showDialog={false}
                                        />
                                    </Box>
                                    <Box>
                                        <Divider>
                                            <Chip label='账户管理员' size='small' />
                                        </Divider>
                                    </Box>
                                </>
                            )}
                            <Box>
                                <div style={{ display: 'flex', flexDirection: 'row' }}>
                                    <Typography>
                                        管理员姓名<span style={{ color: 'red' }}>&nbsp;*</span>
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
                                    <i>仅用于显示目的。</i>
                                </Typography>
                            </Box>
                            <Box>
                                <div style={{ display: 'flex', flexDirection: 'row' }}>
                                    <Typography>
                                        管理员邮箱<span style={{ color: 'red' }}>&nbsp;*</span>
                                    </Typography>
                                    <div style={{ flexGrow: 1 }}></div>
                                </div>
                                <Input
                                    inputParam={emailInput}
                                    onChange={(newValue) => setEmail(newValue)}
                                    type='email'
                                    value={email}
                                    showDialog={false}
                                />
                                <Typography variant='caption'>
                                    <i>请使用有效的邮箱地址，将作为登录账号使用。</i>
                                </Typography>
                            </Box>
                            <Box>
                                <div style={{ display: 'flex', flexDirection: 'row' }}>
                                    <Typography>
                                        密码<span style={{ color: 'red' }}>&nbsp;*</span>
                                    </Typography>
                                    <div style={{ flexGrow: 1 }}></div>
                                </div>
                                <Input inputParam={passwordInput} onChange={(newValue) => setPassword(newValue)} value={password} />
                                <Typography variant='caption'>
                                    <i>密码必须至少为 8 个字符，且包含至少一个小写字母、一个大写字母、一个数字和一个特殊字符。</i>
                                </Typography>
                            </Box>
                            <Box>
                                <div style={{ display: 'flex', flexDirection: 'row' }}>
                                    <Typography>
                                        确认密码<span style={{ color: 'red' }}>&nbsp;*</span>
                                    </Typography>
                                    <div style={{ flexGrow: 1 }}></div>
                                </div>
                                <Input
                                    inputParam={confirmPasswordInput}
                                    onChange={(newValue) => setConfirmPassword(newValue)}
                                    value={confirmPassword}
                                />
                                <Typography variant='caption'>
                                    <i>请再次确认密码，必须与上面输入的密码一致。</i>
                                </Typography>
                            </Box>
                            <StyledButton variant='contained' style={{ borderRadius: 12, height: 40, marginRight: 5 }} type='submit'>
                                创建账户
                            </StyledButton>
                            {configuredSsoProviders && configuredSsoProviders.length > 0 && <Divider sx={{ width: '100%' }}>或</Divider>}
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
                                                使用 Microsoft 注册
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
                                                使用 Google 注册
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
                                                使用 Auth0 注册
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

export default OrganizationSetupPage
