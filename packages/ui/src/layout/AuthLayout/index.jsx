import { Outlet } from 'react-router-dom'
import { Box, useTheme } from '@mui/material'

// ==============================|| MINIMAL LAYOUT ||============================== //

const AuthLayout = () => {
    const theme = useTheme()

    return (
        <Box
            sx={{
                width: '100%',
                minHeight: '100vh',
                boxSizing: 'border-box',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                px: 2,
                '& > *': {
                    width: '100%',
                    maxWidth: '512px'
                },
                [theme.breakpoints.down(1367)]: {
                    alignItems: 'start',
                    overflowY: 'auto',
                    py: '64px'
                }
            }}
        >
            <Outlet />
        </Box>
    )
}

export default AuthLayout
