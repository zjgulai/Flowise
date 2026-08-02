describe('authenticated ten-module PC shell', () => {
    const modules = [
        { route: '/chatflows', title: '对话流程', screenshot: '01-chatflows' },
        { route: '/agentflows', title: '智能体流程', screenshot: '02-agentflows' },
        { route: '/executions', title: '执行记录', screenshot: '03-executions' },
        { route: '/assistants', title: '助手', screenshot: '04-assistants' },
        { route: '/marketplaces', title: '模板市场', screenshot: '05-marketplaces' },
        { route: '/tools', title: '工具', screenshot: '06-tools' },
        { route: '/document-stores', title: '文档库', screenshot: '07-document-stores' },
        { route: '/credentials', title: '凭据', screenshot: '08-credentials' },
        { route: '/variables', title: '变量', screenshot: '09-variables' },
        { route: '/apikey', title: 'API 密钥', screenshot: '10-api-keys' }
    ]
    const consoleErrors = []
    const consoleWarnings = []
    const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
    const providerExecutionPrefixes = [
        '/api/v1/prediction',
        '/api/v1/internal-prediction',
        '/api/v1/chatmessage',
        '/api/v1/internal-chatmessage',
        '/api/v1/vector',
        '/api/v1/openai-realtime',
        '/api/v1/webhook'
    ]

    const assertNoHorizontalOverflow = () => {
        cy.document().then((document) => {
            expect(document.documentElement.scrollWidth).to.be.at.most(document.documentElement.clientWidth)
            expect(document.body.scrollWidth).to.be.at.most(document.documentElement.clientWidth)
        })
    }

    const assertModule = ({ route, title, screenshot }) => {
        cy.location('pathname').should('eq', route)
        cy.window().then((browserWindow) => {
            expect(browserWindow.innerWidth, `${route} viewport width`).to.eq(1440)
            expect(browserWindow.innerHeight, `${route} viewport height`).to.eq(1000)
        })
        cy.get('main').should('be.visible')
        cy.contains('main h1', title).should('be.visible')
        cy.get(`a[href="${route}"]`).filter(':visible').should('have.length.at.least', 1)
        assertNoHorizontalOverflow()
        cy.screenshot(screenshot, { capture: 'viewport' })
    }

    beforeEach(() => {
        consoleErrors.length = 0
        consoleWarnings.length = 0
        cy.viewport(1440, 1000)
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

        cy.loginAsLocalOwner()
        cy.intercept({ url: '**', middleware: true }, (request) => {
            const requestUrl = new URL(request.url)
            if (['http:', 'https:'].includes(requestUrl.protocol) && requestUrl.origin !== baseUrl.origin) {
                throw new Error('Unexpected external request in ten-module shell')
            }
            const normalizedPath = requestUrl.pathname.toLowerCase()
            if (providerExecutionPrefixes.some((prefix) => normalizedPath.startsWith(prefix))) {
                throw new Error(`Provider execution path requested by shell: ${normalizedPath}`)
            }
            if (unsafeMethods.has(request.method.toUpperCase())) {
                throw new Error(`Unexpected mutating request in ten-module shell: ${request.method} ${normalizedPath}`)
            }
        })
    })

    afterEach(() => {
        cy.then(() => {
            expect(consoleErrors, 'application console errors').to.deep.eq([])
            expect(consoleWarnings, 'application console warnings').to.deep.eq([])
        })
    })

    it('navigates all ten production modules through the desktop sidebar without mutation', () => {
        const [firstModule, ...remainingModules] = modules

        cy.visit(firstModule.route)
        assertModule(firstModule)

        for (const module of remainingModules) {
            cy.get(`a[href="${module.route}"]`).filter(':visible').first().click()
            assertModule(module)
        }
    })
})
