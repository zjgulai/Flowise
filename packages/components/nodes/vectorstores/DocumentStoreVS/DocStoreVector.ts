import { ICommonObject, IDatabaseEntity, INode, INodeData, INodeOptionsValue, INodeOutputsValue, INodeParams } from '../../../src/Interface'
import { DataSource } from 'typeorm'

const DOCUMENT_STORE_SCOPE_ERROR = 'Document Store workspace context is required'
const DOCUMENT_STORE_UNAVAILABLE_ERROR = 'Document Store is unavailable'

interface DocumentStoreNodeConfig {
    name: string
    config: ICommonObject
}

interface ResolvedDocumentStoreComponent {
    component: ICommonObject
    credentialId?: string
}

const isRecord = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value))

const parseDocumentStoreNodeConfig = (value: unknown): DocumentStoreNodeConfig | undefined => {
    if (typeof value !== 'string' || !value.trim()) return undefined

    try {
        const parsed = JSON.parse(value)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
        const name = typeof parsed.name === 'string' ? parsed.name.trim() : ''
        const config = parsed.config
        if (!name || !config || typeof config !== 'object' || Array.isArray(config)) return undefined
        return { name, config }
    } catch {
        return undefined
    }
}

const resolveDocumentStoreRuntimeComponent = (
    componentNodes: ICommonObject,
    selection: DocumentStoreNodeConfig,
    expectedCategory: 'Embeddings' | 'Vector Stores',
    requiredBaseClass: 'Embeddings' | 'VectorStoreRetriever'
): ResolvedDocumentStoreComponent | undefined => {
    const component = componentNodes?.[selection.name]
    if (
        !isRecord(component) ||
        component.name !== selection.name ||
        component.category !== expectedCategory ||
        !Array.isArray(component.baseClasses) ||
        !component.baseClasses.includes(requiredBaseClass) ||
        typeof component.filePath !== 'string' ||
        !component.filePath.trim() ||
        !Array.isArray(component.inputs)
    ) {
        return undefined
    }

    const allowedInputs = new Set<string>(['FLOWISE_CREDENTIAL_ID'])
    for (const input of component.inputs) {
        if (isRecord(input) && typeof input.name === 'string' && input.name) allowedInputs.add(input.name)
    }
    const credentialInputName = isRecord(component.credential) ? component.credential.name : undefined
    if (typeof credentialInputName === 'string' && credentialInputName) allowedInputs.add(credentialInputName)
    if (expectedCategory === 'Vector Stores') {
        for (const retrievalInput of ['topK', 'searchType', 'fetchK', 'lambda']) allowedInputs.add(retrievalInput)
    }
    for (const key of Object.keys(selection.config)) {
        if (key === 'customFunction' || key === '__proto__' || key === 'prototype' || key === 'constructor' || !allowedInputs.has(key)) {
            return undefined
        }
    }

    const credentialCandidates = [
        selection.config.FLOWISE_CREDENTIAL_ID,
        typeof credentialInputName === 'string' ? selection.config[credentialInputName] : undefined
    ].filter((candidate) => candidate !== undefined && candidate !== null && candidate !== '')
    const credentialIds = [...new Set(credentialCandidates)]
    if (credentialIds.length > 1 || credentialIds.some((candidate) => typeof candidate !== 'string' || !candidate.trim())) {
        return undefined
    }
    return { component, credentialId: credentialIds[0] as string | undefined }
}

const assertDocumentStoreRuntimeCredential = async (
    credentialId: string | undefined,
    workspaceId: string,
    appDataSource: DataSource,
    databaseEntities: IDatabaseEntity
): Promise<boolean> => {
    if (!credentialId) return true
    const credentialEntity = databaseEntities['Credential']
    if (!credentialEntity) return false
    try {
        const credentialRepository = appDataSource.getRepository(credentialEntity)
        const ownedCredential = await credentialRepository.findOneBy({ id: credentialId, workspaceId })
        if (ownedCredential) return true

        const workspaceSharedEntity = databaseEntities['WorkspaceShared']
        if (!workspaceSharedEntity) return false
        const sharedCredential = await appDataSource.getRepository(workspaceSharedEntity).findOneBy({
            workspaceId,
            sharedItemId: credentialId,
            itemType: 'credential'
        })
        if (!sharedCredential) return false
        return Boolean(await credentialRepository.findOneBy({ id: credentialId }))
    } catch {
        return false
    }
}

class DocStore_VectorStores implements INode {
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
        this.label = 'Document Store (Vector)'
        this.name = 'documentStoreVS'
        this.version = 1.0
        this.type = 'DocumentStoreVS'
        this.icon = 'dstore.svg'
        this.category = 'Vector Stores'
        this.description = `Search and retrieve documents from Document Store`
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
                label: 'Retriever',
                name: 'retriever',
                baseClasses: ['BaseRetriever']
            },
            {
                label: 'Vector Store',
                name: 'vectorStore',
                baseClasses: ['VectorStore']
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
                if (store.status === 'UPSERTED') {
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
        const output = nodeData.outputs?.output as string

        const entity = await appDataSource.getRepository(databaseEntities['DocumentStore']).findOneBy({ id: selectedStore, workspaceId })
        if (!entity || entity.status !== 'UPSERTED') throw new Error(DOCUMENT_STORE_UNAVAILABLE_ERROR)

        const embeddingConfig = parseDocumentStoreNodeConfig(entity.embeddingConfig)
        const vectorStoreConfig = parseDocumentStoreNodeConfig(entity.vectorStoreConfig)
        if (!embeddingConfig || !vectorStoreConfig) throw new Error(DOCUMENT_STORE_UNAVAILABLE_ERROR)

        const embeddingSelection = resolveDocumentStoreRuntimeComponent(options.componentNodes, embeddingConfig, 'Embeddings', 'Embeddings')
        const vectorStoreSelection = resolveDocumentStoreRuntimeComponent(
            options.componentNodes,
            vectorStoreConfig,
            'Vector Stores',
            'VectorStoreRetriever'
        )
        if (!embeddingSelection || !vectorStoreSelection) throw new Error(DOCUMENT_STORE_UNAVAILABLE_ERROR)
        if (
            !(await assertDocumentStoreRuntimeCredential(embeddingSelection.credentialId, workspaceId, appDataSource, databaseEntities)) ||
            !(await assertDocumentStoreRuntimeCredential(vectorStoreSelection.credentialId, workspaceId, appDataSource, databaseEntities))
        ) {
            throw new Error(DOCUMENT_STORE_UNAVAILABLE_ERROR)
        }

        const data: ICommonObject = {}
        data.output = output

        // Prepare Embeddings Instance
        data.embeddingName = embeddingConfig.name
        data.embeddingConfig = embeddingConfig.config
        let embeddingObj = await _createEmbeddingsObject(options.componentNodes, data, options)
        if (!embeddingObj) {
            return { error: 'Failed to create EmbeddingObj' }
        }

        // Prepare Vector Store Instance
        data.vectorStoreName = vectorStoreConfig.name
        data.vectorStoreConfig = vectorStoreConfig.config
        if (data.inputs) {
            data.vectorStoreConfig = { ...vectorStoreConfig.config, ...data.inputs }
        }

        // Prepare Vector Store Node Data
        const vStoreNodeData = _createVectorStoreNodeData(options.componentNodes, data, embeddingObj)

        // Finally create the Vector Store or Retriever object (data.output)
        const vectorStoreObj = await _createVectorStoreObject(options.componentNodes, data)
        const retrieverOrVectorStore = await vectorStoreObj.init(vStoreNodeData, '', options)
        if (!retrieverOrVectorStore) {
            return { error: 'Failed to create vectorStore' }
        }
        return retrieverOrVectorStore
    }
}

const _createEmbeddingsObject = async (componentNodes: ICommonObject, data: ICommonObject, options: ICommonObject): Promise<any> => {
    // prepare embedding node data
    const embeddingComponent = componentNodes[data.embeddingName]
    const embeddingNodeData: any = {
        inputs: { ...data.embeddingConfig },
        outputs: { output: 'document' },
        id: `${embeddingComponent.name}_0`,
        label: embeddingComponent.label,
        name: embeddingComponent.name,
        category: embeddingComponent.category,
        inputParams: embeddingComponent.inputs || []
    }
    if (data.embeddingConfig.credential) {
        embeddingNodeData.credential = data.embeddingConfig.credential
    }

    // init embedding object
    const embeddingNodeInstanceFilePath = embeddingComponent.filePath as string
    const embeddingNodeModule = await import(embeddingNodeInstanceFilePath)
    const embeddingNodeInstance = new embeddingNodeModule.nodeClass()
    return await embeddingNodeInstance.init(embeddingNodeData, '', options)
}

const _createVectorStoreNodeData = (componentNodes: ICommonObject, data: ICommonObject, embeddingObj: any) => {
    const vectorStoreComponent = componentNodes[data.vectorStoreName]
    const vStoreNodeData: any = {
        id: `${vectorStoreComponent.name}_0`,
        inputs: { ...data.vectorStoreConfig },
        outputs: { output: data.output },
        label: vectorStoreComponent.label,
        name: vectorStoreComponent.name,
        category: vectorStoreComponent.category
    }
    if (data.vectorStoreConfig.credential) {
        vStoreNodeData.credential = data.vectorStoreConfig.credential
    }

    if (embeddingObj) {
        vStoreNodeData.inputs.embeddings = embeddingObj
    }

    // Get all input params except the ones that are anchor points to avoid JSON stringify circular error
    const filterInputParams = ['document', 'embeddings', 'recordManager']
    const inputParams = vectorStoreComponent.inputs?.filter((input: any) => !filterInputParams.includes(input.name))
    vStoreNodeData.inputParams = inputParams
    return vStoreNodeData
}

const _createVectorStoreObject = async (componentNodes: ICommonObject, data: ICommonObject) => {
    const vStoreNodeInstanceFilePath = componentNodes[data.vectorStoreName].filePath as string
    const vStoreNodeModule = await import(vStoreNodeInstanceFilePath)
    const vStoreNodeInstance = new vStoreNodeModule.nodeClass()
    return vStoreNodeInstance
}

module.exports = { nodeClass: DocStore_VectorStores }
