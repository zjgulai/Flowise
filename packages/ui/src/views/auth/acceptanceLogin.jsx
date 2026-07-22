// Jest's current JSX transform requires React in this module.
// eslint-disable-next-line unused-imports/no-unused-imports
import React, { useEffect, useState } from 'react'
import { Alert, Stack, TextField, Typography } from '@mui/material'
import { LoadingButton } from '@mui/lab'
import { useNavigate } from 'react-router-dom'

import authApi from '@/api/auth'
import useApi from '@/hooks/useApi'
import { store } from '@/store'
import { loginSuccess } from '@/store/reducers/authSlice'
import MainCard from '@/ui-component/cards/MainCard'

const ACCEPTANCE_ERROR_MESSAGE = '认证不可用或已失效，请重新生成一次性认证码。'
const ACCEPTANCE_CODE_LENGTH = 43

const AcceptanceLoginPage = () => {
    const [code, setCode] = useState('')
    const [message, setMessage] = useState('')
    const acceptanceApi = useApi(authApi.acceptanceLogin)
    const navigate = useNavigate()

    const submit = (event) => {
        event.preventDefault()
        if (code.length !== ACCEPTANCE_CODE_LENGTH || acceptanceApi.loading) return
        setMessage('')
        acceptanceApi.request({ code })
    }

    useEffect(() => {
        if (!acceptanceApi.error) return
        setCode('')
        setMessage(ACCEPTANCE_ERROR_MESSAGE)
    }, [acceptanceApi.error])

    useEffect(() => {
        if (!acceptanceApi.data) return
        setCode('')
        store.dispatch(loginSuccess(acceptanceApi.data))
        navigate('/account', { replace: true })
    }, [acceptanceApi.data, navigate])

    return (
        <MainCard maxWidth='sm'>
            <Stack sx={{ width: '100%', maxWidth: '480px', gap: 3 }}>
                <Stack sx={{ gap: 1 }}>
                    <Typography variant='h1'>受控验收入口</Typography>
                    <Typography variant='body2' color='text.secondary'>
                        输入本次验收生成的一次性认证码。认证码仅可使用一次。
                    </Typography>
                </Stack>
                {message && (
                    <Alert severity='error' variant='filled'>
                        {message}
                    </Alert>
                )}
                <form onSubmit={submit}>
                    <Stack sx={{ width: '100%', gap: 2 }}>
                        <TextField
                            id='acceptance-code'
                            name='code'
                            label='一次性认证码'
                            type='password'
                            autoComplete='one-time-code'
                            value={code}
                            onChange={(event) => setCode(event.target.value)}
                            inputProps={{ maxLength: ACCEPTANCE_CODE_LENGTH }}
                            fullWidth
                            required
                        />
                        <LoadingButton
                            type='submit'
                            variant='contained'
                            loading={acceptanceApi.loading}
                            disabled={acceptanceApi.loading || code.length !== ACCEPTANCE_CODE_LENGTH}
                            sx={{ minHeight: 42, borderRadius: 3 }}
                        >
                            进入工作台
                        </LoadingButton>
                    </Stack>
                </form>
            </Stack>
        </MainCard>
    )
}

export default AcceptanceLoginPage
