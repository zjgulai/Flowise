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
    const chromiumGcmCheckinPath = '/__flowise-e2e__/chromium-gcm-checkin'
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

    const displayMetadataFields = new Set([
        'displayLabel',
        'displayCategory',
        'displayDescription',
        'displayWarning',
        'displayPlaceholder',
        'displayBadge',
        'displayDeprecateMessage',
        'displayHeaderName',
        'displayHint',
        'displayValueOptions',
        'displayLocale'
    ])
    const metadataContainers = new Set([
        'inputs',
        'output',
        'outputs',
        'options',
        'valueOptions',
        'tabs',
        'array',
        'datagrid',
        'credential',
        'hint',
        'inputParams',
        'inputAnchors',
        'outputAnchors'
    ])

    const assertMetadataSchemaClean = (value) => {
        if (Array.isArray(value)) {
            value.forEach(assertMetadataSchemaClean)
            return
        }
        if (!value || typeof value !== 'object') return

        for (const [key, nestedValue] of Object.entries(value)) {
            expect(displayMetadataFields.has(key), `render-only metadata key ${key}`).to.eq(false)
            if (metadataContainers.has(key) && (key !== 'outputs' || Array.isArray(nestedValue))) {
                assertMetadataSchemaClean(nestedValue)
            }
        }
    }

    const assertFlowMetadataClean = (flowData) => {
        for (const node of flowData.nodes || []) {
            const nodeData = node.data || {}
            for (const key of displayMetadataFields) expect(nodeData, `node ${node.id} root metadata`).not.to.have.property(key)
            for (const container of ['inputParams', 'inputAnchors', 'outputAnchors', 'outputs']) {
                if (container in nodeData && (container !== 'outputs' || Array.isArray(nodeData[container]))) {
                    assertMetadataSchemaClean(nodeData[container])
                }
            }
        }
    }

    const expectRuntimeDisplayFieldsPreserved = (flowData) => {
        const startNode = flowData.nodes.find(({ data }) => data.name === 'startAgentflow')
        expect(startNode.data.inputs).to.deep.include({
            displayNameCreateChannel: 'create-channel-name',
            displayNameUpdateChannel: 'update-channel-name'
        })
        expect(startNode.data.inputs.businessPayload).to.deep.eq({ displayLabel: 'legitimate user value' })
        expect(startNode.data.outputs).to.deep.eq({ displayLabel: 'legitimate runtime output' })
        expect(flowData.edges[0].data).to.deep.eq({ displayLabel: 'legitimate edge payload' })
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
            if (['http:', 'https:'].includes(requestUrl.protocol) && requestUrl.origin !== baseUrl.origin) {
                throw new Error(`Unexpected external request: ${request.method} ${requestUrl.origin}${requestUrl.pathname}`)
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
                return
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
            const missingStoreErrors = consoleErrors.splice(consoleErrorCountBeforeMissingStore)
            expect(missingStoreErrors, 'missing document store console output').to.deep.eq([])
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

    it('localizes component metadata without changing machine fields or persisted flow data', () => {
        cy.viewport(1440, 900)

        cy.request({ url: '/api/v1/nodes?client=agentflowv2', headers: internalHeaders }).then((response) => {
            expect(response.status).to.eq(200)
            const agentNode = response.body.find(({ name }) => name === 'agentAgentflow')
            expect(agentNode).to.include({
                name: 'agentAgentflow',
                label: 'Agent',
                displayLabel: '智能体',
                category: 'Agent Flows',
                displayCategory: '智能体流程',
                displayLocale: 'zh-CN'
            })
            expect(agentNode.inputs.find(({ name }) => name === 'agentEnableMemory')).to.include({
                name: 'agentEnableMemory',
                label: 'Enable Memory',
                displayLabel: '启用记忆'
            })
            const humanInputNode = response.body.find(({ name }) => name === 'humanInputAgentflow')
            expect(humanInputNode.outputs.find(({ name }) => name === 'proceed')).to.include({
                name: 'proceed',
                label: 'Proceed',
                displayLabel: '继续'
            })
            const conditionNode = response.body.find(({ name }) => name === 'conditionAgentflow')
            expect(conditionNode.outputs.find(({ name }) => name === '1')).to.include({
                name: '1',
                label: '1',
                displayLabel: '1',
                description: 'Else',
                displayDescription: '否则'
            })
        })

        cy.request({ url: '/api/v1/components-credentials', headers: internalHeaders }).then((response) => {
            expect(response.status).to.eq(200)
            const kimiCredential = response.body.find(({ name }) => name === 'kimiApi')
            expect(kimiCredential).to.include({
                name: 'kimiApi',
                label: 'Kimi (Moonshot) API',
                displayLabel: 'Kimi（Moonshot）API',
                displayLocale: 'zh-CN'
            })
            expect(kimiCredential.inputs.find(({ name }) => name === 'kimiApiKey')).to.include({
                name: 'kimiApiKey',
                label: 'Kimi API Key',
                displayLabel: 'Kimi API 密钥'
            })
        })

        const metadataFlowName = `metadata-flow-${runId}`
        const metadataStartNodeId = `start-metadata-${runId}`
        const metadataLoopNodeId = `loop-metadata-${runId}`
        const rawLoopHint = 'Make sure to have memory enabled in the LLM/Agent node to retain the chat history'
        createFlowFixture(metadataFlowName, 'AGENTFLOW', {
            nodes: [
                {
                    id: metadataStartNodeId,
                    type: 'agentFlow',
                    position: { x: 100, y: 200 },
                    data: {
                        name: 'startAgentflow',
                        label: 'Start',
                        displayLabel: '<img src=x onerror="window.__metadataInjection=true">',
                        displayLocale: 'untrusted',
                        inputs: {
                            startInputType: 'chatInput',
                            displayNameCreateChannel: 'create-channel-name',
                            displayNameUpdateChannel: 'update-channel-name',
                            businessPayload: { displayLabel: 'legitimate user value' }
                        },
                        inputParams: [
                            {
                                name: 'legacyMetadata',
                                type: 'string',
                                label: 'Legacy metadata',
                                displayWarning: '<img src=x onerror="window.__metadataWarningInjection=true">'
                            }
                        ],
                        inputAnchors: [],
                        outputAnchors: [],
                        outputs: { displayLabel: 'legitimate runtime output' }
                    }
                },
                {
                    id: metadataLoopNodeId,
                    type: 'agentFlow',
                    position: { x: 500, y: 200 },
                    data: {
                        name: 'loopAgentflow',
                        label: 'Loop 0',
                        hint: rawLoopHint,
                        displayHint: '<img src=x onerror="window.__metadataHintInjection=true">',
                        inputs: {},
                        inputParams: [],
                        inputAnchors: [],
                        outputAnchors: [],
                        outputs: [
                            {
                                name: '0',
                                label: '0',
                                displayLabel: '0',
                                description: 'Condition 0',
                                displayDescription: '条件 0'
                            }
                        ]
                    }
                }
            ],
            edges: [
                {
                    id: `runtime-edge-${runId}`,
                    source: metadataStartNodeId,
                    target: metadataStartNodeId,
                    hidden: true,
                    data: { displayLabel: 'legitimate edge payload' }
                }
            ]
        }).then((agentflow) => {
            cy.request({ url: `/api/v1/chatflows/${agentflow.id}`, headers: internalHeaders }).then((response) => {
                const legacyFlowData = JSON.parse(response.body.flowData)
                expect(legacyFlowData.nodes[0].data.displayLabel).to.include('onerror')
                expect(legacyFlowData.nodes[0].data.inputParams[0].displayWarning).to.include('onerror')
                expect(legacyFlowData.nodes[1].data.displayHint).to.include('onerror')
                expect(legacyFlowData.nodes[1].data.outputs[0].displayDescription).to.eq('条件 0')
                expectRuntimeDisplayFieldsPreserved(legacyFlowData)
            })
            cy.intercept('GET', '**/api/v1/nodes*').as('loadLocalizedNodes')
            cy.visit(`/v2/agentcanvas/${agentflow.id}`)
            cy.wait('@loadLocalizedNodes').its('response.statusCode').should('eq', 200)
            cy.contains('.react-flow__node', '循环 0', { timeout: 10000 }).dblclick()
            cy.get('[role="dialog"]').within(() => {
                cy.contains('请确保已在大模型／智能体节点中启用记忆，以保留对话历史').should('be.visible')
            })
            cy.get('body').type('{esc}')
            cy.get('[role="dialog"]').should('not.exist')
            cy.get('button[title="添加节点"]').click()

            cy.get('#input-search-node').type('Agent')
            cy.contains('span', /^智能体$/, { timeout: 10000 }).should('be.visible')
            cy.get('#input-search-node').clear().type('智能体')
            cy.contains('span', /^智能体$/, { timeout: 10000 }).should('be.visible')

            cy.window().then((browserWindow) => {
                const dataTransfer = new browserWindow.DataTransfer()
                cy.contains('span', /^智能体$/)
                    .parents('[draggable="true"]')
                    .first()
                    .trigger('dragstart', { dataTransfer })
                    .then(() => {
                        const dragPayload = JSON.parse(dataTransfer.getData('application/reactflow'))
                        expect(dragPayload).to.include({ name: 'agentAgentflow', label: 'Agent' })
                        assertMetadataSchemaClean(dragPayload)

                        cy.get('.react-flow__pane').then(($pane) => {
                            const rect = $pane[0].getBoundingClientRect()
                            const eventOptions = {
                                dataTransfer,
                                clientX: rect.left + rect.width / 2,
                                clientY: rect.top + rect.height / 2,
                                force: true
                            }
                            cy.wrap($pane).trigger('dragover', eventOptions).trigger('drop', eventOptions)
                        })
                    })
            })

            cy.contains('.react-flow__node', '智能体 0', { timeout: 10000 }).should('be.visible')
            cy.contains('.react-flow__node', '智能体 0').dblclick()
            cy.get('[role="dialog"]').within(() => {
                cy.contains(/^智能体 0$/).should('be.visible')
                cy.contains(/^消息$/).should('be.visible')
                cy.contains('button', '添加消息').should('be.visible')
                cy.get('button[title="编辑名称"]').click()
                cy.get('input').first().should('have.value', 'Agent 0')
                cy.get('button[title="保存名称"]').click()
                cy.contains(/^智能体 0$/).should('be.visible')
            })
            cy.get('body').type('{esc}')
            cy.get('[role="dialog"]').should('not.exist')
            cy.intercept('PUT', `**/api/v1/chatflows/${agentflow.id}`).as('saveMetadataFlow')
            cy.get('button[title="保存智能体流程"]').click()
            cy.wait('@saveMetadataFlow').then(({ request, response }) => {
                expect(response.statusCode).to.eq(200)
                const flowData = JSON.parse(request.body.flowData)
                const savedAgent = flowData.nodes.find(({ data }) => data.name === 'agentAgentflow')
                const savedLoop = flowData.nodes.find(({ data }) => data.name === 'loopAgentflow')
                expect(savedAgent.data).to.include({ name: 'agentAgentflow', label: 'Agent 0' })
                expect(savedLoop.data).to.include({ name: 'loopAgentflow', label: 'Loop 0', hint: rawLoopHint })
                expect(savedLoop.data.outputs).to.deep.eq([{ name: '0', label: '0', description: 'Condition 0' }])
                assertFlowMetadataClean(flowData)
                expectRuntimeDisplayFieldsPreserved(flowData)
            })

            cy.request({ url: `/api/v1/chatflows/${agentflow.id}`, headers: internalHeaders }).then((response) => {
                expect(response.status).to.eq(200)
                const persistedFlowData = JSON.parse(response.body.flowData)
                expect(persistedFlowData.nodes.find(({ data }) => data.name === 'agentAgentflow').data.label).to.eq('Agent 0')
                expect(persistedFlowData.nodes.find(({ data }) => data.name === 'loopAgentflow').data.hint).to.eq(rawLoopHint)
                expect(persistedFlowData.nodes.find(({ data }) => data.name === 'loopAgentflow').data.outputs).to.deep.eq([
                    { name: '0', label: '0', description: 'Condition 0' }
                ])
                assertFlowMetadataClean(persistedFlowData)
                expectRuntimeDisplayFieldsPreserved(persistedFlowData)
            })
            cy.window().then((browserWindow) => {
                expect(browserWindow.__metadataInjection).not.to.eq(true)
                expect(browserWindow.__metadataWarningInjection).not.to.eq(true)
                expect(browserWindow.__metadataHintInjection).not.to.eq(true)
            })
            cy.reload()
            cy.wait('@loadLocalizedNodes').its('response.statusCode').should('be.oneOf', [200, 304])
            cy.contains('.react-flow__node', '智能体 0', { timeout: 10000 }).should('be.visible')
            cy.window().then((browserWindow) => {
                expect(browserWindow.__metadataInjection).not.to.eq(true)
                expect(browserWindow.__metadataWarningInjection).not.to.eq(true)
                expect(browserWindow.__metadataHintInjection).not.to.eq(true)
            })
        })

        cy.intercept('GET', '**/api/v1/components-credentials').as('loadLocalizedCredentials')
        cy.visit('/credentials')
        cy.wait('@loadLocalizedCredentials').its('response.statusCode').should('eq', 200)
        cy.contains('button', '添加凭据').click()
        cy.get('#input-search-credential').type('HTTP Api Key')
        cy.contains('[role="dialog"]', 'HTTP API 密钥', { timeout: 10000 }).should('be.visible')
        cy.get('#input-search-credential').clear().type('密钥')
        cy.contains('[role="dialog"]', 'HTTP API 密钥', { timeout: 10000 }).should('be.visible')
        cy.screenshot('05-metadata-localization', { capture: 'viewport' })
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
