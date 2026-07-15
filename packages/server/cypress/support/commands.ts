/// <reference types="cypress" />

type LocalOwner = {
    email: string
    name: string
    password: string
}

declare global {
    namespace Cypress {
        interface Chainable {
            ensureLocalOwner(): Chainable<void>
            loginAsLocalOwner(): Chainable<void>
        }
    }
}

const assertIsolatedBrowserOrigin = () => {
    const baseUrl = Cypress.config('baseUrl')
    if (Cypress.env('isolated') !== true || !baseUrl) {
        throw new Error('Authenticated Cypress commands require the isolated local E2E runner')
    }

    const parsed = new URL(baseUrl)
    if (
        parsed.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
        parsed.username ||
        parsed.password
    ) {
        throw new Error('Authenticated Cypress commands require a loopback HTTP origin')
    }
}

const getLocalOwner = () => cy.task<LocalOwner>('getLocalOwner', null, { log: false })

const storeAuthenticatedUser = (browserWindow: Cypress.AUTWindow, payload: Record<string, unknown>) => {
    const user = {
        id: payload.id,
        email: payload.email,
        name: payload.name,
        status: payload.status,
        role: payload.role,
        isSSO: payload.isSSO,
        activeOrganizationId: payload.activeOrganizationId,
        activeOrganizationSubscriptionId: payload.activeOrganizationSubscriptionId,
        activeOrganizationCustomerId: payload.activeOrganizationCustomerId,
        activeOrganizationProductId: payload.activeOrganizationProductId,
        activeWorkspaceId: payload.activeWorkspaceId,
        activeWorkspace: payload.activeWorkspace,
        lastLogin: payload.lastLogin,
        isOrganizationAdmin: payload.isOrganizationAdmin,
        assignedWorkspaces: payload.assignedWorkspaces,
        permissions: payload.permissions
    }

    browserWindow.localStorage.setItem('isAuthenticated', 'true')
    browserWindow.localStorage.setItem('isGlobal', String(Boolean(payload.isOrganizationAdmin)))
    browserWindow.localStorage.setItem('isSSO', String(Boolean(payload.isSSO)))
    browserWindow.localStorage.setItem('user', JSON.stringify(user))
    browserWindow.localStorage.setItem('permissions', JSON.stringify(payload.permissions ?? []))
    browserWindow.localStorage.setItem('features', JSON.stringify(payload.features ?? {}))
}

Cypress.Commands.add('ensureLocalOwner', () => {
    assertIsolatedBrowserOrigin()
    return getLocalOwner().then((owner) =>
        cy
            .request({ method: 'POST', url: '/api/v1/auth/resolve', body: {}, log: false })
            .then((response) => {
                const redirectUrl = response.body?.redirectUrl
                if (redirectUrl === '/signin') return
                if (redirectUrl !== '/organization-setup') {
                    throw new Error(`Unexpected local authentication redirect: ${String(redirectUrl)}`)
                }
                return cy.request({
                    method: 'POST',
                    url: '/api/v1/account/register',
                    body: { user: { name: owner.name, email: owner.email, credential: owner.password } },
                    log: false
                })
            })
            .then(() => undefined)
    )
})

Cypress.Commands.add('loginAsLocalOwner', () => {
    assertIsolatedBrowserOrigin()
    return getLocalOwner().then((owner) =>
        cy.session(
            ['local-owner', owner.email],
            () => {
                cy.visit('/api/v1/ping', { log: false })
                cy.ensureLocalOwner()
                cy.request({
                    method: 'POST',
                    url: '/api/v1/auth/login',
                    body: { email: owner.email, password: owner.password },
                    log: false
                }).then((response) => {
                    cy.window({ log: false }).then((browserWindow) => storeAuthenticatedUser(browserWindow, response.body))
                    cy.getCookie('token', { log: false }).should('not.be.null')
                    cy.getCookie('connect.sid', { log: false }).should('not.be.null')
                    cy.request({
                        method: 'GET',
                        url: `/api/v1/user?email=${encodeURIComponent(owner.email)}`,
                        headers: { 'x-request-from': 'internal' },
                        failOnStatusCode: false,
                        log: false
                    })
                        .its('status')
                        .should('eq', 200)
                })
            },
            {
                validate() {
                    cy.request({
                        method: 'GET',
                        url: `/api/v1/user?email=${encodeURIComponent(owner.email)}`,
                        headers: { 'x-request-from': 'internal' },
                        failOnStatusCode: false,
                        log: false
                    })
                        .its('status')
                        .should('eq', 200)
                }
            }
        )
    )
})

export {}
