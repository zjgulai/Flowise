import unauthorizedSVG from '@/assets/images/unauthorized.svg'
import MainCard from '@/ui-component/cards/MainCard'
import { Box, Stack, Typography } from '@mui/material'

const AccessRestricted = () => (
    <MainCard>
        <Box
            sx={{
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                minHeight: '420px'
            }}
        >
            <Stack alignItems='center' justifyContent='center' spacing={2} textAlign='center'>
                <Box sx={{ p: 2, height: 'auto' }}>
                    <img
                        style={{ objectFit: 'contain', height: '18vh', maxHeight: '180px', width: 'auto' }}
                        src={unauthorizedSVG}
                        alt='管理入口未公开'
                    />
                </Box>
                <Typography variant='h3' component='h1' fontWeight='bold'>
                    管理入口未公开
                </Typography>
                <Typography variant='body1' color='text.secondary' sx={{ maxWidth: '360px' }}>
                    此站点不提供公开登录。授权运维人员请使用受控认证通道。
                </Typography>
            </Stack>
        </Box>
    </MainCard>
)

export default AccessRestricted
