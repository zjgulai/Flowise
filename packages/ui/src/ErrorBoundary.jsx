// Jest's current JSX transform requires React in this module.
// eslint-disable-next-line unused-imports/no-unused-imports
import React from 'react'
import PropTypes from 'prop-types'

import { Box, Button, Card, IconButton, Stack, Typography, useTheme } from '@mui/material'
import { IconCopy } from '@tabler/icons-react'
import { getErrorMessage } from '@/utils/getErrorMessage'

const ErrorBoundary = ({ error, onBack, backLabel = '返回上一页' }) => {
    const theme = useTheme()
    const status = error?.response?.status ?? '未知'
    const message = getErrorMessage(error, '页面加载失败，请稍后重试')

    const copyToClipboard = () => {
        const errorMessage = `状态码：${status}\n${message}`
        navigator.clipboard.writeText(errorMessage)
    }

    return (
        <Box
            sx={{
                border: 1,
                borderColor: theme.palette.grey[900] + 25,
                borderRadius: 2,
                p: { xs: 2, sm: 3 },
                width: '100%',
                maxWidth: '100%',
                overflow: 'hidden'
            }}
        >
            <Stack flexDirection='column' sx={{ alignItems: 'center', gap: { xs: 2, sm: 3 } }}>
                <Stack flexDirection='column' sx={{ alignItems: 'center', gap: 1 }}>
                    <Typography variant='h2' sx={{ fontSize: { xs: '1.75rem', sm: '2.5rem' }, textAlign: 'center' }}>
                        页面加载失败
                    </Typography>
                    <Typography variant='h3' sx={{ fontSize: { xs: '1rem', sm: '1.25rem' }, textAlign: 'center' }}>
                        加载此页面时发生以下错误。
                    </Typography>
                </Stack>
                <Card variant='outlined' sx={{ width: '100%', maxWidth: 720 }}>
                    <Box sx={{ position: 'relative', px: { xs: 1.5, sm: 2 }, py: 3, overflow: 'hidden' }}>
                        <IconButton
                            onClick={copyToClipboard}
                            aria-label='复制错误详情'
                            size='small'
                            sx={{ position: 'absolute', top: 1, right: 1, color: theme.palette.grey[900] + 25 }}
                        >
                            <IconCopy />
                        </IconButton>
                        <pre
                            style={{
                                margin: 0,
                                paddingRight: '28px',
                                overflowWrap: 'anywhere',
                                whiteSpace: 'pre-wrap',
                                textAlign: 'center'
                            }}
                        >
                            <code>{`状态码：${status}`}</code>
                            <br />
                            <code>{message}</code>
                        </pre>
                    </Box>
                </Card>
                <Typography variant='body1' sx={{ fontSize: { xs: '1rem', sm: '1.1rem' }, textAlign: 'center', lineHeight: 1.6 }}>
                    请稍后重试。如问题持续存在，请联系系统管理员。
                </Typography>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ width: { xs: '100%', sm: 'auto' } }}>
                    {onBack && (
                        <Button variant='outlined' onClick={onBack} sx={{ width: { xs: '100%', sm: 'auto' } }}>
                            {backLabel}
                        </Button>
                    )}
                    <Button variant='contained' onClick={() => window.location.reload()} sx={{ width: { xs: '100%', sm: 'auto' } }}>
                        重新加载
                    </Button>
                </Stack>
            </Stack>
        </Box>
    )
}

ErrorBoundary.propTypes = {
    error: PropTypes.object,
    onBack: PropTypes.func,
    backLabel: PropTypes.string
}

export default ErrorBoundary
