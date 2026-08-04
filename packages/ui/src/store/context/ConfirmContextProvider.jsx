import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import { initialState } from '../reducers/dialogReducer'
import ConfirmContext from './ConfirmContext'

const ConfirmContextProvider = ({ children }) => {
    const [state, setState] = useState(initialState)
    const [activeRendererId, setActiveRendererId] = useState(null)
    const pendingRequestRef = useRef(null)
    const rendererIdsRef = useRef([])
    const requestSequenceRef = useRef(0)

    const settleRequest = useCallback((requestId, result) => {
        const pendingRequest = pendingRequestRef.current
        if (!pendingRequest || pendingRequest.id !== requestId) return false

        pendingRequestRef.current = null
        setState(initialState)
        pendingRequest.resolve(result)
        return true
    }, [])

    const requestConfirm = useCallback((payload, ownerId) => {
        const replacedRequest = pendingRequestRef.current
        if (replacedRequest) {
            pendingRequestRef.current = null
            replacedRequest.resolve(false)
        }

        const requestId = `confirm-request-${++requestSequenceRef.current}`
        setState({
            ...initialState,
            ...payload,
            show: true,
            requestId
        })

        return new Promise((resolve) => {
            pendingRequestRef.current = { id: requestId, ownerId, resolve }
        })
    }, [])

    const cancelOwnerRequests = useCallback(
        (ownerId) => {
            const pendingRequest = pendingRequestRef.current
            if (pendingRequest?.ownerId === ownerId) settleRequest(pendingRequest.id, false)
        },
        [settleRequest]
    )

    const registerRenderer = useCallback((rendererId) => {
        if (!rendererIdsRef.current.includes(rendererId)) rendererIdsRef.current.push(rendererId)
        setActiveRendererId((currentId) => currentId ?? rendererIdsRef.current[0] ?? null)

        return () => {
            const wasActive = rendererIdsRef.current[0] === rendererId
            rendererIdsRef.current = rendererIdsRef.current.filter((id) => id !== rendererId)
            if (wasActive) {
                const pendingRequest = pendingRequestRef.current
                if (pendingRequest) {
                    pendingRequestRef.current = null
                    setState(initialState)
                    pendingRequest.resolve(false)
                }
                setActiveRendererId(rendererIdsRef.current[0] ?? null)
            }
        }
    }, [])

    useEffect(
        () => () => {
            const pendingRequest = pendingRequestRef.current
            pendingRequestRef.current = null
            if (pendingRequest) pendingRequest.resolve(false)
        },
        []
    )

    const contextValue = useMemo(
        () => ({
            activeRendererId,
            cancelOwnerRequests,
            registerRenderer,
            requestConfirm,
            settleRequest,
            state
        }),
        [activeRendererId, cancelOwnerRequests, registerRenderer, requestConfirm, settleRequest, state]
    )

    return <ConfirmContext.Provider value={contextValue}>{children}</ConfirmContext.Provider>
}

ConfirmContextProvider.propTypes = {
    children: PropTypes.any
}

export default ConfirmContextProvider
