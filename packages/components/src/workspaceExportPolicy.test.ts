const loadInputs = (modulePath: string): Array<Record<string, unknown>> => {
    const { nodeClass } = require(modulePath)
    return new nodeClass().inputs
}

const expectRebind = (inputs: Array<Record<string, unknown>>, names: string[]): void => {
    const byName = new Map(inputs.map((input) => [input.name, input]))
    for (const name of names) {
        expect(byName.get(name)).toEqual(expect.objectContaining({ workspaceExportPolicy: 'rebind' }))
    }
}

describe('workspace export rebind metadata', () => {
    it('marks every audited local path input and leaves endpoint basePath inputs portable', () => {
        expectRebind(loadInputs('../nodes/documentloaders/Folder/Folder'), ['folderPath'])
        expectRebind(loadInputs('../nodes/vectorstores/Milvus/Milvus'), ['clientPemPath', 'clientKeyPath', 'caPemPath'])
        expectRebind(loadInputs('../nodes/vectorstores/Faiss/Faiss'), ['basePath'])
        expectRebind(loadInputs('../nodes/vectorstores/SimpleStore/SimpleStore'), ['basePath'])
        expectRebind(loadInputs('../nodes/memory/AgentMemory/AgentMemory'), ['databaseFilePath'])
        expectRebind(loadInputs('../nodes/chains/SqlDatabaseChain/SqlDatabaseChain'), ['url'])

        for (const [modulePath, names] of [
            ['../nodes/memory/AgentMemory/AgentMemory', ['additionalConfig']],
            ['../nodes/memory/AgentMemory/MySQLAgentMemory/MySQLAgentMemory', ['additionalConfig']],
            ['../nodes/memory/AgentMemory/PostgresAgentMemory/PostgresAgentMemory', ['additionalConfig']],
            ['../nodes/memory/AgentMemory/SQLiteAgentMemory/SQLiteAgentMemory', ['additionalConfig']],
            ['../nodes/vectorstores/Postgres/Postgres', ['additionalConfig']],
            ['../nodes/recordmanager/MySQLRecordManager/MySQLrecordManager', ['additionalConfig']],
            ['../nodes/recordmanager/PostgresRecordManager/PostgresRecordManager', ['additionalConfig']],
            ['../nodes/recordmanager/SQLiteRecordManager/SQLiteRecordManager', ['additionalConfig']]
        ] as const) {
            expectRebind(loadInputs(modulePath), [...names])
        }

        for (const [modulePath, names] of [
            ['../nodes/agentflow/ExecuteFlow/ExecuteFlow', ['executeFlowOverrideConfig']],
            ['../nodes/sequentialagents/ExecuteFlow/ExecuteFlow', ['overrideConfig']],
            ['../nodes/tools/AgentAsTool/AgentAsTool', ['overrideConfig']],
            ['../nodes/tools/ChatflowTool/ChatflowTool', ['overrideConfig']]
        ] as const) {
            expectRebind(loadInputs(modulePath), [...names])
        }

        for (const modulePath of [
            '../nodes/chatmodels/ChatLocalAI/ChatLocalAI',
            '../nodes/chatmodels/ChatLitellm/ChatLitellm',
            '../nodes/chatmodels/ChatNvdiaNIM/ChatNvdiaNIM',
            '../nodes/embeddings/LocalAIEmbedding/LocalAIEmbedding'
        ]) {
            const basePath = loadInputs(modulePath).find((input) => input.name === 'basePath')
            expect(basePath).toEqual(expect.objectContaining({ type: 'string' }))
            expect(basePath).not.toHaveProperty('workspaceExportPolicy')
        }
    })
})
