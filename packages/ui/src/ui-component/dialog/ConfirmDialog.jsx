import { createPortal } from 'react-dom'
import { useEffect, useId } from 'react'
import { Button, Dialog, DialogActions, DialogContent, DialogTitle } from '@mui/material'
import useConfirm from '@/hooks/useConfirm'
import { StyledButton } from '@/ui-component/button/StyledButton'

const ConfirmDialog = () => {
    const rendererId = `confirm-renderer-${useId()}`
    const titleId = `${rendererId}-title`
    const descriptionId = `${rendererId}-description`
    const { activeRendererId, onConfirm, onCancel, confirmState, registerRenderer } = useConfirm()
    const portalElement = document.getElementById('portal')

    useEffect(() => registerRenderer(rendererId), [registerRenderer, rendererId])

    const component =
        activeRendererId === rendererId && confirmState.show ? (
            <Dialog
                fullWidth
                maxWidth='xs'
                open={confirmState.show}
                onClose={onCancel}
                aria-labelledby={titleId}
                aria-describedby={descriptionId}
            >
                <DialogTitle sx={{ fontSize: '1rem' }} id={titleId}>
                    {confirmState.title}
                </DialogTitle>
                <DialogContent id={descriptionId}>
                    <span>{confirmState.description}</span>
                </DialogContent>
                <DialogActions>
                    <Button onClick={onCancel}>{confirmState.cancelButtonName}</Button>
                    <StyledButton variant='contained' onClick={onConfirm}>
                        {confirmState.confirmButtonName}
                    </StyledButton>
                </DialogActions>
            </Dialog>
        ) : null

    return portalElement ? createPortal(component, portalElement) : null
}

export default ConfirmDialog
