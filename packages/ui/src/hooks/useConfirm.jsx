import { useContext, useEffect, useId, useRef } from 'react'
import ConfirmContext from '@/store/context/ConfirmContext'

const useConfirm = () => {
    const context = useContext(ConfirmContext)
    const ownerId = useId()
    const ownerIdRef = useRef(`confirm-owner-${ownerId}`)

    if (!context) throw new Error('useConfirm must be used within ConfirmContextProvider')

    const { activeRendererId, cancelOwnerRequests, registerRenderer, requestConfirm, settleRequest, state: confirmState } = context

    useEffect(() => () => cancelOwnerRequests(ownerIdRef.current), [cancelOwnerRequests])

    const onConfirm = () => settleRequest(confirmState.requestId, true)
    const onCancel = () => settleRequest(confirmState.requestId, false)
    const confirm = (confirmPayload) => requestConfirm(confirmPayload, ownerIdRef.current)

    return { activeRendererId, confirm, onConfirm, onCancel, confirmState, registerRenderer }
}

export default useConfirm
