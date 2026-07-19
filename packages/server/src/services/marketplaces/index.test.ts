import fs from 'fs'
import path from 'path'

const mockComponentNodes: Record<string, { name: string }> = {}

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({ nodesPool: { componentNodes: mockComponentNodes } })
}))

import marketplacesService from '.'

const seedAvailableTemplateNodes = () => {
    for (const relativeDir of ['../../../marketplaces/chatflows', '../../../marketplaces/agentflowsv2']) {
        const directory = path.resolve(__dirname, relativeDir)
        for (const filename of fs.readdirSync(directory).filter((file) => file.endsWith('.json'))) {
            const template = JSON.parse(fs.readFileSync(path.join(directory, filename), 'utf8'))
            for (const node of template.nodes || []) {
                const name = node?.data?.name
                if (name && name !== 'csvAgent') mockComponentNodes[name] = { name }
            }
        }
    }
}

describe('marketplacesService built-in template compatibility', () => {
    beforeEach(() => {
        for (const name of Object.keys(mockComponentNodes)) delete mockComponentNodes[name]
        seedAvailableTemplateNodes()
    })

    it('omits a built-in template that references a missing runtime node', async () => {
        const templates = await marketplacesService.getAllTemplates()

        expect(templates.some((template) => template.templateName === 'CSV Agent')).toBe(false)
        expect(templates.some((template) => template.type === 'Chatflow')).toBe(true)
    })

    it('does not return remote icon assets for built-in tool templates', async () => {
        const templates = await marketplacesService.getAllTemplates()
        const tools = templates.filter((template) => template.type === 'Tool')

        expect(tools.length).toBeGreaterThan(0)
        expect(tools.every((template) => !/^https?:\/\//i.test(String(template.iconSrc || '')))).toBe(true)
    })
})
