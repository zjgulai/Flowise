import { Box, Skeleton, Typography } from '@mui/material'
import { useTheme } from '@mui/material/styles'
import PropTypes from 'prop-types'
import { StyledButton } from '@/ui-component/button/StyledButton'

const TrialInfo = ({ billingPortalUrl, isLoading, paymentMethodExists, trialDaysLeft }) => {
    const theme = useTheme()

    return (
        <Box
            sx={{
                p: '24px',
                py: 2,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'start',
                gap: 2,
                borderTop: 1,
                borderBottom: '1px solid',
                borderColor: theme.palette.grey[900] + 25,
                width: '100%'
            }}
        >
            {isLoading ? (
                <Box display='flex' flexDirection='column' gap={1} sx={{ width: '100%' }}>
                    <Skeleton width='100%' height={32} />
                    <Skeleton width='100%' height={32} />
                </Box>
            ) : (
                <>
                    <Typography variant='body1' color='inherit' sx={{ lineHeight: '1.5' }}>
                        试用期还剩{' '}
                        <Typography variant='' color='error'>
                            {trialDaysLeft} 天
                        </Typography>{' '}
                        。{!paymentMethodExists ? '请更新付款方式，以免服务中断。' : ''}
                    </Typography>
                    {!paymentMethodExists && (
                        <StyledButton
                            component='a'
                            href={billingPortalUrl}
                            target='_blank'
                            rel='noreferrer'
                            variant='contained'
                            sx={{ borderRadius: 2, height: 32, width: '100%' }}
                        >
                            更新付款方式
                        </StyledButton>
                    )}
                </>
            )}
        </Box>
    )
}

TrialInfo.propTypes = {
    billingPortalUrl: PropTypes.string,
    isLoading: PropTypes.bool,
    paymentMethodExists: PropTypes.bool,
    trialDaysLeft: PropTypes.number
}

export default TrialInfo
