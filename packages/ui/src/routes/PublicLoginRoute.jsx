import { useConfig } from '@/store/context/ConfigContext'
import AccessRestricted from '@/views/auth/accessRestricted'
import PropTypes from 'prop-types'

export const PublicLoginRoute = ({ children }) => {
    const { config, loading } = useConfig()

    if (loading) return null

    return config.PUBLIC_LOGIN_ENABLED === false ? <AccessRestricted /> : children
}

PublicLoginRoute.propTypes = {
    children: PropTypes.element
}
