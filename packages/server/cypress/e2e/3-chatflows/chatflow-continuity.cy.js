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
    const internalHeaders = { 'x-request-from': 'internal' }
    const deletionConfirmationAttempts = 5

    const expectStoredStickyNote = (responseBody, expectedName) => {
        expect(responseBody.name).to.eq(expectedName)
        const flowData = JSON.parse(responseBody.flowData)
        expect(flowData.edges).to.deep.eq([])
        expect(flowData.nodes).to.have.length(1)
        expect(flowData.nodes[0].type).to.eq('stickyNote')
        expect(flowData.nodes[0].data.name).to.eq('stickyNote')
        expect(flowData.nodes[0].data.inputs.note).to.eq(noteText)
    }

    const getCurrentChatflowId = () =>
        cy
            .location('pathname', { timeout: 30_000 })
            .should('match', /^\/canvas\/[^/]+$/)
            .then((pathname) => pathname.slice('/canvas/'.length))

    const readStoredChatflow = (id, expectedName) =>
        cy
            .request({
                url: `/api/v1/chatflows/${id}`,
                headers: internalHeaders
            })
            .then((response) => {
                expect(response.status, `stored Chatflow ${id}`).to.eq(200)
                expect(response.body.id).to.eq(id)
                expectStoredStickyNote(response.body, expectedName)
                return response.body
            })

    const confirmChatflowDeleted = (id, attemptsRemaining = deletionConfirmationAttempts) =>
        cy
            .request({
                url: `/api/v1/chatflows/${id}`,
                headers: internalHeaders,
                failOnStatusCode: false
            })
            .then((response) => {
                if (response.status === 404) return

                expect(response.status, `Chatflow ${id} deletion probe`).to.eq(200)
                if (attemptsRemaining === 1) {
                    throw new Error(`Chatflow ${id} still exists after ${deletionConfirmationAttempts} deletion probes`)
                }
                return confirmChatflowDeleted(id, attemptsRemaining - 1)
            })

    const createChatflowThroughUi = (expectedName) => {
        cy.get('button[title="保存对话流程"]').click()
        cy.get('#chatflow-name').type(expectedName)
        cy.get('[role="dialog"]').contains('button', '保存').click()
        cy.contains('对话流程已保存', { timeout: 30_000 }).should('be.visible')

        return getCurrentChatflowId().then((id) => {
            createdChatflowIds.push(id)
            return readStoredChatflow(id, expectedName).then(() => id)
        })
    }

    const returnToChatflows = () => {
        cy.get('body').then(($body) => {
            const backButton = $body.find('button[title="返回"]:visible').first()
            if (backButton.length) cy.wrap(backButton).click()
        })
        cy.location('pathname', { timeout: 30_000 }).should((pathname) => {
            expect(['/', '/chatflows']).to.include(pathname)
        })
        return cy.get('input[type="search"]').should('be.visible')
    }

    const reopenChatflowThroughUi = (id, expectedName) => {
        returnToChatflows()
        cy.get('input[type="search"]').clear().type(expectedName)
        cy.contains(expectedName).should('be.visible').click()
        cy.location('pathname', { timeout: 30_000 }).should('eq', `/canvas/${id}`)
        cy.get('.react-flow__node-stickyNote').should('have.length', 1)
        cy.get('[placeholder="Type something here"]').should('have.value', noteText)
        return readStoredChatflow(id, expectedName)
    }

    const copyChatflowThroughUi = (originalId) => {
        cy.window().then((browserWindow) => {
            const openCopyCanvas = cy.stub(browserWindow, 'open')
            cy.get('button[title="设置"]').click()
            cy.contains('复制对话流程').click()
            cy.then(() => expect(openCopyCanvas).to.have.been.calledWithMatch(/\/canvas$/, '_blank'))
        })

        returnToChatflows()
        cy.contains('button', '新增流程').click()
        cy.location('pathname', { timeout: 30_000 }).should('eq', '/canvas')
        cy.get('.react-flow__node-stickyNote').should('have.length', 1)
        cy.get('[placeholder="Type something here"]').should('have.value', noteText)
        return createChatflowThroughUi(copyName).then((copyId) => {
            expect(copyId).not.to.eq(originalId)
            return copyId
        })
    }

    const deleteChatflowThroughUi = (id) => {
        cy.location('pathname').should('eq', `/canvas/${id}`)
        cy.get('button[title="设置"]').click()
        cy.contains('复制对话流程').should('be.visible')
        cy.contains('删除对话流程').click()
        cy.get('[role="dialog"]')
            .should('be.visible')
            .within(() => {
                cy.contains('button', '删除').click()
            })
        cy.location('pathname', { timeout: 30_000 }).should('eq', '/')
        return confirmChatflowDeleted(id)
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
                headers: internalHeaders,
                failOnStatusCode: false
            }).then((response) => {
                if (response.status === 404) return
                expect(response.status).to.eq(200)
                return cy
                    .request({
                        method: 'DELETE',
                        url: `/api/v1/chatflows/${id}`,
                        headers: internalHeaders
                    })
                    .then((deleteResponse) => {
                        expect(deleteResponse.status).to.eq(200)
                        return confirmChatflowDeleted(id)
                    })
            })
        }
        cy.then(() => expect(consoleWarnings, 'application console warnings').to.deep.eq([]))
    })

    it('creates, reopens, copies, and deletes a local Sticky Note Chatflow', () => {
        cy.visit('/canvas')
        cy.get('button[title="添加节点"]').click()
        cy.get('[id^="nodes-accordian-header-"]').should('exist')
        cy.contains('[role="tab"]', '工具').click().should('have.attr', 'aria-selected', 'true')
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

        let originalId
        let copyId

        createChatflowThroughUi(originalName).then((id) => {
            originalId = id
        })
        cy.then(() => reopenChatflowThroughUi(originalId, originalName))
        cy.then(() => copyChatflowThroughUi(originalId)).then((id) => {
            copyId = id
        })
        cy.then(() => deleteChatflowThroughUi(copyId))
        cy.then(() => reopenChatflowThroughUi(originalId, originalName))
        cy.then(() => deleteChatflowThroughUi(originalId))
    })
})
