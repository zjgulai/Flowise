describe('authenticated PC core continuity', () => {
    const runId = String(Cypress.env('runId')).slice(0, 8)
    const profileName = `PC Profile ${runId}`
    const chatflowName = `pc-chatflow-${runId}`
    const agentflowName = `pc-agentflow-${runId}`
    const documentStoreName = `pc-docstore-${runId}`
    const renamedDocumentStoreName = `${documentStoreName}-renamed`
    const createdChatflowIds = []
    const createdDocumentStoreIds = []
    const consoleErrors = []
    const consoleWarnings = []
    const forbiddenApiPrefixes = [
        '/api/v1/prediction',
        '/api/v1/internal-prediction',
        '/api/v1/chatmessage',
        '/api/v1/internal-chatmessage',
        '/api/v1/vector',
        '/api/v1/assistants',
        '/api/v1/openai-assistants',
        '/api/v1/openai-realtime',
        '/api/v1/webhook'
    ]

    const internalHeaders = { 'x-request-from': 'internal' }

    const createFlowFixture = (name, type, flowData = { nodes: [], edges: [] }) =>
        cy
            .request({
                method: 'POST',
                url: '/api/v1/chatflows',
                headers: internalHeaders,
                body: { name, type, flowData: JSON.stringify(flowData), deployed: false }
            })
            .then((response) => {
                expect(response.status).to.be.oneOf([200, 201])
                createdChatflowIds.push(response.body.id)
                return response.body
            })

    const createChatflowFillers = (count, index = 0) => {
        if (index >= count) return cy.wrap(null, { log: false })
        return createFlowFixture(`${chatflowName}-filler-${index + 1}`, 'CHATFLOW').then(() => createChatflowFillers(count, index + 1))
    }

    const assertNoHorizontalOverflow = () => {
        cy.document().then((document) => {
            expect(document.documentElement.scrollWidth).to.be.at.most(document.documentElement.clientWidth)
            expect(document.body.scrollWidth).to.be.at.most(document.documentElement.clientWidth)
        })
    }

    const assertFullyWithinViewport = (selector) => {
        cy.get(selector).then(($element) => {
            const rect = $element[0].getBoundingClientRect()
            expect(rect.left, `${selector} left edge`).to.be.at.least(0)
            expect(rect.right, `${selector} right edge`).to.be.at.most($element[0].ownerDocument.defaultView.innerWidth)
        })
    }

    const isPageInitiatedRequest = (request, requestUrl, baseUrl) => {
        if (requestUrl.origin === baseUrl.origin) return true

        const origin = request.headers.origin
        const referer = request.headers.referer
        return origin === baseUrl.origin || (typeof referer === 'string' && referer.startsWith(`${baseUrl.origin}/`))
    }

    beforeEach(() => {
        consoleErrors.length = 0
        consoleWarnings.length = 0
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
            if (!isPageInitiatedRequest(request, requestUrl, baseUrl)) return

            if (requestUrl.origin !== baseUrl.origin) {
                throw new Error(`Unexpected page-initiated external request: ${request.method} ${requestUrl.origin}${requestUrl.pathname}`)
            }
            const normalizedPath = requestUrl.pathname.toLowerCase()
            if (forbiddenApiPrefixes.some((prefix) => normalizedPath.startsWith(prefix))) {
                throw new Error(`Forbidden PC continuity path requested: ${normalizedPath}`)
            }
        })
        cy.loginAsLocalOwner()
    })

    afterEach(() => {
        cy.loginAsLocalOwner()
        for (const id of [...new Set(createdChatflowIds)]) {
            cy.request({
                url: `/api/v1/chatflows/${id}`,
                headers: internalHeaders,
                failOnStatusCode: false
            }).then((response) => {
                if (response.status === 404) return
                expect(response.status).to.eq(200)
                cy.request({ method: 'DELETE', url: `/api/v1/chatflows/${id}`, headers: internalHeaders })
                    .its('status')
                    .should('eq', 200)
                cy.request({ url: `/api/v1/chatflows/${id}`, headers: internalHeaders, failOnStatusCode: false })
                    .its('status')
                    .should('eq', 404)
            })
        }
        for (const id of [...new Set(createdDocumentStoreIds)]) {
            cy.request({
                url: `/api/v1/document-store/store/${id}`,
                headers: internalHeaders,
                failOnStatusCode: false
            }).then((response) => {
                if (response.status === 404) return
                expect(response.status).to.eq(200)
                cy.request({ method: 'DELETE', url: `/api/v1/document-store/store/${id}`, headers: internalHeaders })
                    .its('status')
                    .should('eq', 200)
                cy.request({ url: `/api/v1/document-store/store/${id}`, headers: internalHeaders, failOnStatusCode: false })
                    .its('status')
                    .should('eq', 404)
            })
        }
        cy.then(() => {
            expect(consoleErrors, 'application console errors').to.deep.eq([])
            expect(consoleWarnings, 'application console warnings').to.deep.eq([])
        })
    })

    it('keeps the four desktop routes actionable, recoverable, and cleanable', () => {
        cy.viewport(1440, 900)

        cy.intercept('PUT', '**/api/v1/user', (request) => {
            request.continue((response) => response.setDelay(400))
        }).as('saveProfile')
        cy.intercept('GET', '**/api/v1/user?id=*').as('loadProfile')
        cy.visit('/account')
        cy.wait('@loadProfile').its('response.statusCode').should('eq', 200)
        cy.get('#name').should('be.visible').clear()
        cy.get('#name').type(profileName)
        cy.get('#btn_saveProfile').click()
        cy.get('#btn_saveProfile').should('be.disabled').and('contain', '正在保存')
        cy.get('#btn_saveProfile').click({ force: true })
        cy.wait('@saveProfile').its('response.statusCode').should('eq', 200)
        cy.get('@saveProfile.all').should('have.length', 1)
        cy.contains('个人资料已更新').should('be.visible')
        cy.reload()
        cy.get('#name').should('have.value', profileName)
        cy.screenshot('01-account-profile', { capture: 'viewport' })

        createFlowFixture(chatflowName, 'CHATFLOW').then(() => {
            createChatflowFillers(12).then(() => {
                cy.intercept('GET', '**/api/v1/chatflows?type=CHATFLOW*').as('loadChatflows')
                cy.visit('/chatflows')
                cy.wait('@loadChatflows').its('response.statusCode').should('eq', 200)
                cy.get('button[title="列表视图"]').click()
                cy.intercept('GET', '**/api/v1/chatflows?type=CHATFLOW*').as('sortChatflows')
                cy.contains('table thead .MuiTableSortLabel-root', '名称').click()
                cy.wait('@sortChatflows').then(({ request, response }) => {
                    const params = new URL(request.url).searchParams
                    expect(response.statusCode).to.eq(200)
                    expect(params.get('orderBy')).to.eq('name')
                    expect(params.get('order')).to.eq('asc')
                })
                cy.get('.MuiPagination-ul').contains('button', '2').click()
                cy.wait('@loadChatflows').its('response.statusCode').should('eq', 200)
                cy.get('table tbody tr a')
                    .first()
                    .then(($link) => {
                        const secondPageName = $link.text().trim()
                        const secondPageHref = $link.attr('href')
                        expect(secondPageName).to.not.eq('')
                        expect(secondPageHref).to.match(/^\/canvas\//)

                        cy.intercept('GET', '**/api/v1/chatflows*').as('searchChatflows')
                        cy.get('input[type="search"]').clear()
                        cy.get('input[type="search"]').type(secondPageName)
                        cy.wait('@searchChatflows').then(({ request, response }) => {
                            expect(response.statusCode).to.eq(200)
                            expect(new URL(request.url).searchParams.get('search')).to.eq(secondPageName)
                            expect(response.body.data.map(({ name }) => name)).to.include(secondPageName)
                        })
                        cy.get('table tbody tr')
                            .filter((_, row) => Cypress.$(row).find('a').first().text().trim() === secondPageName)
                            .should('have.length', 1)
                            .and('be.visible')
                        cy.screenshot('02-chatflows-list', { capture: 'viewport' })
                        cy.get('table tbody tr')
                            .filter((_, row) => Cypress.$(row).find('a').first().text().trim() === secondPageName)
                            .find('a')
                            .first()
                            .click()
                        cy.location('pathname').should('eq', secondPageHref)
                        cy.visit('/chatflows')
                    })
            })
        })

        cy.viewport(1280, 800)
        createFlowFixture(agentflowName, 'AGENTFLOW', {
            nodes: [
                {
                    id: `start-${runId}`,
                    type: 'agentFlow',
                    data: {
                        name: 'startAgentflow',
                        label: 'Start',
                        inputs: {
                            startInputType: 'scheduleInput',
                            scheduleInputMode: 'text',
                            scheduleCronExpression: '0 0 * * *',
                            scheduleTimezone: 'UTC',
                            scheduleDefaultInput: 'local PC continuity fixture'
                        }
                    }
                }
            ],
            edges: []
        }).then((agentflow) => {
            cy.intercept('GET', `**/api/v1/chatflows/${agentflow.id}/schedule/status`, {
                statusCode: 503,
                body: { message: 'controlled local schedule failure' }
            }).as('scheduleFailure')
            cy.intercept('GET', '**/api/v1/chatflows?type=AGENTFLOW*').as('loadAgentflows')
            cy.visit('/agentflows')
            cy.wait('@loadAgentflows').its('response.statusCode').should('eq', 200)
            cy.wait('@scheduleFailure').its('response.statusCode').should('eq', 503)
            cy.intercept('GET', '**/api/v1/chatflows*').as('searchAgentflows')
            cy.get('input[type="search"]').type(agentflowName)
            cy.wait('@searchAgentflows').then(({ request, response }) => {
                expect(response.statusCode).to.eq(200)
                expect(new URL(request.url).searchParams.get('search')).to.eq(agentflowName)
            })
            cy.contains(agentflowName).should('be.visible')
            cy.contains('状态获取失败').should('be.visible')
            cy.get('button[title="列表视图"]').click()
            cy.contains('table tbody tr', agentflowName).should('be.visible')
            cy.contains('button', 'V1').click()
            cy.contains('V1 智能体流程已弃用').should('be.visible')
            cy.get('button[aria-label="关闭 V1 弃用提示"]').click()
            cy.contains('V1 智能体流程已弃用').should('not.exist')
            cy.contains('button', 'V2').click()
            cy.contains(agentflowName).should('be.visible')
            assertFullyWithinViewport('button[title="列表视图"]')
            cy.contains('button', '操作').should('be.visible')
            cy.screenshot('03-agentflows-schedule-recovery', { capture: 'viewport' })
            cy.contains('table tbody tr', agentflowName).find('a').first().click()
            cy.location('pathname').should('eq', `/v2/agentcanvas/${agentflow.id}`)
            cy.visit('/agentflows')
        })

        cy.viewport(1440, 900)
        cy.intercept('GET', '**/api/v1/document-store/store?page=*').as('loadDocumentStores')
        cy.visit('/document-stores')
        cy.wait('@loadDocumentStores').its('response.statusCode').should('eq', 200)
        cy.contains('暂无文档库').should('be.visible')
        let consoleErrorCountBeforeMissingStore
        cy.then(() => {
            consoleErrorCountBeforeMissingStore = consoleErrors.length
        })
        cy.intercept('GET', '**/api/v1/document-store/store/00000000-0000-4000-8000-000000000000').as('missingDocumentStore')
        cy.visit('/document-stores/00000000-0000-4000-8000-000000000000')
        cy.wait('@missingDocumentStore').its('response.statusCode').should('eq', 404)
        cy.contains('页面加载失败').should('be.visible')
        cy.then(() => {
            const expectedMissingStoreErrors = consoleErrors.splice(consoleErrorCountBeforeMissingStore)
            expect(expectedMissingStoreErrors, 'exact missing document store console output').to.deep.eq([
                'AxiosError: Request failed with status code 404'
            ])
        })
        cy.contains('button', '返回文档库列表').click()
        cy.location('pathname').should('eq', '/document-stores')
        cy.get('#btn_createDocumentStore').click()
        cy.get('#txtInput_documentStoreName').type(documentStoreName)
        cy.get('#txtInput_documentStoreDescription').type('PC continuity fixture')

        cy.intercept({ method: 'POST', url: '**/api/v1/document-store/store', times: 1 }, { statusCode: 503, body: {} }).as(
            'createDocumentStoreFailure'
        )
        cy.get('#btn_submitDocumentStore').click()
        cy.wait('@createDocumentStoreFailure').its('response.statusCode').should('eq', 503)
        cy.get('[role="dialog"]').should('be.visible')
        cy.get('#txtInput_documentStoreName').should('have.value', documentStoreName)
        cy.get('#btn_submitDocumentStore').should('not.be.disabled')
        cy.contains('新增文档库失败').should('be.visible')

        cy.intercept('POST', '**/api/v1/document-store/store').as('createDocumentStore')
        cy.get('#btn_submitDocumentStore').click()
        cy.wait('@createDocumentStore').then(({ response }) => {
            expect(response.statusCode).to.be.oneOf([200, 201])
            createdDocumentStoreIds.push(response.body.id)
            cy.contains(documentStoreName).should('be.visible')
            cy.intercept('GET', '**/api/v1/document-store/store*').as('searchDocumentStores')
            cy.get('input[type="search"]').clear()
            cy.get('input[type="search"]').type(documentStoreName)
            cy.wait('@searchDocumentStores').then(({ request, response }) => {
                expect(response.statusCode).to.eq(200)
                expect(new URL(request.url).searchParams.get('search')).to.eq(documentStoreName)
            })
            cy.contains(documentStoreName).should('be.visible')
            cy.get('button[title="列表视图"]').click()
            cy.contains('table tbody tr', documentStoreName).click()
            cy.location('pathname').should('eq', `/document-stores/${response.body.id}`)
            cy.get('button[aria-label="返回"]').click()
            cy.location('pathname').should('eq', '/document-stores')

            cy.contains(documentStoreName).should('be.visible')
            cy.get('button[title="卡片视图"]').click()
            cy.get('button[aria-label="文档库操作"]').click()
            cy.contains('[role="menuitem"]', '重命名').click()
            cy.get('#txtInput_documentStoreName').clear()
            cy.get('#txtInput_documentStoreName').type(renamedDocumentStoreName)
            cy.intercept('PUT', `**/api/v1/document-store/store/${response.body.id}`).as('renameDocumentStore')
            cy.get('#btn_submitDocumentStore').click()
            cy.wait('@renameDocumentStore').its('response.statusCode').should('eq', 200)
            cy.contains(renamedDocumentStoreName).should('be.visible')
            cy.contains('新增文档库失败').should('not.exist')
            cy.contains('文档库已创建', { timeout: 10000 }).should('not.exist')
            cy.contains('文档库已更新', { timeout: 10000 }).should('not.exist')
            cy.screenshot('04-document-store-renamed', { capture: 'viewport' })

            cy.intercept('DELETE', `**/api/v1/document-store/store/${response.body.id}`).as('deleteDocumentStore')
            cy.get('button[aria-label="文档库操作"]').click()
            cy.contains('[role="menuitem"]', '删除').click()
            cy.get('[role="dialog"]').contains('button', '确认删除').click()
            cy.wait('@deleteDocumentStore').its('response.statusCode').should('eq', 200)
            cy.contains('暂无文档库').should('be.visible')
        })

        assertNoHorizontalOverflow()
    })

    it('keeps the four mobile entry routes non-blocking without expanding the PC scope', () => {
        cy.viewport(390, 844)
        for (const [route, visibleText] of [
            ['/account', '账户设置'],
            ['/chatflows', '对话流程'],
            ['/agentflows', '智能体流程'],
            ['/document-stores', '文档库']
        ]) {
            cy.visit(route)
            cy.contains(visibleText).should('be.visible')
            assertNoHorizontalOverflow()
        }
    })
})
