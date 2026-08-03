import { ICommonObject, IDatabaseEntity, INode, INodeData, INodeOptionsValue, INodeOutputsValue, INodeParams } from '../../../src/Interface'
import { DataSource } from 'typeorm'
import { Document } from '@langchain/core/documents'
import { handleEscapeCharacters } from '../../../src'

const DOCUMENT_STORE_SCOPE_ERROR = 'Document Store workspace context is required'
const DOCUMENT_STORE_UNAVAILABLE_ERROR = 'Document Store is unavailable'

class DocStore_DocumentLoaders implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    baseClasses: string[]
    inputs: INodeParams[]
    outputs: INodeOutputsValue[]

    constructor() {
        this.label = 'Document Store'
        this.name = 'documentStore'
        this.version = 1.0
        this.type = 'Document'
        this.icon = 'dstore.svg'
        this.category = 'Document Loaders'
        this.description = `Load data from pre-configured document stores`
        this.baseClasses = [this.type]
        this.inputs = [
            {
                label: 'Select Store',
                name: 'selectedStore',
                type: 'asyncOptions',
                loadMethod: 'listStores'
            }
        ]
        this.outputs = [
            {
                label: 'Document',
                name: 'document',
                description: 'Array of document objects containing metadata and pageContent',
                baseClasses: [...this.baseClasses, 'json']
            },
            {
                label: 'Text',
                name: 'text',
                description: 'Concatenated string from pageContent of documents',
                baseClasses: ['string', 'json']
            }
        ]
    }

    //@ts-ignore
    loadMethods = {
        async listStores(_: INodeData, options: ICommonObject): Promise<INodeOptionsValue[]> {
            const returnData: INodeOptionsValue[] = []

            const appDataSource = options.appDataSource as DataSource
            const databaseEntities = options.databaseEntities as IDatabaseEntity

            if (appDataSource === undefined || !appDataSource) {
                return returnData
            }

            const searchOptions = options.searchOptions || {}
            const stores = await appDataSource.getRepository(databaseEntities['DocumentStore']).findBy(searchOptions)
            for (const store of stores) {
                if (store.status === 'SYNC') {
                    const obj = {
                        name: store.id,
                        label: store.name,
                        description: store.description
                    }
                    returnData.push(obj)
                }
            }
            return returnData
        }
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        const workspaceId = typeof options.workspaceId === 'string' ? options.workspaceId.trim() : ''
        if (!workspaceId) throw new Error(DOCUMENT_STORE_SCOPE_ERROR)

        const selectedStore = typeof nodeData.inputs?.selectedStore === 'string' ? nodeData.inputs.selectedStore.trim() : ''
        if (!selectedStore) throw new Error(DOCUMENT_STORE_UNAVAILABLE_ERROR)

        const appDataSource = options.appDataSource as DataSource
        const databaseEntities = options.databaseEntities as IDatabaseEntity
        const store = await appDataSource.getRepository(databaseEntities['DocumentStore']).findOneBy({ id: selectedStore, workspaceId })
        if (!store || store.status !== 'SYNC') throw new Error(DOCUMENT_STORE_UNAVAILABLE_ERROR)

        const chunks = await appDataSource
            .getRepository(databaseEntities['DocumentStoreFileChunk'])
            .find({ where: { storeId: selectedStore } })
        const output = nodeData.outputs?.output as string

        const finalDocs = []
        for (const chunk of chunks) {
            finalDocs.push(new Document({ pageContent: chunk.pageContent, metadata: JSON.parse(chunk.metadata) }))
        }

        if (output === 'document') {
            return finalDocs
        } else {
            let finaltext = ''
            for (const doc of finalDocs) {
                finaltext += `${doc.pageContent}\n`
            }
            return handleEscapeCharacters(finaltext, false)
        }
    }
}

module.exports = { nodeClass: DocStore_DocumentLoaders }
