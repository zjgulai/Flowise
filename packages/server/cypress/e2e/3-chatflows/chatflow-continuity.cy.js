describe('authenticated Chatflow continuity', () => {
    const runId = String(Cypress.env('runId')).slice(0, 8)
    const originalName = `e2e-chatflow-${runId}`
    const copyName = `${originalName}-copy`
    const noteText = `local-note-${runId}`
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
    const createdChatflowIds = []
    const consoleWarnings = []

    const expectStoredStickyNote = (responseBody, expectedName) => {
        expect(responseBody.name).to.eq(expectedName)
        const flowData = JSON.parse(responseBody.flowData)
        expect(flowData.edges).to.deep.eq([])
        expect(flowData.nodes).to.have.length(1)
        expect(flowData.nodes[0].type).to.eq('stickyNote')
        expect(flowData.nodes[0].data.name).to.eq('stickyNote')
        expect(flowData.nodes[0].data.inputs.note).to.eq(noteText)
    }

    const deleteCurrentChatflow = (alias) => {
        cy.intercept('DELETE', '**/api/v1/chatflows/*').as(alias)
        cy.get('button[title="设置"]').click()
        cy.contains('复制对话流程').should('be.visible')
        cy.contains('删除对话流程').click()
        cy.get('[role="dialog"]')
            .should('be.visible')
            .within(() => {
                cy.contains('button', 'Delete').click()
            })
        cy.wait(`@${alias}`).its('response.statusCode').should('eq', 200)
    }

    beforeEach(() => {
        consoleWarnings.length = 0
        cy.on('window:before:load', (browserWindow) => {
            const originalWarn = browserWindow.console.warn.bind(browserWindow.console)
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
            const normalizedPath = requestUrl.pathname.toLowerCase()
            if (forbiddenApiPrefixes.some((prefix) => normalizedPath.startsWith(prefix))) {
                throw new Error(`Forbidden Chatflow execution path requested: ${normalizedPath}`)
            }
        })
        cy.loginAsLocalOwner()
    })

    afterEach(() => {
        cy.loginAsLocalOwner()
        for (const id of [...new Set(createdChatflowIds)]) {
            cy.request({
                url: `/api/v1/chatflows/${id}`,
                headers: { 'x-request-from': 'internal' },
                failOnStatusCode: false
            }).then((response) => {
                if (response.status === 404) return
                expect(response.status).to.eq(200)
                cy.request({
                    method: 'DELETE',
                    url: `/api/v1/chatflows/${id}`,
                    headers: { 'x-request-from': 'internal' }
                })
                    .its('status')
                    .should('eq', 200)
            })
        }
        cy.then(() => expect(consoleWarnings, 'application console warnings').to.deep.eq([]))
    })

    it('creates, reopens, copies, and deletes a local Sticky Note Chatflow', () => {
        cy.intercept('GET', '**/api/v1/nodes*').as('loadNodes')
        cy.visit('/canvas')
        cy.wait('@loadNodes').then(({ response }) => {
            expect(response.statusCode).to.eq(200)
            expect(response.body).to.be.an('array')
            expect(response.body.some((node) => node?.name === 'stickyNote')).to.eq(true)
        })

        cy.get('button[title="添加节点"]').click()
        cy.get('[id^="nodes-accordian-header-"]').should('exist')
        cy.contains('[role="tab"]', 'Utilities').click().should('have.attr', 'aria-selected', 'true')
        cy.get('#input-search-node').type('Sticky Note')
        cy.contains('span', 'Sticky Note')
            .parents('[draggable="true"]')
            .first()
            .should('be.visible')
            .then(($node) => {
                const dataTransfer = new DataTransfer()
                cy.wrap($node).trigger('dragstart', { dataTransfer })
                cy.get('.chatflow-canvas')
                    .trigger('dragover', { dataTransfer, clientX: 500, clientY: 350 })
                    .trigger('drop', { dataTransfer, clientX: 500, clientY: 350 })
            })

        cy.get('.react-flow__node-stickyNote').should('have.length', 1)
        cy.get('[placeholder="Type something here"]').clear().type(noteText)

        cy.intercept('POST', '**/api/v1/chatflows').as('createChatflow')
        cy.get('button[title="Save Chatflow"]').click()
        cy.get('#chatflow-name').type(originalName)
        cy.get('[role="dialog"]').contains('button', '保存').click()
        cy.wait('@createChatflow').then(({ response }) => {
            expect(response.statusCode).to.be.oneOf([200, 201])
            expectStoredStickyNote(response.body, originalName)
            createdChatflowIds.push(response.body.id)
            const originalId = response.body.id
            cy.location('pathname').should('eq', `/canvas/${originalId}`)

            cy.intercept('GET', `**/api/v1/chatflows/${originalId}`).as('reopenChatflow')
            cy.visit(`/canvas/${originalId}`)
            cy.wait('@reopenChatflow').then(({ response: reopenResponse }) => {
                expect(reopenResponse.statusCode).to.eq(200)
                expectStoredStickyNote(reopenResponse.body, originalName)
            })
            cy.get('.react-flow__node-stickyNote').should('have.length', 1)
            cy.get('[placeholder="Type something here"]').should('have.value', noteText)

            cy.window().then((window) => {
                cy.stub(window, 'open').as('openCopyCanvas')
            })
            cy.get('button[title="设置"]').click()
            cy.contains('复制对话流程').click()
            cy.get('@openCopyCanvas').should('have.been.calledWithMatch', /\/canvas$/, '_blank')

            cy.intercept('POST', '**/api/v1/chatflows').as('copyChatflow')
            cy.visit('/canvas')
            cy.get('.react-flow__node-stickyNote').should('have.length', 1)
            cy.get('[placeholder="Type something here"]').should('have.value', noteText)
            cy.get('button[title="Save Chatflow"]').click()
            cy.get('#chatflow-name').type(copyName)
            cy.get('[role="dialog"]').contains('button', '保存').click()
            cy.wait('@copyChatflow').then(({ response: copyResponse }) => {
                expect(copyResponse.statusCode).to.be.oneOf([200, 201])
                expect(copyResponse.body.id).not.to.eq(originalId)
                expectStoredStickyNote(copyResponse.body, copyName)
                createdChatflowIds.push(copyResponse.body.id)

                deleteCurrentChatflow('deleteChatflowCopy')
                cy.intercept({ method: 'GET', url: `**/api/v1/chatflows/${originalId}`, middleware: true }, (request) => {
                    delete request.headers['if-none-match']
                    delete request.headers['if-modified-since']
                }).as('reloadOriginalAfterCopyDelete')
                cy.visit(`/canvas/${originalId}`)
                cy.wait('@reloadOriginalAfterCopyDelete').then(({ response: reloadResponse }) => {
                    expect(reloadResponse.statusCode).to.eq(200)
                    expectStoredStickyNote(reloadResponse.body, originalName)
                })
                cy.get('.react-flow__node-stickyNote').should('have.length', 1)
                deleteCurrentChatflow('deleteChatflowOriginal')

                cy.loginAsLocalOwner()
                for (const id of [originalId, copyResponse.body.id]) {
                    cy.request({
                        url: `/api/v1/chatflows/${id}`,
                        headers: { 'x-request-from': 'internal' },
                        failOnStatusCode: false
                    })
                        .its('status')
                        .should('eq', 404)
                }
            })
        })
    })
})
