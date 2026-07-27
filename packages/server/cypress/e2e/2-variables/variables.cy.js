describe('authenticated variable management', () => {
    const runId = String(Cypress.env('runId')).slice(0, 8)
    const variableName = `e2e-variable-${runId}`
    const variableValue = `local-value-${runId}`
    const updatedVariableName = `${variableName}-updated`
    const updatedVariableValue = `${variableValue}-updated`

    beforeEach(() => {
        cy.loginAsLocalOwner()
    })

    it('creates, updates, and deletes a static variable', () => {
        cy.intercept('GET', '**/api/v1/variables*').as('loadVariables')
        cy.visit('/variables')
        cy.wait('@loadVariables').its('response.statusCode').should('eq', 200)
        cy.contains('暂无变量').should('be.visible')

        cy.intercept('POST', '**/api/v1/variables').as('createVariable')
        cy.get('#btn_createVariable').click()
        cy.get('#txtInput_variableName').type(variableName)
        cy.get('#txtInput_variableValue').type(variableValue)
        cy.get('#btn_confirmAddingNewVariable').should('not.be.disabled').click()
        cy.wait('@createVariable').its('response.statusCode').should('eq', 200)

        cy.contains('table tbody tr', variableName)
            .should('have.length', 1)
            .within(() => {
                cy.contains(variableValue).should('be.visible')
                cy.get('button[title="编辑"]').click()
            })

        cy.intercept('PUT', '**/api/v1/variables/*').as('updateVariable')
        cy.get('#txtInput_variableName').clear().type(updatedVariableName)
        cy.get('#txtInput_variableValue').clear().type(updatedVariableValue)
        cy.get('#btn_confirmAddingNewVariable').should('not.be.disabled').click()
        cy.wait('@updateVariable').its('response.statusCode').should('eq', 200)

        cy.contains('table tbody tr', updatedVariableName)
            .should('have.length', 1)
            .within(() => {
                cy.contains(updatedVariableValue).should('be.visible')
                cy.get('button[title="删除"]').click()
            })

        cy.intercept('DELETE', '**/api/v1/variables/*').as('deleteVariable')
        cy.get('[role="dialog"]')
            .should('be.visible')
            .within(() => {
                cy.contains('button', 'Delete').click()
            })
        cy.wait('@deleteVariable').its('response.statusCode').should('eq', 200)
        cy.contains('暂无变量').should('be.visible')
    })
})
