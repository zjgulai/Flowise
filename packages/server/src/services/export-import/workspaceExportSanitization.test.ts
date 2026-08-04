import { Assistant } from '../../database/entities/Assistant'
import { ChatFlow, EnumChatflowType } from '../../database/entities/ChatFlow'
import { sanitizeWorkspaceExportWireData } from './workspaceExportSanitization'
import type { WorkspaceImportData } from './workspaceImportSecurity'

const ID = '11111111-1111-4111-8111-111111111111'
const SECRET = 'literal-secret-sentinel'
const CANONICAL_ORIGIN = 'https://flowise.example.invalid'
const componentNodes = {
    customMCP: {
        name: 'customMCP',
        inputs: [
            { name: 'passwordValue', type: 'password' },
            { name: 'requestHeaders', type: 'json' },
            { name: 'baseOptions', type: 'json' },
            { name: 'callbackSecret', type: 'string' },
            { name: 'bearerToken', type: 'string' },
            { name: 'webhookSecret', type: 'string' }
        ]
    },
    ChatflowTool: {
        name: 'ChatflowTool',
        inputs: [
            { name: 'selectedChatflow', type: 'asyncOptions' },
            { name: 'baseURL', type: 'string' },
            { name: 'overrideConfig', type: 'json', workspaceExportPolicy: 'rebind' }
        ]
    },
    agentAgentflow: {
        name: 'agentAgentflow',
        inputs: [
            { name: 'agentModel', type: 'asyncOptions' },
            { name: 'agentTools', type: 'array' },
            { name: 'agentKnowledgeVSEmbeddings', type: 'array' }
        ]
    },
    llmAgentflow: {
        name: 'llmAgentflow',
        inputs: [{ name: 'llmModel', type: 'asyncOptions' }]
    },
    conditionAgentAgentflow: {
        name: 'conditionAgentAgentflow',
        inputs: [{ name: 'conditionAgentModel', type: 'asyncOptions' }]
    },
    humanInputAgentflow: {
        name: 'humanInputAgentflow',
        inputs: [{ name: 'humanInputModel', type: 'asyncOptions' }]
    },
    toolAgentflow: {
        name: 'toolAgentflow',
        inputs: [
            { name: 'toolAgentflowSelectedTool', type: 'asyncOptions' },
            { name: 'toolAgentflowSelectedToolConfig', type: 'json' }
        ]
    },
    syntheticLoader: {
        name: 'syntheticLoader',
        category: 'Document Loaders',
        baseClasses: ['Document'],
        filePath: '/synthetic/loader.js',
        inputs: [
            { name: 'fileObject', type: 'file' },
            { name: 'folderPath', type: 'string', workspaceExportPolicy: 'rebind' },
            { name: 'passwordValue', type: 'password' },
            { name: 'baseOptions', type: 'json' },
            { name: 'safeLoaderOption', type: 'string' }
        ]
    },
    googleSheets: {
        name: 'googleSheets',
        category: 'Document Loaders',
        baseClasses: ['Document'],
        filePath: '/nodes/documentloaders/GoogleSheets/GoogleSheets.ts',
        inputs: [{ name: 'includeHeaders', type: 'boolean' }]
    },
    syntheticSplitter: {
        name: 'syntheticSplitter',
        category: 'Text Splitters',
        baseClasses: ['TextSplitter'],
        filePath: '/synthetic/splitter.js',
        inputs: [
            { name: 'credential', type: 'credential' },
            { name: 'chunkSize', type: 'number' }
        ]
    },
    markdownTextSplitter: {
        name: 'markdownTextSplitter',
        category: 'Text Splitters',
        baseClasses: ['TextSplitter'],
        filePath: '/nodes/textsplitters/MarkdownTextSplitter/MarkdownTextSplitter.ts',
        inputs: [{ name: 'splitByHeaders', type: 'options' }]
    },
    openAIEmbeddings: {
        name: 'openAIEmbeddings',
        category: 'Embeddings',
        baseClasses: ['Embeddings'],
        filePath: '/synthetic/embeddings.js',
        inputs: [
            { name: 'credential', type: 'credential' },
            { name: 'baseOptions', type: 'json' },
            { name: 'modelName', type: 'string' }
        ]
    },
    syntheticVectorStore: {
        name: 'syntheticVectorStore',
        category: 'Vector Stores',
        baseClasses: ['VectorStoreRetriever'],
        filePath: '/synthetic/vector.js',
        inputs: [
            { name: 'credential', type: 'credential' },
            { name: 'requestsPostHeaders', type: 'json' },
            { name: 'collectionName', type: 'string' }
        ]
    },
    meilisearch: {
        name: 'meilisearch',
        category: 'Vector Stores',
        baseClasses: ['BaseRetriever'],
        filePath: '/nodes/vectorstores/Meilisearch/Meilisearch.ts',
        credential: { name: 'credential' },
        inputs: [
            { name: 'host', type: 'string' },
            { name: 'indexUid', type: 'string' },
            { name: 'credential', type: 'credential' }
        ]
    },
    milvus: {
        name: 'milvus',
        category: 'Vector Stores',
        baseClasses: ['VectorStoreRetriever', 'BaseRetriever'],
        filePath: '/nodes/vectorstores/Milvus/Milvus.ts',
        inputs: [
            { name: 'milvusServerUrl', type: 'string' },
            { name: 'milvusCollection', type: 'string' },
            { name: 'clientPemPath', type: 'string', workspaceExportPolicy: 'rebind' },
            { name: 'clientKeyPath', type: 'string', workspaceExportPolicy: 'rebind' },
            { name: 'caPemPath', type: 'string', workspaceExportPolicy: 'rebind' }
        ]
    },
    folderFiles: {
        name: 'folderFiles',
        category: 'Document Loaders',
        baseClasses: ['Document'],
        filePath: '/nodes/documentloaders/Folder/Folder.ts',
        inputs: [
            { name: 'folderPath', type: 'string', workspaceExportPolicy: 'rebind' },
            { name: 'recursive', type: 'boolean' }
        ]
    },
    endpointBasePath: {
        name: 'endpointBasePath',
        inputs: [{ name: 'basePath', type: 'string' }]
    },
    sqlDatabaseChain: {
        name: 'sqlDatabaseChain',
        inputs: [
            { name: 'url', type: 'string', workspaceExportPolicy: 'rebind' },
            { name: 'includesTables', type: 'string' }
        ]
    },
    agentMemory: {
        name: 'agentMemory',
        inputs: [
            { name: 'additionalConfig', type: 'json', workspaceExportPolicy: 'rebind' },
            { name: 'port', type: 'number' }
        ]
    },
    postgres: {
        name: 'postgres',
        category: 'Vector Stores',
        baseClasses: ['VectorStoreRetriever', 'BaseRetriever'],
        filePath: '/nodes/vectorstores/Postgres/Postgres.ts',
        inputs: [
            { name: 'additionalConfig', type: 'json', workspaceExportPolicy: 'rebind' },
            { name: 'collectionName', type: 'string' }
        ]
    },
    syntheticEmbeddings: {
        name: 'syntheticEmbeddings',
        category: 'Embeddings',
        baseClasses: ['Embeddings'],
        filePath: '/synthetic/embeddings.js',
        inputs: [
            { name: 'credential', type: 'credential' },
            { name: 'modelName', type: 'string' }
        ]
    },
    syntheticChatModel: {
        name: 'syntheticChatModel',
        category: 'Chat Models',
        baseClasses: ['BaseChatModel'],
        filePath: '/synthetic/chat-model.js',
        inputs: [
            { name: 'transportAuth', type: 'password' },
            { name: 'clientCertificatePath', type: 'string', workspaceExportPolicy: 'rebind' },
            { name: 'baseURL', type: 'string' },
            { name: 'modelName', type: 'string' }
        ]
    },
    syntheticRecordManager: {
        name: 'syntheticRecordManager',
        category: 'Record Manager',
        baseClasses: ['RecordManager'],
        filePath: '/synthetic/record-manager.js',
        inputs: [
            { name: 'password', type: 'password' },
            { name: 'namespace', type: 'string' }
        ]
    }
} as never

const emptyPayload = (): WorkspaceImportData => ({
    AgentFlow: [],
    AgentFlowV2: [],
    AssistantCustom: [],
    AssistantFlow: [],
    AssistantOpenAI: [],
    AssistantAzure: [],
    ChatFlow: [],
    ChatMessage: [],
    ChatMessageFeedback: [],
    CustomTemplate: [],
    DocumentStore: [],
    DocumentStoreFileChunk: [],
    Execution: [],
    Tool: [],
    Variable: []
})

const secretNode = (
    baseOptions: unknown = JSON.stringify({
        Authorization: `Bearer ${SECRET}`,
        'Ocp-Apim-Subscription-Key': SECRET,
        'X-Functions-Key': SECRET,
        defaultHeaders: { Authorization: SECRET },
        apiKey: SECRET,
        temperature: 0
    })
) => ({
    data: {
        name: 'customMCP',
        credential: ID,
        FLOWISE_CREDENTIAL_ID: ID,
        inputParams: [
            { name: 'passwordValue', type: 'password' },
            { name: 'requestHeaders', type: 'json' }
        ],
        inputs: {
            credential: ID,
            credentialId: ID,
            passwordValue: SECRET,
            requestsGetHeaders: JSON.stringify({ Authorization: `Bearer ${SECRET}` }),
            requestHeaders: [{ key: 'X-My-API-Key', value: SECRET }],
            mcpServerConfig: JSON.stringify({ env: { TOKEN: SECRET } }),
            mcpActions: ['dangerous-action'],
            openAIApiKey: SECRET,
            callbackSecret: SECRET,
            bearerToken: SECRET,
            webhookSecret: SECRET,
            baseOptions,
            nestedLegacyConfig: { myClientSecret: SECRET, maxTokens: 42 },
            safePrompt: 'keep-me'
        }
    }
})

describe('workspace export canonical sanitization', () => {
    it('plainifies TypeORM entities and strips credentials, headers, password inputs, and inline MCP configuration', () => {
        const payload = emptyPayload()
        const flow = Object.assign(new ChatFlow(), {
            id: ID,
            name: 'Synthetic flow',
            type: EnumChatflowType.CHATFLOW,
            flowData: JSON.stringify({
                nodes: [
                    secretNode(),
                    secretNode({ defaultHeaders: { Authorization: SECRET }, token: SECRET, temperature: 0 }),
                    {
                        data: {
                            name: 'ChatflowTool',
                            inputs: {
                                selectedChatflow: ID,
                                baseURL: CANONICAL_ORIGIN,
                                overrideConfig: {
                                    folderPath: `/tmp/${SECRET}`,
                                    additionalConfig: { ssl: { key: SECRET } }
                                }
                            }
                        }
                    }
                ],
                edges: []
            }),
            chatbotConfig: JSON.stringify({ theme: 'light', openAIApiKey: SECRET }),
            analytic: JSON.stringify({ nested: { clientSecret: SECRET }, enabled: true }),
            workspaceId: 'source-workspace',
            createdDate: new Date('2026-08-02T00:00:00.000Z'),
            updatedDate: new Date('2026-08-02T00:00:00.000Z')
        })
        payload.ChatFlow = [flow]

        const assistant = Object.assign(new Assistant(), {
            id: '22222222-2222-4222-8222-222222222222',
            type: 'CUSTOM',
            credential: ID,
            details: JSON.stringify({
                flowId: ID,
                documentStores: [],
                credential: ID,
                chatModel: secretNode().data,
                tools: [
                    secretNode().data,
                    {
                        name: 'agentAgentflow',
                        inputs: {
                            agentTools: [
                                {
                                    agentSelectedTool: 'customMCP',
                                    agentSelectedToolConfig: {
                                        mcpServerConfig: JSON.stringify({ headers: { 'X-Functions-Key': SECRET } }),
                                        mcpActions: ['dangerous-action'],
                                        safePrompt: 'keep-assistant-agent'
                                    }
                                }
                            ]
                        }
                    }
                ]
            })
        })
        payload.AssistantCustom = [assistant]
        payload.CustomTemplate = [
            {
                id: '33333333-3333-4333-8333-333333333333',
                name: 'Synthetic template',
                type: 'Flow',
                flowData: JSON.stringify({ nodes: [secretNode()], edges: [] })
            } as never
        ]
        payload.DocumentStore = [
            {
                id: '44444444-4444-4444-8444-444444444444',
                name: 'Synthetic store',
                loaders: JSON.stringify([
                    {
                        id: 'loader',
                        loaderId: 'syntheticLoader',
                        loaderConfig: {
                            fileObject: `/tmp/${SECRET}.pdf`,
                            folderPath: `/tmp/${SECRET}`,
                            passwordValue: SECRET,
                            baseOptions: JSON.stringify({ 'Ocp-Apim-Subscription-Key': SECRET, timeout: 30 }),
                            safeLoaderOption: 'keep-loader'
                        },
                        splitterId: 'syntheticSplitter',
                        splitterConfig: { credential: ID, chunkSize: 800 },
                        credential: ID
                    }
                ]),
                embeddingConfig: JSON.stringify({
                    name: 'openAIEmbeddings',
                    config: {
                        credential: ID,
                        baseOptions: JSON.stringify({ 'X-Functions-Key': SECRET, timeout: 45 }),
                        modelName: 'safe-model'
                    }
                }),
                vectorStoreConfig: JSON.stringify({
                    name: 'syntheticVectorStore',
                    config: { credential: ID, requestsPostHeaders: JSON.stringify({ Authorization: SECRET }), collectionName: 'safe' }
                }),
                recordManagerConfig: JSON.stringify({
                    name: 'syntheticRecordManager',
                    config: { password: SECRET, namespace: 'safe-namespace' }
                })
            } as never
        ]

        const sanitized = sanitizeWorkspaceExportWireData(payload, componentNodes, CANONICAL_ORIGIN)
        const serialized = JSON.stringify(sanitized)
        expect(serialized).not.toContain(SECRET)
        expect(serialized).not.toMatch(/FLOWISE_CREDENTIAL_ID|"credential"|"credentialId"/)
        expect(JSON.parse(sanitized.ChatFlow[0].flowData).nodes[0].data.inputs).toEqual({
            nestedLegacyConfig: { maxTokens: 42 },
            safePrompt: 'keep-me'
        })
        expect(JSON.parse(sanitized.ChatFlow[0].flowData).nodes[1].data.inputs).toEqual({
            nestedLegacyConfig: { maxTokens: 42 },
            safePrompt: 'keep-me'
        })
        expect(JSON.parse(sanitized.ChatFlow[0].flowData).nodes[2].data.inputs).toEqual({ selectedChatflow: ID, baseURL: '' })
        expect(JSON.parse(sanitized.ChatFlow[0].chatbotConfig as string)).toEqual({ theme: 'light' })
        expect(JSON.parse(sanitized.ChatFlow[0].analytic as string)).toEqual({ nested: {}, enabled: true })
        expect(JSON.parse(sanitized.AssistantCustom[0].details).chatModel.inputs).toEqual({
            nestedLegacyConfig: { maxTokens: 42 },
            safePrompt: 'keep-me'
        })
        expect(JSON.parse(sanitized.AssistantCustom[0].details).tools[1].inputs.agentTools[0].agentSelectedToolConfig).toEqual({
            safePrompt: 'keep-assistant-agent'
        })
        expect(JSON.parse(sanitized.DocumentStore[0].loaders)).toEqual([
            expect.objectContaining({
                loaderConfig: { safeLoaderOption: 'keep-loader' },
                splitterConfig: { chunkSize: 800 }
            })
        ])
        expect(JSON.parse(sanitized.DocumentStore[0].embeddingConfig as string)).toEqual({
            name: 'openAIEmbeddings',
            config: { modelName: 'safe-model' }
        })
        expect(JSON.parse(sanitized.DocumentStore[0].vectorStoreConfig as string)).toEqual({
            name: 'syntheticVectorStore',
            config: { collectionName: 'safe' }
        })
        expect(JSON.parse(sanitized.DocumentStore[0].recordManagerConfig as string)).toEqual({
            name: 'syntheticRecordManager',
            config: { namespace: 'safe-namespace' }
        })
        expect(sanitized.ChatFlow[0].createdDate).toBe('2026-08-02T00:00:00.000Z')
    })

    it('rebuilds the real Tool-template response shape after the marketplace service clears flowData', () => {
        const payload = emptyPayload()
        payload.CustomTemplate = [
            {
                id: ID,
                name: 'Synthetic tool template',
                type: 'Tool',
                flowData: undefined,
                iconSrc: 'tool.svg',
                schema: '[]',
                func: 'return "fixture"'
            } as never
        ]

        const [template] = sanitizeWorkspaceExportWireData(payload, componentNodes, CANONICAL_ORIGIN).CustomTemplate
        expect(JSON.parse(template.flowData)).toEqual({ iconSrc: 'tool.svg', schema: '[]', func: 'return "fixture"' })
    })

    it('sanitizes a production-listed Meilisearch BaseRetriever configuration without rejecting the export', () => {
        const payload = emptyPayload()
        payload.DocumentStore = [
            {
                id: '44444444-4444-4444-8444-444444444444',
                name: 'Meilisearch store',
                loaders: '[]',
                vectorStoreConfig: JSON.stringify({
                    name: 'meilisearch',
                    config: { credential: ID, host: 'https://search.example.invalid', indexUid: 'knowledge' }
                })
            } as never
        ]

        const [store] = sanitizeWorkspaceExportWireData(payload, componentNodes, CANONICAL_ORIGIN).DocumentStore
        expect(JSON.parse(store.vectorStoreConfig as string)).toEqual({
            name: 'meilisearch',
            config: { host: 'https://search.example.invalid', indexUid: 'knowledge' }
        })
    })

    it('removes trusted environment-local string paths across flows, wrappers, and document stores while preserving endpoints', () => {
        const payload = emptyPayload()
        payload.ChatFlow = [
            {
                id: ID,
                name: 'Local path flow',
                type: EnumChatflowType.CHATFLOW,
                flowData: JSON.stringify({
                    nodes: [
                        {
                            data: {
                                name: 'folderFiles',
                                inputs: { folderPath: `/tmp/${SECRET}`, recursive: true }
                            }
                        },
                        {
                            data: {
                                name: 'endpointBasePath',
                                inputs: { basePath: 'https://provider.example.invalid/v1' }
                            }
                        },
                        {
                            data: {
                                name: 'sqlDatabaseChain',
                                inputs: {
                                    url: `postgres://user:${SECRET}@database.example.invalid/knowledge`,
                                    includesTables: 'tickets,articles'
                                }
                            }
                        }
                    ],
                    edges: []
                })
            } as never
        ]
        payload.AgentFlowV2 = [
            {
                id: '22222222-2222-4222-8222-222222222222',
                name: 'Wrapped local path',
                type: EnumChatflowType.AGENTFLOW,
                flowData: JSON.stringify({
                    nodes: [
                        {
                            data: {
                                name: 'agentAgentflow',
                                inputs: {
                                    agentTools: [
                                        {
                                            agentSelectedTool: 'milvus',
                                            agentSelectedToolConfig: {
                                                milvusServerUrl: 'https://milvus.example.invalid',
                                                milvusCollection: 'knowledge',
                                                clientPemPath: `/tmp/${SECRET}.pem`,
                                                clientKeyPath: `/tmp/${SECRET}.key`,
                                                caPemPath: `/tmp/${SECRET}-ca.pem`
                                            }
                                        },
                                        {
                                            agentSelectedTool: 'agentMemory',
                                            agentSelectedToolConfig: {
                                                additionalConfig: {
                                                    ssl: {
                                                        ca: SECRET,
                                                        cert: SECRET,
                                                        key: SECRET,
                                                        pfx: SECRET,
                                                        passphrase: SECRET
                                                    }
                                                },
                                                port: 5432
                                            }
                                        }
                                    ],
                                    agentKnowledgeVSEmbeddings: [
                                        {
                                            embeddingModel: 'syntheticEmbeddings',
                                            embeddingModelConfig: { credential: ID, modelName: 'safe-embedding' },
                                            vectorStore: 'postgres',
                                            vectorStoreConfig: {
                                                additionalConfig: {
                                                    ssl: {
                                                        ca: SECRET,
                                                        cert: SECRET,
                                                        key: SECRET,
                                                        pfx: SECRET,
                                                        passphrase: SECRET
                                                    }
                                                },
                                                collectionName: 'knowledge'
                                            },
                                            knowledgeName: 'tickets',
                                            knowledgeDescription: 'Synthetic support knowledge'
                                        }
                                    ]
                                }
                            }
                        }
                    ],
                    edges: []
                })
            } as never
        ]
        payload.DocumentStore = [
            {
                id: '33333333-3333-4333-8333-333333333333',
                name: 'Milvus path store',
                loaders: '[]',
                vectorStoreConfig: JSON.stringify({
                    name: 'milvus',
                    config: {
                        milvusServerUrl: 'https://milvus.example.invalid',
                        milvusCollection: 'knowledge',
                        clientPemPath: `/tmp/${SECRET}.pem`,
                        clientKeyPath: `/tmp/${SECRET}.key`,
                        caPemPath: `/tmp/${SECRET}-ca.pem`
                    }
                })
            } as never,
            {
                id: '55555555-5555-4555-8555-555555555555',
                name: 'Postgres TLS store',
                loaders: '[]',
                vectorStoreConfig: JSON.stringify({
                    name: 'postgres',
                    config: {
                        additionalConfig: {
                            ssl: {
                                ca: SECRET,
                                cert: SECRET,
                                key: SECRET,
                                pfx: SECRET,
                                passphrase: SECRET
                            }
                        },
                        collectionName: 'knowledge'
                    }
                })
            } as never
        ]

        const sanitized = sanitizeWorkspaceExportWireData(payload, componentNodes, CANONICAL_ORIGIN)
        const flowInputs = JSON.parse(sanitized.ChatFlow[0].flowData).nodes.map(
            (node: { data: { inputs: Record<string, unknown> } }) => node.data.inputs
        )
        expect(flowInputs).toEqual([
            { recursive: true },
            { basePath: 'https://provider.example.invalid/v1' },
            { includesTables: 'tickets,articles' }
        ])

        const agentInputs = JSON.parse(sanitized.AgentFlowV2[0].flowData).nodes[0].data.inputs
        expect(agentInputs.agentTools[0].agentSelectedToolConfig).toEqual({
            milvusServerUrl: 'https://milvus.example.invalid',
            milvusCollection: 'knowledge'
        })
        expect(agentInputs.agentTools[1].agentSelectedToolConfig).toEqual({ port: 5432 })
        expect(agentInputs.agentKnowledgeVSEmbeddings[0]).toEqual({
            embeddingModel: 'syntheticEmbeddings',
            embeddingModelConfig: { modelName: 'safe-embedding' },
            vectorStore: 'postgres',
            vectorStoreConfig: { collectionName: 'knowledge' },
            knowledgeName: 'tickets',
            knowledgeDescription: 'Synthetic support knowledge'
        })
        expect(JSON.parse(sanitized.DocumentStore[0].vectorStoreConfig as string)).toEqual({
            name: 'milvus',
            config: {
                milvusServerUrl: 'https://milvus.example.invalid',
                milvusCollection: 'knowledge'
            }
        })
        expect(JSON.parse(sanitized.DocumentStore[1].vectorStoreConfig as string)).toEqual({
            name: 'postgres',
            config: { collectionName: 'knowledge' }
        })
        expect(JSON.stringify(sanitized)).not.toContain(SECRET)
    })

    it('drops orphaned nested knowledge configs and rejects unknown selected child components', () => {
        const createFlow = (knowledge: Record<string, unknown>) =>
            ({
                id: ID,
                name: 'Nested knowledge validation',
                type: EnumChatflowType.AGENTFLOW,
                flowData: JSON.stringify({
                    nodes: [
                        {
                            data: {
                                name: 'agentAgentflow',
                                inputs: { agentKnowledgeVSEmbeddings: [knowledge] }
                            }
                        }
                    ],
                    edges: []
                })
            } as never)

        const orphanedPayload = emptyPayload()
        orphanedPayload.AgentFlowV2 = [
            createFlow({
                embeddingModel: '',
                embeddingModelConfig: { modelName: SECRET },
                vectorStore: null,
                vectorStoreConfig: { additionalConfig: { ssl: { key: SECRET } } },
                knowledgeName: 'safe-name'
            })
        ]
        const orphanedKnowledge = JSON.parse(
            sanitizeWorkspaceExportWireData(orphanedPayload, componentNodes, CANONICAL_ORIGIN).AgentFlowV2[0].flowData
        ).nodes[0].data.inputs.agentKnowledgeVSEmbeddings[0]
        expect(orphanedKnowledge).toEqual({ embeddingModel: '', vectorStore: null, knowledgeName: 'safe-name' })

        const unknownPayload = emptyPayload()
        unknownPayload.AgentFlowV2 = [
            createFlow({
                embeddingModel: 'unknownEmbeddings',
                embeddingModelConfig: {},
                vectorStore: 'postgres',
                vectorStoreConfig: { collectionName: 'knowledge' }
            })
        ]
        expect(() => sanitizeWorkspaceExportWireData(unknownPayload, componentNodes, CANONICAL_ORIGIN)).toThrow(
            'Workspace export contains unsupported data'
        )
    })

    it('sanitizes all four dynamic Agentflow model configs with selected child metadata', () => {
        const payload = emptyPayload()
        const modelCases = [
            ['agentAgentflow', 'agentModel', 'agentModelConfig'],
            ['llmAgentflow', 'llmModel', 'llmModelConfig'],
            ['conditionAgentAgentflow', 'conditionAgentModel', 'conditionAgentModelConfig'],
            ['humanInputAgentflow', 'humanInputModel', 'humanInputModelConfig']
        ] as const
        payload.AgentFlowV2 = [
            {
                id: ID,
                name: 'Dynamic model configs',
                type: EnumChatflowType.AGENTFLOW,
                flowData: JSON.stringify({
                    nodes: modelCases.map(([name, selectionKey, configKey]) => ({
                        data: {
                            name,
                            inputs: {
                                [selectionKey]: 'syntheticChatModel',
                                [configKey]: {
                                    transportAuth: SECRET,
                                    clientCertificatePath: `/tmp/${SECRET}.pem`,
                                    baseURL: 'https://model.example.invalid/v1',
                                    modelName: 'safe-model'
                                }
                            }
                        }
                    })),
                    edges: []
                })
            } as never
        ]

        const nodes = JSON.parse(sanitizeWorkspaceExportWireData(payload, componentNodes, CANONICAL_ORIGIN).AgentFlowV2[0].flowData).nodes
        for (const [index, [, selectionKey, configKey]] of modelCases.entries()) {
            expect(nodes[index].data.inputs).toEqual({
                [selectionKey]: 'syntheticChatModel',
                [configKey]: {
                    baseURL: 'https://model.example.invalid/v1',
                    modelName: 'safe-model'
                }
            })
        }
        expect(JSON.stringify(nodes)).not.toContain(SECRET)
    })

    it('drops an unselected model config and rejects an unknown selected model', () => {
        const createPayload = (model: unknown, config: unknown): WorkspaceImportData => {
            const payload = emptyPayload()
            payload.AgentFlowV2 = [
                {
                    id: ID,
                    name: 'Dynamic model selection validation',
                    type: EnumChatflowType.AGENTFLOW,
                    flowData: JSON.stringify({
                        nodes: [
                            {
                                data: {
                                    name: 'llmAgentflow',
                                    inputs: { llmModel: model, llmModelConfig: config }
                                }
                            }
                        ],
                        edges: []
                    })
                } as never
            ]
            return payload
        }

        const unselected = sanitizeWorkspaceExportWireData(createPayload('', { transportAuth: SECRET }), componentNodes, CANONICAL_ORIGIN)
        expect(JSON.parse(unselected.AgentFlowV2[0].flowData).nodes[0].data.inputs).toEqual({ llmModel: '' })

        expect(() => sanitizeWorkspaceExportWireData(createPayload('unknownModel', {}), componentNodes, CANONICAL_ORIGIN)).toThrow(
            'Workspace export contains unsupported data'
        )
    })

    it('preserves non-secret Google Sheets and Markdown splitter options whose names end in Headers', () => {
        const payload = emptyPayload()
        payload.DocumentStore = [
            {
                id: '44444444-4444-4444-8444-444444444444',
                name: 'Header semantics store',
                loaders: JSON.stringify([
                    {
                        id: '55555555-5555-4555-8555-555555555555',
                        loaderId: 'googleSheets',
                        loaderConfig: { includeHeaders: true },
                        splitterId: 'markdownTextSplitter',
                        splitterConfig: { splitByHeaders: '#,##' }
                    }
                ])
            } as never
        ]

        const [store] = sanitizeWorkspaceExportWireData(payload, componentNodes, CANONICAL_ORIGIN).DocumentStore
        expect(JSON.parse(store.loaders)).toEqual([
            expect.objectContaining({
                loaderConfig: { includeHeaders: true },
                splitterConfig: { splitByHeaders: '#,##' }
            })
        ])
    })

    it('sanitizes embedded Agent and Tool wrapper component configurations with trusted child metadata', () => {
        const payload = emptyPayload()
        payload.AgentFlowV2 = [
            {
                id: ID,
                name: 'Nested tools',
                type: EnumChatflowType.AGENTFLOW,
                flowData: JSON.stringify({
                    nodes: [
                        {
                            data: {
                                name: 'agentAgentflow',
                                inputs: {
                                    agentTools: [
                                        {
                                            agentSelectedTool: 'customMCP',
                                            agentSelectedToolConfig: {
                                                mcpServerConfig: JSON.stringify({ env: { TOKEN: SECRET } }),
                                                mcpActions: ['dangerous-action'],
                                                safePrompt: 'keep-agent'
                                            }
                                        }
                                    ]
                                }
                            }
                        },
                        {
                            data: {
                                name: 'toolAgentflow',
                                inputs: {
                                    toolAgentflowSelectedTool: 'customMCP',
                                    toolAgentflowSelectedToolConfig: {
                                        mcpServerConfig: JSON.stringify({ headers: { Authorization: SECRET } }),
                                        safePrompt: 'keep-tool'
                                    }
                                }
                            }
                        }
                    ],
                    edges: []
                })
            } as never
        ]

        const flowData = JSON.parse(sanitizeWorkspaceExportWireData(payload, componentNodes, CANONICAL_ORIGIN).AgentFlowV2[0].flowData)
        expect(JSON.stringify(flowData)).not.toContain(SECRET)
        expect(flowData.nodes[0].data.inputs.agentTools[0].agentSelectedToolConfig).toEqual({ safePrompt: 'keep-agent' })
        expect(flowData.nodes[1].data.inputs.toolAgentflowSelectedToolConfig).toEqual({ safePrompt: 'keep-tool' })
    })

    it('rejects prototype-chain and unknown component names instead of trusting persisted metadata', () => {
        const payload = emptyPayload()
        payload.ChatFlow = [
            {
                id: ID,
                name: 'Untrusted component',
                type: EnumChatflowType.CHATFLOW,
                flowData: JSON.stringify({ nodes: [{ data: { name: 'constructor', inputs: { opaque: SECRET } } }], edges: [] })
            } as never
        ]

        expect(() => sanitizeWorkspaceExportWireData(payload, componentNodes, CANONICAL_ORIGIN)).toThrow(
            expect.objectContaining({ statusCode: 422, message: 'Workspace export contains unsupported data' })
        )
    })

    it('rejects a document-store component from the wrong category before declaring the export portable', () => {
        const payload = emptyPayload()
        payload.DocumentStore = [
            {
                id: ID,
                name: 'Category confused store',
                loaders: JSON.stringify([{ id: 'loader', loaderId: 'customMCP', loaderConfig: {} }])
            } as never
        ]

        expect(() => sanitizeWorkspaceExportWireData(payload, componentNodes, CANONICAL_ORIGIN)).toThrow(
            expect.objectContaining({ statusCode: 422, message: 'Workspace export contains unsupported data' })
        )
    })
})
