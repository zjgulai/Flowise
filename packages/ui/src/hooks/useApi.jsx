import { useEffect, useRef, useState } from 'react'
import { useError } from '@/store/context/ErrorContext'

export default (apiFunc) => {
    const [data, setData] = useState(null)
    const [loading, setLoading] = useState(false)
    const [error, setApiError] = useState(null)
    const { setError, handleError } = useError()
    const requestSequenceRef = useRef(0)
    const mountedRef = useRef(true)

    useEffect(() => {
        mountedRef.current = true
        return () => {
            mountedRef.current = false
            requestSequenceRef.current += 1
        }
    }, [])

    const reset = () => {
        requestSequenceRef.current += 1
        setData(null)
        setLoading(false)
        setApiError(null)
        setError(null)
    }

    const request = async (...args) => {
        const requestSequence = ++requestSequenceRef.current
        setLoading(true)
        try {
            const result = await apiFunc(...args)
            if (!mountedRef.current || requestSequence !== requestSequenceRef.current) return
            setData(result.data)
            setError(null)
            setApiError(null)
        } catch (err) {
            if (!mountedRef.current || requestSequence !== requestSequenceRef.current) return
            handleError(err || 'Unexpected Error!')
            setApiError(err || 'Unexpected Error!')
        } finally {
            if (mountedRef.current && requestSequence === requestSequenceRef.current) setLoading(false)
        }
    }

    return {
        error,
        data,
        loading,
        request,
        reset
    }
}
