/**
 * zh-CN display translations for credential metadata whose identifiers begin
 * with H through O. Stable machine identifiers, brand names, protocol terms,
 * URLs, tokens, and executable placeholders remain unchanged.
 */
export const ZH_CN_CREDENTIALS_B: ReadonlyArray<readonly [string, string]> = [
    ['credential.httpApiKey.root.label@286ec343530c', 'HTTP API 密钥'],
    ['credential.httpApiKey.root/inputs/key.label@99a52df3ff3d', '密钥'],
    ['credential.httpApiKey.root/inputs/value.label@8e37953d23da', '值'],
    ['credential.httpBasicAuth.root.label@a8b8b7c57c4c', 'HTTP Basic Auth'],
    ['credential.httpBasicAuth.root/inputs/basicAuthPassword.label@20b0c7fb25bc', 'Basic Auth 密码'],
    ['credential.httpBasicAuth.root/inputs/basicAuthUsername.label@261dccf49edb', 'Basic Auth 用户名'],
    ['credential.httpBearerToken.root.label@136f940c0f45', 'HTTP Bearer Token'],
    ['credential.httpBearerToken.root/inputs/token.label@d2089be67295', 'Token'],
    ['credential.huggingFaceApi.root.label@fbf0bdef5e49', 'HuggingFace API'],
    ['credential.huggingFaceApi.root/inputs/huggingFaceApiKey.label@972f883151ca', 'HuggingFace API 密钥'],
    ['credential.ibmWatsonx.root.label@02386e091bc6', 'IBM Watsonx'],
    ['credential.ibmWatsonx.root/inputs/projectId.label@e511470b21a9', '项目 ID'],
    ['credential.ibmWatsonx.root/inputs/projectId.placeholder@6f474cd3b0c3', '<PROJECT_ID>'],
    ['credential.ibmWatsonx.root/inputs/serviceUrl.label@1e73fdfdf87b', '服务 URL'],
    ['credential.ibmWatsonx.root/inputs/serviceUrl.placeholder@a891161926db', '<SERVICE_URL>'],
    ['credential.ibmWatsonx.root/inputs/version.label@dd167905de0d', '版本'],
    ['credential.ibmWatsonx.root/inputs/version.placeholder@6c48580bf8e9', 'YYYY-MM-DD'],
    ['credential.ibmWatsonx.root/inputs/watsonxAIApikey.description@548536662dc7', '使用 IAM 时供 Watsonx AI 使用的 API 密钥'],
    ['credential.ibmWatsonx.root/inputs/watsonxAIApikey.label@3edf6c580c13', 'Watsonx AI IAM API 密钥'],
    ['credential.ibmWatsonx.root/inputs/watsonxAIApikey.placeholder@12e40cc1b114', '<YOUR-APIKEY>'],
    ['credential.ibmWatsonx.root/inputs/watsonxAIAuthType.label@1d4b2dd5dfab', 'Watsonx AI 认证类型'],
    ['credential.ibmWatsonx.root/inputs/watsonxAIAuthType/options/bearertoken.label@105f8fe557fe', 'Bearer Token'],
    ['credential.ibmWatsonx.root/inputs/watsonxAIAuthType/options/iam.label@7c6826445eb6', 'IAM'],
    [
        'credential.ibmWatsonx.root/inputs/watsonxAIBearerToken.description@610680a88e00',
        '使用 Bearer Token 时供 Watsonx AI 使用的 Bearer Token'
    ],
    ['credential.ibmWatsonx.root/inputs/watsonxAIBearerToken.label@9f1bf96c1a35', 'Watsonx AI Bearer Token'],
    ['credential.ibmWatsonx.root/inputs/watsonxAIBearerToken.placeholder@9ebf4b396855', '<YOUR-BEARER-TOKEN>'],
    ['credential.jinaAIApi.root.description@fb97bcea4b66', '可从官方<a target="_blank" href="https://jina.ai/">控制台</a>获取 API 密钥。'],
    ['credential.jinaAIApi.root.label@56113158e8bd', 'JinaAI API'],
    ['credential.jinaAIApi.root/inputs/jinaAIAPIKey.label@ade85478474e', 'JinaAI API 密钥'],
    [
        'credential.jiraApi.root.description@ad2c25750bf3',
        '有关如何获取 Jira Access Token，请参阅<a target="_blank" href="https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/">官方指南</a>。'
    ],
    ['credential.jiraApi.root.label@687d2ee88402', 'Jira API'],
    ['credential.jiraApi.root/inputs/accessToken.label@f9db72ced1ee', 'Access Token'],
    ['credential.jiraApi.root/inputs/accessToken.placeholder@d31e2f073b0b', '<JIRA_ACCESS_TOKEN>'],
    ['credential.jiraApi.root/inputs/username.label@a969d04ec2d0', '用户名'],
    ['credential.jiraApi.root/inputs/username.placeholder@795bcb4bf560', 'username@example.com'],
    [
        'credential.jiraApiBearerToken.root.description@84770db46412',
        'Jira Server/Data Center 请使用 Personal Access Token（PAT）。有关如何创建 PAT，请参阅<a target="_blank" href="https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html">官方指南</a>。'
    ],
    ['credential.jiraApiBearerToken.root.label@061cae2183e9', 'Jira API（Bearer Token）'],
    ['credential.jiraApiBearerToken.root/inputs/bearerToken.label@105f8fe557fe', 'Bearer Token'],
    ['credential.jiraApiBearerToken.root/inputs/bearerToken.placeholder@fc251ee11e3e', '<JIRA_PERSONAL_ACCESS_TOKEN>'],
    ['credential.kimiApi.root.label@b14aed42095d', 'Kimi（Moonshot）API'],
    ['credential.kimiApi.root/inputs/kimiApiKey.label@ed10e64c4bba', 'Kimi API 密钥'],
    [
        'credential.langfuseApi.root.description@467530fe1cb5',
        '有关如何在 Langfuse 获取 API 密钥，请参阅<a target="_blank" href="https://langfuse.com/docs/flowise">集成指南</a>。'
    ],
    ['credential.langfuseApi.root.label@02784b650888', 'Langfuse API'],
    ['credential.langfuseApi.root/inputs/langFuseEndpoint.label@3df9726c68ba', '端点'],
    ['credential.langfuseApi.root/inputs/langFusePublicKey.label@a51af74c1dda', '公钥'],
    ['credential.langfuseApi.root/inputs/langFusePublicKey.placeholder@75f5d6c3cc02', 'pk-lf-abcdefg'],
    ['credential.langfuseApi.root/inputs/langFuseSecretKey.label@eeefa4cae35a', '密钥'],
    ['credential.langfuseApi.root/inputs/langFuseSecretKey.placeholder@549ec1c29837', 'sk-lf-abcdefg'],
    [
        'credential.langsmithApi.root.description@281f6cccc115',
        '有关如何在 LangSmith 获取 API 密钥，请参阅<a target="_blank" href="https://docs.smith.langchain.com/">官方指南</a>。'
    ],
    ['credential.langsmithApi.root.label@f23d473bfcea', 'LangSmith API'],
    ['credential.langsmithApi.root/inputs/langSmithApiKey.label@23189d55f697', 'API 密钥'],
    ['credential.langsmithApi.root/inputs/langSmithApiKey.placeholder@1d4c9f3e40af', '<LANGSMITH_API_KEY>'],
    ['credential.langsmithApi.root/inputs/langSmithEndpoint.label@3df9726c68ba', '端点'],
    [
        'credential.langwatchApi.root.description@a4157b373aab',
        '有关如何在 LangWatch 获取 API 密钥，请参阅<a target="_blank" href="https://docs.langwatch.ai/integration/python/guide">集成指南</a>。'
    ],
    ['credential.langwatchApi.root.label@f1fb17067686', 'LangWatch API'],
    ['credential.langwatchApi.root/inputs/langWatchApiKey.label@23189d55f697', 'API 密钥'],
    ['credential.langwatchApi.root/inputs/langWatchApiKey.placeholder@a31c089411cc', '<LANGWATCH_API_KEY>'],
    ['credential.langwatchApi.root/inputs/langWatchEndpoint.label@3df9726c68ba', '端点'],
    ['credential.litellmApi.root.label@7d5277c2e3df', 'LiteLLM API'],
    ['credential.litellmApi.root/inputs/litellmApiKey.label@23189d55f697', 'API 密钥'],
    ['credential.localAIApi.root.label@e51e853ba760', 'LocalAI API'],
    ['credential.localAIApi.root/inputs/localAIApiKey.label@3d00da307314', 'LocalAI API 密钥'],
    [
        'credential.lunaryApi.root.description@4d1321b53c3f',
        '请参阅<a target="_blank" href="https://lunary.ai/docs?utm_source=flowise">官方指南</a>获取公钥。'
    ],
    ['credential.lunaryApi.root.label@6e723d9967a1', 'Lunary AI'],
    ['credential.lunaryApi.root/inputs/lunaryAppId.label@caed1fa21024', '公钥／项目 ID'],
    ['credential.lunaryApi.root/inputs/lunaryAppId.placeholder@23b8466f43b4', '<Lunary_PROJECT_ID>'],
    ['credential.lunaryApi.root/inputs/lunaryEndpoint.label@3df9726c68ba', '端点'],
    [
        'credential.meilisearchApi.root.description@bf26b5096359',
        '有关如何获取 API 密钥，请参阅<a target="_blank" href="https://meilisearch.com">官方指南</a>。基本搜索功能需要搜索 API 密钥；管理 API 密钥可选，但执行 Upsert 时必须提供。'
    ],
    ['credential.meilisearchApi.root.label@39f19a2b3cfc', 'Meilisearch API'],
    ['credential.meilisearchApi.root/inputs/meilisearchAdminApiKey.label@54d5bbb0ab37', 'Meilisearch 管理 API 密钥'],
    ['credential.meilisearchApi.root/inputs/meilisearchSearchApiKey.label@de49561f8d36', 'Meilisearch 搜索 API 密钥'],
    [
        'credential.mem0MemoryApi.root.description@3516da1162b3',
        '请访问<a target="_blank" href="https://app.mem0.ai/settings/api-keys">Mem0 平台</a>获取 API 凭据'
    ],
    ['credential.mem0MemoryApi.root.label@ca9dd5287612', 'Mem0 Memory API'],
    ['credential.mem0MemoryApi.root/inputs/apiKey.description@aaa691e58c13', '来自 Mem0 控制台的 API 密钥'],
    ['credential.mem0MemoryApi.root/inputs/apiKey.label@23189d55f697', 'API 密钥'],
    [
        'credential.microsoftOutlookOAuth2.root.description@b7acaa0ba220',
        '可在<a target="_blank" href="https://docs.flowiseai.com/integrations/langchain/tools/microsoft-outlook">此处</a>查看配置说明'
    ],
    ['credential.microsoftOutlookOAuth2.root.label@a0ff70d73220', 'Microsoft Outlook OAuth2'],
    ['credential.microsoftOutlookOAuth2.root/inputs/accessTokenUrl.label@a2c8a2ad63d4', 'Access Token 获取 URL'],
    ['credential.microsoftOutlookOAuth2.root/inputs/authorizationUrl.label@c70b5f2b670e', '授权 URL'],
    ['credential.microsoftOutlookOAuth2.root/inputs/clientId.label@8726db013948', '客户端 ID'],
    ['credential.microsoftOutlookOAuth2.root/inputs/clientSecret.label@ae21cf6d24b8', '客户端密钥'],
    ['credential.microsoftOutlookOAuth2.root/inputs/scope.label@b073f6c68ef8', '权限范围'],
    [
        'credential.microsoftTeamsOAuth2.root.description@c10df1f3a443',
        '可在<a target="_blank" href="https://docs.flowiseai.com/integrations/langchain/tools/microsoft-teams">此处</a>查看配置说明'
    ],
    ['credential.microsoftTeamsOAuth2.root.label@b8d11e568d62', 'Microsoft Teams OAuth2'],
    ['credential.microsoftTeamsOAuth2.root/inputs/accessTokenUrl.label@a2c8a2ad63d4', 'Access Token 获取 URL'],
    ['credential.microsoftTeamsOAuth2.root/inputs/authorizationUrl.label@c70b5f2b670e', '授权 URL'],
    ['credential.microsoftTeamsOAuth2.root/inputs/clientId.label@8726db013948', '客户端 ID'],
    ['credential.microsoftTeamsOAuth2.root/inputs/clientSecret.label@ae21cf6d24b8', '客户端密钥'],
    ['credential.microsoftTeamsOAuth2.root/inputs/scope.label@b073f6c68ef8', '权限范围'],
    [
        'credential.milvusAuth.root.description@9994a0bfdf17',
        '可从<a target="_blank" href="https://milvus.io/docs/authenticate.md#Authenticate-User-Access">此页面</a>了解 Milvus 认证配置。'
    ],
    ['credential.milvusAuth.root.label@e97912742012', 'Milvus 认证'],
    ['credential.milvusAuth.root/inputs/milvusPassword.label@d4081d05b32c', 'Milvus 密码'],
    ['credential.milvusAuth.root/inputs/milvusUser.label@21e447eafd9c', 'Milvus 用户'],
    [
        'credential.mistralAIApi.root.description@b486e65abce7',
        '可从官方<a target="_blank" href="https://console.mistral.ai/">控制台</a>获取 API 密钥。'
    ],
    ['credential.mistralAIApi.root.label@33e36683f35a', 'MistralAI API'],
    ['credential.mistralAIApi.root/inputs/mistralAIAPIKey.label@5b87d1f48e03', 'MistralAI API 密钥'],
    [
        'credential.momentoCacheApi.root.description@2a4e7bf15bbe',
        '有关如何在 Momento 获取 API 密钥，请参阅<a target="_blank" href="https://docs.momentohq.com/cache/develop/authentication/api-keys">官方指南</a>。'
    ],
    ['credential.momentoCacheApi.root.label@ba71cd34a8c6', 'Momento Cache API'],
    ['credential.momentoCacheApi.root/inputs/momentoApiKey.label@23189d55f697', 'API 密钥'],
    ['credential.momentoCacheApi.root/inputs/momentoCache.label@a76ce82a9749', '缓存'],
    ['credential.momentoCacheApi.root/inputs/momentoEndpoint.label@3df9726c68ba', '端点'],
    ['credential.mongoDBUrlApi.root.label@fec19d2ca075', 'MongoDB ATLAS'],
    ['credential.mongoDBUrlApi.root/inputs/mongoDBConnectUrl.label@6d7e01de2881', 'ATLAS 连接 URL'],
    [
        'credential.mongoDBUrlApi.root/inputs/mongoDBConnectUrl.placeholder@e6875d7f9e29',
        'mongodb+srv://<user>:<pwd>@cluster0.example.mongodb.net/?retryWrites=true&w=majority'
    ],
    ['credential.MySQLApi.root.label@b56597bdfe4a', 'MySQL API'],
    ['credential.MySQLApi.root/inputs/password.label@e7cf3ef4f17c', '密码'],
    ['credential.MySQLApi.root/inputs/password.placeholder@a8d65fe11fb1', '<MYSQL_PASSWORD>'],
    ['credential.MySQLApi.root/inputs/user.label@b512d97e7cbf', '用户'],
    ['credential.MySQLApi.root/inputs/user.placeholder@d3d0833b8393', '<MYSQL_USERNAME>'],
    [
        'credential.neo4jApi.root.description@7b588499c6a4',
        '有关 Neo4j 认证，请参阅<a target="_blank" href="https://neo4j.com/docs/operations-manual/current/authentication-authorization/">官方指南</a>。'
    ],
    ['credential.neo4jApi.root.label@f708d76ae922', 'Neo4j API'],
    ['credential.neo4jApi.root/inputs/password.description@b1f7ee793520', 'Neo4j 数据库密码'],
    ['credential.neo4jApi.root/inputs/password.label@e7cf3ef4f17c', '密码'],
    ['credential.neo4jApi.root/inputs/url.description@684b4fa03d17', 'Neo4j 实例 URL（例如 neo4j://localhost:7687）'],
    ['credential.neo4jApi.root/inputs/url.label@345dc3dc182c', 'Neo4j URL'],
    ['credential.neo4jApi.root/inputs/username.description@e120f9509b72', 'Neo4j 数据库用户名'],
    ['credential.neo4jApi.root/inputs/username.label@e3b89e9d33f8', '用户名'],
    [
        'credential.notionApi.root.description@fb970d3f4d0d',
        '可在<a target="_blank" href="https://developers.notion.com/docs/create-a-notion-integration#step-1-create-an-integration">此处</a>获取集成 Token'
    ],
    ['credential.notionApi.root.label@c23325576858', 'Notion API'],
    ['credential.notionApi.root/inputs/notionIntegrationToken.label@c44a752686de', 'Notion 集成 Token'],
    ['credential.nvidiaNIMApi.root.label@929643cac25d', 'NVIDIA NGC API 密钥'],
    ['credential.nvidiaNIMApi.root/inputs/nvidiaNIMApiKey.label@929643cac25d', 'NVIDIA NGC API 密钥'],
    ['credential.ollamaApi.root.label@a13cff474653', 'Ollama API'],
    ['credential.ollamaApi.root/inputs/ollamaApiKey.label@daea598cf135', 'Ollama API 密钥'],
    ['credential.openAIApi.root.label@c9b1ce47b2aa', 'OpenAI API'],
    ['credential.openAIApi.root/inputs/openAIApiKey.label@38fd98ec7a46', 'OpenAI API 密钥'],
    ['credential.openRouterApi.root.label@36e049742910', 'OpenRouter API 密钥'],
    ['credential.openRouterApi.root/inputs/openRouterApiKey.description@23189d55f697', 'API 密钥'],
    ['credential.openRouterApi.root/inputs/openRouterApiKey.label@36e049742910', 'OpenRouter API 密钥'],
    ['credential.openSearchUrl.root.label@9744fcceaafb', 'OpenSearch'],
    ['credential.openSearchUrl.root/inputs/openSearchUrl.label@f019dcb9a56e', 'OpenSearch URL'],
    ['credential.openSearchUrl.root/inputs/password.label@e7cf3ef4f17c', '密码'],
    ['credential.openSearchUrl.root/inputs/password.placeholder@76e2cb9cbb2e', '<OPENSEARCH_PASSWORD>'],
    ['credential.openSearchUrl.root/inputs/user.label@b512d97e7cbf', '用户'],
    ['credential.openSearchUrl.root/inputs/user.placeholder@7e4410aaba58', '<OPENSEARCH_USERNAME>'],
    [
        'credential.opikApi.root.description@a8c8ea997b52',
        '有关如何配置 Opik 凭据，请参阅<a target="_blank" href="https://www.comet.com/docs/opik/tracing/sdk_configuration">Opik 文档</a>。'
    ],
    ['credential.opikApi.root.label@0766a840777c', 'Opik API'],
    ['credential.opikApi.root/inputs/opikApiKey.label@23189d55f697', 'API 密钥'],
    ['credential.opikApi.root/inputs/opikApiKey.placeholder@6ce5a3a71a29', '<OPIK_API_KEY>'],
    ['credential.opikApi.root/inputs/opikUrl.label@e7a241debad5', 'URL'],
    ['credential.opikApi.root/inputs/opikUrl.placeholder@9e8cac45dddd', 'https://www.comet.com/opik/api'],
    ['credential.opikApi.root/inputs/opikWorkspace.label@87bb59ba2f92', '工作区'],
    ['credential.opikApi.root/inputs/opikWorkspace.placeholder@37a8eec1ce19', 'default'],
    ['credential.oxylabsApi.root.description@1cd52d36862d', 'Oxylabs API 凭据说明，后续可补充更多信息'],
    ['credential.oxylabsApi.root.label@3c279329c3c0', 'Oxylabs API'],
    ['credential.oxylabsApi.root/inputs/password.label@54b1a8a25aef', 'Oxylabs 密码'],
    ['credential.oxylabsApi.root/inputs/username.label@6992fc8167ec', 'Oxylabs 用户名']
]
