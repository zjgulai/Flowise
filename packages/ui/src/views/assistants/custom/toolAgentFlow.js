export const toolAgentFlow = {
    nodes: [
        {
            id: 'bufferMemory_0',
            data: {
                id: 'bufferMemory_0',
                label: '缓存记忆',
                version: 2,
                name: 'bufferMemory',
                type: 'BufferMemory',
                baseClasses: ['BufferMemory', 'BaseChatMemory', 'BaseMemory'],
                category: 'Memory',
                description: '从数据库中检索存储的聊天消息',
                inputParams: [
                    {
                        label: '会话 ID',
                        name: 'sessionId',
                        type: 'string',
                        description:
                            '如果未指定，将使用随机 ID。了解更多<a target="_blank" href="https://docs.flowiseai.com/memory#ui-and-embedded-chat">此处</a>',
                        default: '',
                        additionalParams: true,
                        optional: true,
                        id: 'bufferMemory_0-input-sessionId-string'
                    },
                    {
                        label: '记忆键',
                        name: 'memoryKey',
                        type: 'string',
                        default: 'chat_history',
                        additionalParams: true,
                        id: 'bufferMemory_0-input-memoryKey-string'
                    }
                ],
                inputAnchors: [],
                inputs: {
                    sessionId: '',
                    memoryKey: 'chat_history'
                },
                outputAnchors: [
                    {
                        id: 'bufferMemory_0-output-bufferMemory-BufferMemory|BaseChatMemory|BaseMemory',
                        name: 'bufferMemory',
                        label: 'BufferMemory',
                        description: '从数据库中检索存储的聊天消息',
                        type: 'BufferMemory | BaseChatMemory | BaseMemory'
                    }
                ],
                outputs: {}
            }
        },
        {
            id: 'chatOpenAI_0',
            data: {
                id: 'chatOpenAI_0',
                label: 'ChatOpenAI',
                version: 8,
                name: 'chatOpenAI',
                type: 'ChatOpenAI',
                baseClasses: ['ChatOpenAI', 'BaseChatModel', 'BaseLanguageModel', 'Runnable'],
                category: 'Chat Models',
                description: '使用聊天端点的 OpenAI 大语言模型的封装器',
                inputParams: [
                    {
                        label: '连接凭据',
                        name: 'credential',
                        type: 'credential',
                        credentialNames: ['openAIApi'],
                        id: 'chatOpenAI_0-input-credential-credential'
                    },
                    {
                        label: '模型名称',
                        name: 'modelName',
                        type: 'asyncOptions',
                        loadMethod: 'listModels',
                        default: 'gpt-4o-mini',
                        id: 'chatOpenAI_0-input-modelName-asyncOptions'
                    },
                    {
                        label: '温度',
                        name: 'temperature',
                        type: 'number',
                        step: 0.1,
                        default: 0.9,
                        optional: true,
                        id: 'chatOpenAI_0-input-temperature-number'
                    },
                    {
                        label: '流式传输',
                        name: 'streaming',
                        type: 'boolean',
                        default: true,
                        optional: true,
                        additionalParams: true,
                        id: 'chatOpenAI_0-input-streaming-boolean'
                    },
                    {
                        label: '最大 Token 数',
                        name: 'maxTokens',
                        type: 'number',
                        step: 1,
                        optional: true,
                        additionalParams: true,
                        id: 'chatOpenAI_0-input-maxTokens-number'
                    },
                    {
                        label: 'Top 概率',
                        name: 'topP',
                        type: 'number',
                        step: 0.1,
                        optional: true,
                        additionalParams: true,
                        id: 'chatOpenAI_0-input-topP-number'
                    },
                    {
                        label: '频率惩罚',
                        name: 'frequencyPenalty',
                        type: 'number',
                        step: 0.1,
                        optional: true,
                        additionalParams: true,
                        id: 'chatOpenAI_0-input-frequencyPenalty-number'
                    },
                    {
                        label: '存在惩罚',
                        name: 'presencePenalty',
                        type: 'number',
                        step: 0.1,
                        optional: true,
                        additionalParams: true,
                        id: 'chatOpenAI_0-input-presencePenalty-number'
                    },
                    {
                        label: '超时',
                        name: 'timeout',
                        type: 'number',
                        step: 1,
                        optional: true,
                        additionalParams: true,
                        id: 'chatOpenAI_0-input-timeout-number'
                    },
                    {
                        label: 'BasePath',
                        name: 'basepath',
                        type: 'string',
                        optional: true,
                        additionalParams: true,
                        id: 'chatOpenAI_0-input-basepath-string'
                    },
                    {
                        label: '代理地址',
                        name: 'proxyUrl',
                        type: 'string',
                        optional: true,
                        additionalParams: true,
                        id: 'chatOpenAI_0-input-proxyUrl-string'
                    },
                    {
                        label: '停止序列',
                        name: 'stopSequence',
                        type: 'string',
                        rows: 4,
                        optional: true,
                        description: '生成时使用的停止词列表。使用逗号分隔多个停止词。',
                        additionalParams: true,
                        id: 'chatOpenAI_0-input-stopSequence-string'
                    },
                    {
                        label: '基础选项',
                        name: 'baseOptions',
                        type: 'json',
                        optional: true,
                        additionalParams: true,
                        id: 'chatOpenAI_0-input-baseOptions-json'
                    },
                    {
                        label: '允许图片上传',
                        name: 'allowImageUploads',
                        type: 'boolean',
                        description:
                            '允许图片输入。更多详情请参考<a href="https://docs.flowiseai.com/using-flowise/uploads#image" target="_blank">文档</a>。',
                        default: false,
                        optional: true,
                        id: 'chatOpenAI_0-input-allowImageUploads-boolean'
                    }
                ],
                inputAnchors: [
                    {
                        label: '缓存',
                        name: 'cache',
                        type: 'BaseCache',
                        optional: true,
                        id: 'chatOpenAI_0-input-cache-BaseCache'
                    }
                ],
                inputs: {
                    cache: '',
                    modelName: 'gpt-4o-mini',
                    temperature: 0.9,
                    streaming: true,
                    maxTokens: '',
                    topP: '',
                    frequencyPenalty: '',
                    presencePenalty: '',
                    timeout: '',
                    basepath: '',
                    proxyUrl: '',
                    stopSequence: '',
                    baseOptions: '',
                    allowImageUploads: ''
                },
                outputAnchors: [
                    {
                        id: 'chatOpenAI_0-output-chatOpenAI-ChatOpenAI|BaseChatModel|BaseLanguageModel|Runnable',
                        name: 'chatOpenAI',
                        label: 'ChatOpenAI',
                        description: '封装使用聊天端点的 OpenAI 大语言模型',
                        type: 'ChatOpenAI | BaseChatModel | BaseLanguageModel | Runnable'
                    }
                ],
                outputs: {}
            }
        },
        {
            id: 'toolAgent_0',
            data: {
                id: 'toolAgent_0',
                label: '工具代理',
                version: 2,
                name: 'toolAgent',
                type: 'AgentExecutor',
                baseClasses: ['AgentExecutor', 'BaseChain', 'Runnable'],
                category: 'Agents',
                description: '使用函数调用来选择要调用的工具和参数的代理',
                inputParams: [
                    {
                        label: '系统消息',
                        name: 'systemMessage',
                        type: 'string',
                        default: 'You are a helpful AI assistant.',
                        description: '如果提供了聊天提示模板，此项将被忽略',
                        rows: 4,
                        optional: true,
                        additionalParams: true,
                        id: 'toolAgent_0-input-systemMessage-string'
                    },
                    {
                        label: '最大迭代次数',
                        name: 'maxIterations',
                        type: 'number',
                        optional: true,
                        additionalParams: true,
                        id: 'toolAgent_0-input-maxIterations-number'
                    }
                ],
                inputAnchors: [
                    {
                        label: '工具',
                        name: 'tools',
                        type: 'Tool',
                        list: true,
                        id: 'toolAgent_0-input-tools-Tool'
                    },
                    {
                        label: '记忆',
                        name: 'memory',
                        type: 'BaseChatMemory',
                        id: 'toolAgent_0-input-memory-BaseChatMemory'
                    },
                    {
                        label: '工具调用聊天模型',
                        name: 'model',
                        type: 'BaseChatModel',
                        description:
                            '仅兼容支持函数调用的模型：ChatOpenAI、ChatMistral、ChatAnthropic、ChatGoogleGenerativeAI、ChatVertexAI、GroqChat',
                        id: 'toolAgent_0-input-model-BaseChatModel'
                    },
                    {
                        label: '聊天提示模板',
                        name: 'chatPromptTemplate',
                        type: 'ChatPromptTemplate',
                        description: '使用聊天提示模板覆盖现有提示。人类消息必须包含 {input} 变量',
                        optional: true,
                        id: 'toolAgent_0-input-chatPromptTemplate-ChatPromptTemplate'
                    },
                    {
                        label: '输入审核',
                        description: '检测可能生成有害输出的文本，并阻止其发送到语言模型',
                        name: 'inputModeration',
                        type: 'Moderation',
                        optional: true,
                        list: true,
                        id: 'toolAgent_0-input-inputModeration-Moderation'
                    }
                ],
                inputs: {
                    tools: [],
                    memory: '{{bufferMemory_0.data.instance}}',
                    model: '{{chatOpenAI_0.data.instance}}',
                    chatPromptTemplate: '',
                    systemMessage: 'You are helpful assistant',
                    inputModeration: '',
                    maxIterations: ''
                },
                outputAnchors: [
                    {
                        id: 'toolAgent_0-output-toolAgent-AgentExecutor|BaseChain|Runnable',
                        name: 'toolAgent',
                        label: 'AgentExecutor',
                        description: '使用函数调用来选择要调用的工具和参数的代理',
                        type: 'AgentExecutor | BaseChain | Runnable'
                    }
                ],
                outputs: {}
            }
        }
    ],
    edges: [
        {
            source: 'bufferMemory_0',
            sourceHandle: 'bufferMemory_0-output-bufferMemory-BufferMemory|BaseChatMemory|BaseMemory',
            target: 'toolAgent_0',
            targetHandle: 'toolAgent_0-input-memory-BaseChatMemory',
            type: 'buttonedge',
            id: 'bufferMemory_0-bufferMemory_0-output-bufferMemory-BufferMemory|BaseChatMemory|BaseMemory-toolAgent_0-toolAgent_0-input-memory-BaseChatMemory'
        },
        {
            source: 'chatOpenAI_0',
            sourceHandle: 'chatOpenAI_0-output-chatOpenAI-ChatOpenAI|BaseChatModel|BaseLanguageModel|Runnable',
            target: 'toolAgent_0',
            targetHandle: 'toolAgent_0-input-model-BaseChatModel',
            type: 'buttonedge',
            id: 'chatOpenAI_0-chatOpenAI_0-output-chatOpenAI-ChatOpenAI|BaseChatModel|BaseLanguageModel|Runnable-toolAgent_0-toolAgent_0-input-model-BaseChatModel'
        }
    ]
}
