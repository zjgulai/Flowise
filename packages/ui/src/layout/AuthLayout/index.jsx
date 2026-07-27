import { Outlet, useLocation } from 'react-router-dom'
import { Box, useTheme } from '@mui/material'

// ==============================|| MINIMAL LAYOUT ||============================== //

const AuthLayout = () => {
    const theme = useTheme()
    const { pathname } = useLocation()
    const isFullBleedAuthPage = pathname === '/signin' || pathname === '/login'

    return (
        <Box
            sx={{
                width: '100%',
                minHeight: '100vh',
                boxSizing: 'border-box',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                px: isFullBleedAuthPage ? 0 : 2,
                '& > *': {
                    width: '100%',
                    maxWidth: isFullBleedAuthPage ? 'none' : '512px'
                },
                [theme.breakpoints.between('md', 1367)]: {
                    alignItems: 'start',
                    overflowY: 'auto',
                    py: isFullBleedAuthPage ? 0 : '64px'
                }
            }}
        >
            <Outlet />
        </Box>
    )
}

export default AuthLayout
