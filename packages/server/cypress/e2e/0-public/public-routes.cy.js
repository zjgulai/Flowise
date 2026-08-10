describe('isolated public routes', () => {
    const consoleErrors = []
    const consoleWarnings = []
    const chromiumGcmCheckinPath = '/__flowise-e2e__/chromium-gcm-checkin'

    const assertNoHorizontalOverflow = () => {
        cy.document().then((document) => {
            expect(document.documentElement.scrollWidth).to.be.at.most(document.documentElement.clientWidth)
            expect(document.body.scrollWidth).to.be.at.most(document.documentElement.clientWidth)
        })
    }

    beforeEach(() => {
        consoleErrors.length = 0
        consoleWarnings.length = 0
        cy.viewport(375, 812)

        expect(Cypress.env('runId')).to.match(/^[a-zA-Z0-9-]{1,80}$/)
        expect(Cypress.env('candidateRevision')).to.match(/^[0-9a-f]{40,64}$/)

        cy.on('window:before:load', (browserWindow) => {
            const originalError = browserWindow.console.error.bind(browserWindow.console)
            const originalWarn = browserWindow.console.warn.bind(browserWindow.console)
            browserWindow.console.error = (...args) => {
                consoleErrors.push(args.map((value) => String(value)).join(' '))
                originalError(...args)
            }
            browserWindow.console.warn = (...args) => {
                consoleWarnings.push(args.map((value) => String(value)).join(' '))
                originalWarn(...args)
            }
        })

        const baseUrl = new URL(Cypress.config('baseUrl'))
        expect(baseUrl.protocol).to.eq('http:')
        expect(['127.0.0.1', 'localhost', '[::1]']).to.include(baseUrl.hostname)

        cy.intercept({ url: '**', middleware: true }, (request) => {
            const requestUrl = new URL(request.url)
            if (['http:', 'https:'].includes(requestUrl.protocol) && requestUrl.origin !== baseUrl.origin) {
                throw new Error('Unexpected external request in public route gate')
            }
            if (requestUrl.origin === baseUrl.origin && requestUrl.pathname === chromiumGcmCheckinPath) {
                const contentType = String(request.headers['content-type'] || '')
                    .split(';', 1)[0]
                    .trim()
                    .toLowerCase()
                if (request.method.toUpperCase() !== 'POST' || requestUrl.search || contentType !== 'application/x-protobuf') {
                    throw new Error('Invalid Chromium GCM check-in request')
                }
                request.reply({ statusCode: 503, body: '' })
            }
        })
    })

    afterEach(() => {
        cy.then(() => {
            expect(consoleErrors, 'application console errors').to.deep.eq([])
            expect(consoleWarnings, 'application console warnings').to.deep.eq([])
        })
    })

    it('renders the mobile administrator sign-in entry without submitting credentials', () => {
        cy.visit('/signin')
        cy.location('pathname').should('eq', '/signin')
        cy.contains('h2', '管理员登录').should('be.visible')
        cy.get('input[name="username"]').should('be.visible')
        cy.get('input[name="password"]').should('be.visible')
        cy.get('a[href="/forgot-password"]').should('contain.text', '忘记密码？')
        cy.contains('button', '进入工作台').should('be.visible')
        assertNoHorizontalOverflow()
    })

    it('redirects the closed registration route to the administrator sign-in entry', () => {
        cy.visit('/register')
        cy.location('pathname').should('eq', '/signin')
        cy.contains('h2', '管理员登录').should('be.visible')
        assertNoHorizontalOverflow()
    })

    it('renders password recovery without sending a reset request', () => {
        cy.visit('/forgot-password')
        cy.location('pathname').should('eq', '/forgot-password')
        cy.contains('h1', '忘记密码？').should('be.visible')
        cy.get('input[name="username"]').should('be.visible')
        cy.contains('button', '发送重置密码说明').should('be.disabled')
        cy.get('a[href="/reset-password"]').should('be.visible')
        assertNoHorizontalOverflow()
    })

    it('keeps ping and auth bootstrap method semantics exact on a fresh isolated database', () => {
        cy.request('/api/v1/ping').then((response) => {
            expect(response.status).to.eq(200)
            expect(response.body).to.eq('pong')
        })

        cy.request({ method: 'GET', url: '/api/v1/auth/resolve', failOnStatusCode: false }).then((response) => {
            expect(response.status).to.eq(405)
            expect(response.headers.allow).to.eq('POST')
            expect(response.body).to.deep.eq({ statusCode: 405, success: false, message: 'Method Not Allowed' })
        })

        cy.request({ method: 'POST', url: '/api/v1/auth/resolve', body: {} }).then((response) => {
            expect(response.status).to.eq(200)
            expect(response.body).to.deep.eq({ redirectUrl: '/organization-setup' })
        })
    })
})
