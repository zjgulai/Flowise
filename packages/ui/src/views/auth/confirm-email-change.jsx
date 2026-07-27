import { useEffect, useState } from 'react'
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
import { IconCheck, IconX } from '@tabler/icons-react'

const ConfirmEmailChange = () => {
    const confirmApi = useApi(accountApi.confirmEmailChange)

    const [searchParams] = useSearchParams()
    const [loading, setLoading] = useState(false)
    const [errorMessage, setErrorMessage] = useState('')
    const [success, setSuccess] = useState(false)
    const navigate = useNavigate()

    const theme = useTheme()

    useEffect(() => {
        if (confirmApi.data) {
            setLoading(false)
            setErrorMessage('')
            setSuccess(true)
            setTimeout(() => {
                navigate('/signin')
            }, 3000)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [confirmApi.data])

    useEffect(() => {
        if (confirmApi.error) {
            setLoading(false)
            setErrorMessage('邮箱变更链接无效或已过期。')
            setSuccess(false)
        }
    }, [confirmApi.error])

    useEffect(() => {
        const token = searchParams.get('token')
        if (token) {
            setLoading(true)
            setErrorMessage('')
            setSuccess(false)
            confirmApi.request({ user: { tempToken: token } })
        } else {
            setErrorMessage('邮箱变更链接缺少令牌。')
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
                                <Typography variant='h1'>正在确认邮箱变更…</Typography>
                            </>
                        )}
                        {errorMessage && (
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
                                <Typography variant='h1'>邮箱变更失败</Typography>
                                <Typography variant='body2' color='textSecondary' sx={{ textAlign: 'center' }}>
                                    {errorMessage}
                                </Typography>
                                <Button variant='contained' onClick={() => navigate('/signin', { replace: true })}>
                                    返回登录
                                </Button>
                            </>
                        )}
                        {success && (
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
                                <Typography variant='h1'>邮箱变更成功</Typography>
                                <Typography variant='body2' color='textSecondary' sx={{ textAlign: 'center' }}>
                                    请使用新邮箱地址登录。
                                </Typography>
                            </>
                        )}
                    </Stack>
                </Stack>
            </Stack>
        </MainCard>
    )
}

export default ConfirmEmailChange
