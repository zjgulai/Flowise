describe('authenticated API key management', () => {
    const runId = String(Cypress.env('runId')).slice(0, 8)
    const keyName = `e2e-key-${runId}`
    const updatedKeyName = `${keyName}-updated`

    beforeEach(() => {
        cy.loginAsLocalOwner()
    })

    it('creates, renames, and deletes an API key without revealing it', () => {
        cy.intercept('GET', '**/api/v1/apikey*').as('loadApiKeys')
        cy.visit('/apikey')
        cy.wait('@loadApiKeys').its('response.statusCode').should('eq', 200)
        cy.contains('暂无 API 密钥').should('be.visible')

        cy.intercept('POST', '**/api/v1/apikey').as('createApiKey')
        cy.get('#btn_createApiKey').click()
        cy.get('#keyName').type(keyName)
        cy.contains('.permission-category h3', '聊天流')
            .parents('.permission-category')
            .first()
            .find('input[type="checkbox"]')
            .first()
            .check()
        cy.get('#btn_confirmAddingApiKey').should('not.be.disabled').click()
        cy.wait('@createApiKey').its('response.statusCode').should('eq', 200)

        cy.contains('table tbody tr', keyName)
            .should('have.length', 1)
            .within(() => {
                cy.get('button[title="显示"]').should('exist')
                cy.get('button[title="编辑"]').click()
            })

        cy.intercept('PUT', '**/api/v1/apikey/*').as('updateApiKey')
        cy.get('#keyName').clear().type(updatedKeyName)
        cy.get('#btn_confirmEditingApiKey').should('not.be.disabled').click()
        cy.wait('@updateApiKey').its('response.statusCode').should('eq', 200)
        cy.contains('table tbody tr', updatedKeyName).should('have.length', 1).find('td').first().should('have.text', updatedKeyName)

        cy.intercept('DELETE', '**/api/v1/apikey/*').as('deleteApiKey')
        cy.contains('table tbody tr', updatedKeyName).within(() => {
            cy.get('button[title="删除"]').click()
        })
        cy.get('[role="dialog"]')
            .should('be.visible')
            .within(() => {
                cy.contains('button', '删除').click()
            })
        cy.wait('@deleteApiKey').its('response.statusCode').should('eq', 200)
        cy.contains('暂无 API 密钥').should('be.visible')
    })
})
