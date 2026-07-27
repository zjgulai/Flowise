import { useEffect } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

// material-ui
import { Stack, Typography, Box, useTheme, CircularProgress, Button } from '@mui/material'

// project imports
import MainCard from '@/ui-component/cards/MainCard'

// API
import accountApi from '@/api/account.api'

// Hooks
import useApi from '@/hooks/useApi'

// icons
import { IconCheck } from '@tabler/icons-react'
import { useState } from 'react'
import { IconX } from '@tabler/icons-react'

const VerifyEmail = () => {
    const accountVerifyApi = useApi(accountApi.verifyAccountEmail)

    const [searchParams] = useSearchParams()
    const [loading, setLoading] = useState(false)
    const [verificationError, setVerificationError] = useState('')
    const [verificationSuccess, setVerificationSuccess] = useState(false)
    const navigate = useNavigate()

    const theme = useTheme()

    useEffect(() => {
        if (accountVerifyApi.data) {
            setLoading(false)
            setVerificationError('')
            setVerificationSuccess(true)
            setTimeout(() => {
                navigate('/signin')
            }, 3000)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [accountVerifyApi.data])

    useEffect(() => {
        if (accountVerifyApi.error) {
            setLoading(false)
            setVerificationError('验证链接无效或已过期。')
            setVerificationSuccess(false)
        }
    }, [accountVerifyApi.error])

    useEffect(() => {
        const token = searchParams.get('token')
        if (token) {
            setLoading(true)
            setVerificationError('')
            setVerificationSuccess(false)
            accountVerifyApi.request({ user: { tempToken: token } })
        } else {
            setVerificationError('验证链接缺少令牌。')
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    return (
        <MainCard>
            <Stack flexDirection='column' sx={{ width: '100%', maxWidth: '480px', gap: 3 }}>
                <Stack sx={{ width: '100%', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                    <Stack sx={{ alignItems: 'center', gap: 2 }}>
                        {loading && (
                            <>
                                <CircularProgress
                                    sx={{
                                        width: '48px',
                                        height: '48px'
                                    }}
                                />
                                <Typography variant='h1'>正在验证邮箱…</Typography>
                            </>
                        )}
                        {verificationError && (
                            <>
                                <Box
                                    sx={{
                                        width: '48px',
                                        height: '48px',
                                        borderRadius: '100%',
                                        backgroundColor: theme.palette.error.main,
                                        color: 'white',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center'
                                    }}
                                >
                                    <IconX />
                                </Box>
                                <Typography variant='h1'>邮箱验证失败</Typography>
                                <Typography variant='body2' color='text.secondary' sx={{ textAlign: 'center' }}>
                                    {verificationError}
                                </Typography>
                                <Button variant='contained' onClick={() => navigate('/signin', { replace: true })}>
                                    返回登录
                                </Button>
                            </>
                        )}
                        {verificationSuccess && (
                            <>
                                <Box
                                    sx={{
                                        width: '48px',
                                        height: '48px',
                                        borderRadius: '100%',
                                        backgroundColor: theme.palette.success.main,
                                        color: 'white',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center'
                                    }}
                                >
                                    <IconCheck />
                                </Box>
                                <Typography variant='h1'>邮箱验证成功</Typography>
                            </>
                        )}
                    </Stack>
                </Stack>
            </Stack>
        </MainCard>
    )
}

export default VerifyEmail
