export type DynamicMetadataPolicy = 'metadata-ref' | 'system-catalog' | 'provider-passthrough' | 'tenant-passthrough'

export const ZH_CN_DYNAMIC_POLICIES: Readonly<Record<string, DynamicMetadataPolicy>> = Object.freeze({
    'agentAgentflow.listEmbeddings': 'metadata-ref',
    'agentAgentflow.listModels': 'metadata-ref',
    'agentAgentflow.listRuntimeStateKeys': 'tenant-passthrough',
    'agentAgentflow.listStores': 'tenant-passthrough',
    'agentAgentflow.listTools': 'metadata-ref',
    'agentAgentflow.listVectorStores': 'metadata-ref',
    'conditionAgentAgentflow.listModels': 'metadata-ref',
    'customFunctionAgentflow.listRuntimeStateKeys': 'tenant-passthrough',
    'executeFlowAgentflow.listFlows': 'tenant-passthrough',
    'executeFlowAgentflow.listRuntimeStateKeys': 'tenant-passthrough',
    'humanInputAgentflow.listModels': 'metadata-ref',
    'llmAgentflow.listModels': 'metadata-ref',
    'llmAgentflow.listRuntimeStateKeys': 'tenant-passthrough',
    'loopAgentflow.listPreviousNodes': 'tenant-passthrough',
    'loopAgentflow.listRuntimeStateKeys': 'tenant-passthrough',
    'retrieverAgentflow.listRuntimeStateKeys': 'tenant-passthrough',
    'retrieverAgentflow.listStores': 'tenant-passthrough',
    'toolAgentflow.listRuntimeStateKeys': 'tenant-passthrough',
    'toolAgentflow.listToolInputArgs': 'tenant-passthrough',
    'toolAgentflow.listTools': 'metadata-ref'
})
