import PropTypes from 'prop-types'
import { Navigate, useLocation } from 'react-router-dom'

const hasValidMarketplaceState = (state) => {
    if (!state || typeof state.flowData !== 'string') return false

    try {
        const flowData = JSON.parse(state.flowData)
        return Boolean(flowData && typeof flowData === 'object' && Array.isArray(flowData.nodes) && Array.isArray(flowData.edges))
    } catch {
        return false
    }
}

export const MarketplaceRouteGuard = ({ children }) => {
    const { state } = useLocation()

    if (!hasValidMarketplaceState(state)) return <Navigate to='/marketplaces' replace />

    return children
}

MarketplaceRouteGuard.propTypes = {
    children: PropTypes.node
}
