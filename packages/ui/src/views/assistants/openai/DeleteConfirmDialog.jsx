import { createPortal } from 'react-dom'
import PropTypes from 'prop-types'
import { useId } from 'react'
import { Button, Dialog, DialogActions, DialogContent, DialogTitle } from '@mui/material'
import { StyledButton } from '@/ui-component/button/StyledButton'

const DeleteConfirmDialog = ({ show, dialogProps, onCancel, onDelete, onDeleteBoth }) => {
    const portalElement = document.getElementById('portal')
    const dialogId = `assistant-delete-${useId()}`
    const titleId = `${dialogId}-title`
    const descriptionId = `${dialogId}-description`

    const component = show ? (
        <Dialog fullWidth maxWidth='xs' open={show} onClose={onCancel} aria-labelledby={titleId} aria-describedby={descriptionId}>
            <DialogTitle sx={{ fontSize: '1rem' }} id={titleId}>
                {dialogProps.title}
            </DialogTitle>
            <DialogContent id={descriptionId}>
                <span>{dialogProps.description}</span>
                <div style={{ display: 'flex', flexDirection: 'row', marginTop: 20 }}>
                    <Button sx={{ flex: 1, mb: 1, mr: 1 }} color='error' variant='outlined' onClick={onDelete}>
                        仅删除 Flowise 记录
                    </Button>
                    <StyledButton sx={{ flex: 1, mb: 1, ml: 1 }} color='error' variant='contained' onClick={onDeleteBoth}>
                        永久删除 OpenAI 与 Flowise 记录
                    </StyledButton>
                </div>
            </DialogContent>
            <DialogActions>
                <Button onClick={onCancel}>{dialogProps.cancelButtonName ?? '取消'}</Button>
            </DialogActions>
        </Dialog>
    ) : null

    return portalElement ? createPortal(component, portalElement) : null
}

DeleteConfirmDialog.propTypes = {
    show: PropTypes.bool,
    dialogProps: PropTypes.object,
    onDeleteBoth: PropTypes.func,
    onDelete: PropTypes.func,
    onCancel: PropTypes.func
}

export default DeleteConfirmDialog
