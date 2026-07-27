import PropTypes from 'prop-types'
import { useRef } from 'react'

// material-ui
import { IconButton, Box, OutlinedInput, Toolbar, Typography } from '@mui/material'
import { useTheme } from '@mui/material/styles'
import { StyledFab } from '@/ui-component/button/StyledFab'

// icons
import { IconSearch, IconArrowLeft, IconEdit } from '@tabler/icons-react'

import useSearchShortcut from '@/hooks/useSearchShortcut'
import { getOS } from '@/utils/genericHelper'

const os = getOS()
const isMac = os === 'macos'
const isDesktop = isMac || os === 'windows' || os === 'linux'
const keyboardShortcut = isMac ? '[ ⌘ + F ]' : '[ Ctrl + F ]'

const ViewHeader = ({
    children,
    filters = null,
    onSearchChange,
    search,
    searchPlaceholder = '搜索',
    title,
    description,
    isBackButton,
    onBack,
    isEditButton,
    onEdit
}) => {
    const theme = useTheme()
    const searchInputRef = useRef()
    useSearchShortcut(searchInputRef)

    return (
        <Box sx={{ flexGrow: 1, py: 1.25, width: '100%' }}>
            <Toolbar
                disableGutters={true}
                sx={{
                    p: 0,
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: { xs: 'stretch', sm: 'center' },
                    flexDirection: { xs: 'column', sm: 'row' },
                    gap: { xs: 2, sm: 1 },
                    width: '100%'
                }}
            >
                <Box sx={{ display: 'flex', alignItems: 'center', flexDirection: 'row', width: { xs: '100%', sm: 'auto' }, minWidth: 0 }}>
                    {isBackButton && (
                        <StyledFab
                            sx={{ mr: { xs: 1.5, sm: 3 }, flexShrink: 0 }}
                            size='small'
                            color='secondary'
                            aria-label='返回'
                            title='返回'
                            onClick={onBack}
                        >
                            <IconArrowLeft />
                        </StyledFab>
                    )}
                    <Box sx={{ display: 'flex', alignItems: 'start', flexDirection: 'column', width: '100%', minWidth: 0 }}>
                        <Typography
                            sx={{
                                fontSize: { xs: '1.5rem', sm: '1.8rem' },
                                fontWeight: 600,
                                display: '-webkit-box',
                                WebkitLineClamp: 3,
                                WebkitBoxOrient: 'vertical',
                                textOverflow: 'ellipsis',
                                overflow: 'hidden',
                                flex: 1,
                                maxWidth: '100%',
                                overflowWrap: 'anywhere'
                            }}
                            variant='h1'
                        >
                            {title}
                        </Typography>
                        {description && (
                            <Typography
                                sx={{
                                    fontSize: '1rem',
                                    fontWeight: 500,
                                    mt: { xs: 1, sm: 2 },
                                    display: '-webkit-box',
                                    WebkitLineClamp: 5,
                                    WebkitBoxOrient: 'vertical',
                                    textOverflow: 'ellipsis',
                                    overflow: 'hidden',
                                    flex: 1,
                                    maxWidth: '100%',
                                    overflowWrap: 'anywhere'
                                }}
                            >
                                {description}
                            </Typography>
                        )}
                    </Box>
                    {isEditButton && (
                        <IconButton sx={{ ml: 3 }} color='secondary' title='编辑' onClick={onEdit}>
                            <IconEdit />
                        </IconButton>
                    )}
                </Box>
                <Box
                    sx={{
                        minHeight: 40,
                        height: 'auto',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: { xs: 'flex-start', sm: 'flex-end' },
                        flexWrap: 'wrap',
                        width: { xs: '100%', sm: 'auto' },
                        minWidth: 0,
                        maxWidth: '100%',
                        gap: 1
                    }}
                >
                    {search && (
                        <OutlinedInput
                            inputRef={searchInputRef}
                            size='small'
                            sx={{
                                width: { xs: '100%', sm: '260px', xl: '325px' },
                                height: 40,
                                display: 'flex',
                                flex: { xs: '1 1 100%', sm: '0 0 auto' },
                                borderRadius: 2,

                                '& .MuiOutlinedInput-notchedOutline': {
                                    borderRadius: 2
                                }
                            }}
                            variant='outlined'
                            placeholder={`${searchPlaceholder} ${isDesktop ? keyboardShortcut : ''}`}
                            onChange={onSearchChange}
                            startAdornment={
                                <Box
                                    sx={{
                                        color: theme.palette.grey[400],
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        mr: 1
                                    }}
                                >
                                    <IconSearch style={{ color: 'inherit', width: 16, height: 16 }} />
                                </Box>
                            }
                            type='search'
                        />
                    )}
                    {filters}
                    {children}
                </Box>
            </Toolbar>
        </Box>
    )
}

ViewHeader.propTypes = {
    children: PropTypes.node,
    filters: PropTypes.node,
    onSearchChange: PropTypes.func,
    search: PropTypes.bool,
    searchPlaceholder: PropTypes.string,
    title: PropTypes.string,
    description: PropTypes.string,
    isBackButton: PropTypes.bool,
    onBack: PropTypes.func,
    isEditButton: PropTypes.bool,
    onEdit: PropTypes.func
}

export default ViewHeader
