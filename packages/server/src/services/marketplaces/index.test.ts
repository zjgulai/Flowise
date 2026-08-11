import fs from 'fs'
import path from 'path'

const mockComponentNodes: Record<string, { name: string }> = {}
const chatflowDirectory = path.resolve(__dirname, '../../../marketplaces/chatflows')
const archivedCsvTemplatePath = path.join(chatflowDirectory, 'archived', 'CSV Agent.json')
const activeCsvTemplatePath = path.join(chatflowDirectory, 'CSV Agent.json')

const readTemplates = (directory: string) =>
    fs
        .readdirSync(directory)
        .filter((file) => file.endsWith('.json'))
        .map((file) => ({ file, template: JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8')) }))

jest.mock('../../utils/getRunningExpressApp', () => ({
    getRunningExpressApp: () => ({ nodesPool: { componentNodes: mockComponentNodes } })
}))

import marketplacesService from '.'

const seedAvailableTemplateNodes = () => {
    for (const relativeDir of ['../../../marketplaces/chatflows', '../../../marketplaces/agentflowsv2']) {
        const directory = path.resolve(__dirname, relativeDir)
        for (const { template } of readTemplates(directory)) {
            for (const node of template.nodes || []) {
                const name = node?.data?.name
                if (name) mockComponentNodes[name] = { name }
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
        const activeTemplates = readTemplates(chatflowDirectory)
        const target = activeTemplates.find(({ template }) => (template.nodes || []).some((node: any) => node?.data?.name))
        expect(target).toBeDefined()
        const missingNodeName = target?.template.nodes.find((node: any) => node?.data?.name)?.data.name as string
        delete mockComponentNodes[missingNodeName]

        const templates = await marketplacesService.getAllTemplates()

        expect(templates.some((template) => template.templateName === path.parse(target?.file as string).name)).toBe(false)
        expect(templates.some((template) => template.type === 'Chatflow')).toBe(true)
    })

    it('keeps the unsupported CSV Agent fixture outside the active marketplace directory', () => {
        expect(fs.existsSync(activeCsvTemplatePath)).toBe(false)
        expect(fs.existsSync(archivedCsvTemplatePath)).toBe(true)

        const archivedTemplate = JSON.parse(fs.readFileSync(archivedCsvTemplatePath, 'utf8'))
        expect((archivedTemplate.nodes || []).map((node: any) => node?.data?.name)).toContain('csvAgent')
    })

    it('does not return remote icon assets for built-in tool templates', async () => {
        const templates = await marketplacesService.getAllTemplates()
        const tools = templates.filter((template) => template.type === 'Tool')

        expect(tools.length).toBeGreaterThan(0)
        expect(tools.every((template) => !/^https?:\/\//i.test(String(template.iconSrc || '')))).toBe(true)
    })
})
