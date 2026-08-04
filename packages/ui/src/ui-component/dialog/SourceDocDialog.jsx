import { createPortal } from 'react-dom'
import { useState, useEffect, useMemo } from 'react'
import { useSelector } from 'react-redux'
import PropTypes from 'prop-types'
import { Box, Dialog, DialogContent, DialogTitle, Typography } from '@mui/material'
import ReactJson from 'flowise-react-json-view'

import { redactErrorDetails } from '@/utils/redactErrorDetails'

const SourceDocDialog = ({ show, dialogProps, onCancel }) => {
    const portalElement = document.getElementById('portal')
    const customization = useSelector((state) => state.customization)

    const [data, setData] = useState({})
    const redactedData = useMemo(() => redactErrorDetails(data), [data])

    useEffect(() => {
        if (dialogProps.data) setData(dialogProps.data)

        return () => {
            setData({})
        }
    }, [dialogProps])

    const component = show ? (
        <Dialog
            onClose={onCancel}
            open={show}
            fullWidth
            maxWidth='sm'
            aria-labelledby='alert-dialog-title'
            aria-describedby='alert-dialog-description'
        >
            <DialogTitle sx={{ fontSize: '1rem' }} id='alert-dialog-title'>
                {dialogProps.title ?? '来源文档'}
            </DialogTitle>
            <DialogContent>
                {data.error && (
                    <Box
                        sx={{
                            p: 2,
                            borderRadius: 1,
                            bgcolor: 'error.light',
                            color: 'error.dark',
                            overflowX: 'auto',
                            wordBreak: 'break-word'
                        }}
                    >
                        <Typography variant='body2' fontWeight='medium'>
                            错误：
                        </Typography>
                        <Typography variant='body2' sx={{ whiteSpace: 'pre-wrap' }}>
                            来源文档处理失败，详细信息仅对管理员可见
                        </Typography>
                    </Box>
                )}
                <ReactJson
                    theme={customization.isDarkMode ? 'ocean' : 'rjv-default'}
                    style={{ padding: 10, borderRadius: 10 }}
                    src={redactedData}
                    name={null}
                    quotesOnKeys={false}
                    enableClipboard={false}
                    displayDataTypes={false}
                />
            </DialogContent>
        </Dialog>
    ) : null

    return createPortal(component, portalElement)
}

SourceDocDialog.propTypes = {
    show: PropTypes.bool,
    dialogProps: PropTypes.object,
    onCancel: PropTypes.func
}

export default SourceDocDialog
