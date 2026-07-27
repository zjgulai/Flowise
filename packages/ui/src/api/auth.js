import client from './client'

// auth
const resolveLogin = (body) => client.post(`/auth/resolve`, body)
const login = (body) => client.post(`/auth/login`, body)
const acceptanceLogin = (body) => client.post('/auth/acceptance-login', body)

// permissions
const getAllPermissions = (type) => client.get(`/auth/permissions/${type}`)
const ssoSuccess = (token) => client.get(`/auth/sso-success?token=${token}`)

export default {
    resolveLogin,
    login,
    acceptanceLogin,
    getAllPermissions,
    ssoSuccess
}
