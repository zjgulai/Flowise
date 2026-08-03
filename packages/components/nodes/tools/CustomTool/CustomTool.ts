import { ICommonObject, IDatabaseEntity, INode, INodeData, INodeOptionsValue, INodeParams } from '../../../src/Interface'
import { convertSchemaToZod, getBaseClasses, getVars } from '../../../src/utils'
import { DynamicStructuredTool } from './core'
import { z } from 'zod/v3'
import { DataSource } from 'typeorm'
import { SecureZodSchemaParser } from '../../../src/secureZodParser'

const CUSTOM_TOOL_SCOPE_ERROR = 'Custom tool workspace context is required'
const CUSTOM_TOOL_UNAVAILABLE_ERROR = 'Custom tool is unavailable'

class CustomTool_Tools implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    baseClasses: string[]
    inputs: INodeParams[]

    constructor() {
        this.label = 'Custom Tool'
        this.name = 'customTool'
        this.version = 3.0
        this.type = 'CustomTool'
        this.icon = 'customtool.svg'
        this.category = 'Tools'
        this.description = `Use custom tool you've created in Flowise within chatflow`
        this.inputs = [
            {
                label: 'Select Tool',
                name: 'selectedTool',
                type: 'asyncOptions',
                loadMethod: 'listTools'
            },
            {
                label: 'Return Direct',
                name: 'returnDirect',
                description: 'Return the output of the tool directly to the user',
                type: 'boolean',
                optional: true
            },
            {
                label: 'Custom Tool Name',
                name: 'customToolName',
                type: 'string',
                hidden: true
            },
            {
                label: 'Custom Tool Description',
                name: 'customToolDesc',
                type: 'string',
                hidden: true
            },
            {
                label: 'Custom Tool Schema',
                name: 'customToolSchema',
                type: 'string',
                hidden: true
            },
            {
                label: 'Custom Tool Func',
                name: 'customToolFunc',
                type: 'string',
                hidden: true
            }
        ]
        this.baseClasses = [this.type, 'Tool', ...getBaseClasses(DynamicStructuredTool)]
    }

    //@ts-ignore
    loadMethods = {
        async listTools(_: INodeData, options: ICommonObject): Promise<INodeOptionsValue[]> {
            const returnData: INodeOptionsValue[] = []

            const appDataSource = options.appDataSource as DataSource
            const databaseEntities = options.databaseEntities as IDatabaseEntity

            if (appDataSource === undefined || !appDataSource) {
                return returnData
            }

            const searchOptions = options.searchOptions || {}
            const tools = await appDataSource.getRepository(databaseEntities['Tool']).findBy(searchOptions)

            for (let i = 0; i < tools.length; i += 1) {
                const data = {
                    label: tools[i].name,
                    name: tools[i].id,
                    description: tools[i].description
                } as INodeOptionsValue
                returnData.push(data)
            }
            return returnData
        }
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        const workspaceId = typeof options.workspaceId === 'string' ? options.workspaceId.trim() : ''
        if (!workspaceId) throw new Error(CUSTOM_TOOL_SCOPE_ERROR)

        const selectedToolId = typeof nodeData.inputs?.selectedTool === 'string' ? nodeData.inputs.selectedTool.trim() : ''
        if (!selectedToolId) throw new Error(CUSTOM_TOOL_UNAVAILABLE_ERROR)

        const customToolFunc = nodeData.inputs?.customToolFunc as string
        const customToolName = nodeData.inputs?.customToolName as string
        const customToolDesc = nodeData.inputs?.customToolDesc as string
        const customToolSchema = nodeData.inputs?.customToolSchema as string
        const customToolReturnDirect = nodeData.inputs?.returnDirect as boolean

        const appDataSource = options.appDataSource as DataSource
        const databaseEntities = options.databaseEntities as IDatabaseEntity

        let tool: any
        try {
            tool = await appDataSource.getRepository(databaseEntities['Tool']).findOneBy({ id: selectedToolId, workspaceId })
        } catch {
            throw new Error(CUSTOM_TOOL_UNAVAILABLE_ERROR)
        }
        if (!tool) throw new Error(CUSTOM_TOOL_UNAVAILABLE_ERROR)

        const obj = {
            name: tool.name,
            description: tool.description,
            schema: z.object(convertSchemaToZod(tool.schema)),
            code: tool.func
        }
        if (customToolFunc) obj.code = customToolFunc
        if (customToolName) obj.name = customToolName
        if (customToolDesc) obj.description = customToolDesc
        if (customToolSchema) {
            obj.schema = SecureZodSchemaParser.parseZodSchema(customToolSchema) as z.ZodObject<ICommonObject, 'strip', z.ZodTypeAny>
        }

        const variables = await getVars(appDataSource, databaseEntities, nodeData, options)

        const flow = { chatflowId: options.chatflowid }

        const dynamicStructuredTool = new DynamicStructuredTool(obj)
        dynamicStructuredTool.setVariables(variables)
        dynamicStructuredTool.setFlowObject(flow)
        dynamicStructuredTool.returnDirect = customToolReturnDirect

        return dynamicStructuredTool
    }
}

module.exports = { nodeClass: CustomTool_Tools }
