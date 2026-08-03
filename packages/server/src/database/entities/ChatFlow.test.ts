const capturedColumns: Array<{ propertyName: string | symbol; options: Record<string, unknown> }> = []

jest.mock('typeorm', () => ({
    Entity: () => () => undefined,
    Column:
        (options: Record<string, unknown> = {}) =>
        (_target: unknown, propertyName: string | symbol) => {
            capturedColumns.push({ propertyName, options })
        },
    CreateDateColumn: () => () => undefined,
    UpdateDateColumn: () => () => undefined,
    PrimaryGeneratedColumn: () => () => undefined
}))

require('./ChatFlow')

describe('ChatFlow sensitive column metadata', () => {
    it('excludes MCP server configuration from ordinary entity queries', () => {
        const column = capturedColumns.find(({ propertyName }) => propertyName === 'mcpServerConfig')

        expect(column).toBeDefined()
        expect(column?.options).toMatchObject({ type: 'text', nullable: true, select: false })
    })
})
