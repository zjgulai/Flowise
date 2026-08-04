export const ZH_CN_CREDENTIALS_A: ReadonlyArray<readonly [string, string]> = [
    ['credential.agentflowApi.root.label@60f8ede9dc00', 'Agentflow API'],
    ['credential.agentflowApi.root/inputs/agentflowApiKey.label@7aba2ed3b494', 'Agentflow API 密钥'],
    [
        'credential.airtableApi.root.description@37bf38a2973a',
        '请参阅<a target="_blank" href="https://support.airtable.com/docs/creating-and-using-api-keys-and-access-tokens">官方指南</a>，了解如何在 Airtable 获取访问 Token'
    ],
    ['credential.airtableApi.root.label@999d7025cc93', 'Airtable API'],
    ['credential.airtableApi.root/inputs/accessToken.label@f9db72ced1ee', '访问 Token'],
    ['credential.airtableApi.root/inputs/accessToken.placeholder@b4a92173c496', '<AIRTABLE_ACCESS_TOKEN>'],
    ['credential.AlibabaApi.root.label@c4938c91cfa1', 'Alibaba API'],
    ['credential.AlibabaApi.root/inputs/alibabaApiKey.label@b72c9949c106', 'Alibaba API 密钥'],
    ['credential.anthropicApi.root.label@30a3a7863f78', 'Anthropic API'],
    ['credential.anthropicApi.root/inputs/anthropicApiKey.label@50ace46bebf7', 'Anthropic API 密钥'],
    [
        'credential.apifyApi.root.description@ab793c52c89a',
        '您可以在 <a target="_blank" href="https://console.apify.com/account#/integrations">Apify 账户</a>页面找到 Apify API Token。'
    ],
    ['credential.apifyApi.root.label@6e5c1ff0f840', 'Apify API'],
    ['credential.apifyApi.root/inputs/apifyApiToken.label@6e5c1ff0f840', 'Apify API'],
    [
        'credential.arizeApi.root.description@c2db600c9e27',
        '请参阅<a target="_blank" href="https://docs.arize.com/arize">官方指南</a>，了解如何获取 Arize API 密钥。'
    ],
    ['credential.arizeApi.root.label@843bc8deea93', 'Arize API'],
    ['credential.arizeApi.root/inputs/arizeApiKey.label@23189d55f697', 'API 密钥'],
    ['credential.arizeApi.root/inputs/arizeApiKey.placeholder@a245c6523f5a', '<ARIZE_API_KEY>'],
    ['credential.arizeApi.root/inputs/arizeEndpoint.label@3df9726c68ba', '端点'],
    ['credential.arizeApi.root/inputs/arizeSpaceId.label@e36720e04c07', '空间 ID'],
    ['credential.arizeApi.root/inputs/arizeSpaceId.placeholder@98d53b24021c', '<ARIZE_SPACE_ID>'],
    ['credential.assemblyAIApi.root.label@9e787438ae70', 'AssemblyAI API'],
    ['credential.assemblyAIApi.root/inputs/assemblyAIApiKey.label@3c2f12853251', 'AssemblyAI API 密钥'],
    ['credential.AstraDBApi.root.label@d396d2ead3cf', 'Astra DB API'],
    ['credential.AstraDBApi.root/inputs/applicationToken.label@9d048d03c9ac', 'Astra DB 应用 Token'],
    ['credential.AstraDBApi.root/inputs/dbEndPoint.label@1cecdae631ca', 'Astra DB API 端点'],
    [
        'credential.awsApi.root.description@122894df64ab',
        '您的 <a target="_blank" href="https://docs.aws.amazon.com/IAM/latest/UserGuide/security-creds.html">AWS 安全凭据</a>。未指定时，将按照 AWS SDK 的默认行为从运行时环境读取凭据。'
    ],
    ['credential.awsApi.root.label@213ce85aac67', 'AWS 安全凭据'],
    ['credential.awsApi.root/inputs/awsKey.description@646637aa5601', 'AWS 账户的访问密钥。'],
    ['credential.awsApi.root/inputs/awsKey.label@3018ec1dc2ca', 'AWS 访问密钥'],
    ['credential.awsApi.root/inputs/awsKey.placeholder@c21751ae6bfd', '<AWS_ACCESS_KEY_ID>'],
    ['credential.awsApi.root/inputs/awsSecret.description@389a4510ff7d', 'AWS 账户的私密密钥。'],
    ['credential.awsApi.root/inputs/awsSecret.label@17348d774f15', 'AWS 私密访问密钥'],
    ['credential.awsApi.root/inputs/awsSecret.placeholder@5d7b65437721', '<AWS_SECRET_ACCESS_KEY>'],
    ['credential.awsApi.root/inputs/awsSession.description@66d393e195a6', 'AWS 账户的会话密钥。仅在使用临时凭据时需要填写。'],
    ['credential.awsApi.root/inputs/awsSession.label@04d4a31e5077', 'AWS 会话密钥'],
    ['credential.awsApi.root/inputs/awsSession.placeholder@2d1407d76a9c', '<AWS_SESSION_TOKEN>'],
    [
        'credential.awsApi.root/inputs/externalId.description@d04dfe531d88',
        '用于跨账户角色代入的唯一标识符。当角色信任策略包含 sts:ExternalId 条件时，此项为必填。'
    ],
    ['credential.awsApi.root/inputs/externalId.label@69da56ba6fca', '外部 ID'],
    ['credential.awsApi.root/inputs/externalId.placeholder@2cd0dbbe0d73', 'unique-external-id'],
    [
        'credential.awsApi.root/inputs/roleArn.description@4728fb4f8f16',
        '要代入的 IAM 角色的 Amazon 资源名称（ARN）。填写后，Flowise 将使用 AWS STS AssumeRole 获取临时凭据；留空则直接使用静态凭据。'
    ],
    ['credential.awsApi.root/inputs/roleArn.label@6cbb6f1d7347', '角色 ARN'],
    ['credential.awsApi.root/inputs/roleArn.placeholder@ea9633b0aedb', 'arn:aws:iam::123456789012:role/role-name'],
    ['credential.azureCognitiveServices.root.label@be80b60baf57', 'Azure Cognitive Services'],
    ['credential.azureCognitiveServices.root/inputs/apiVersion.description@6e2023342152', '要使用的 API 版本（例如“2024-05-15-preview”）'],
    ['credential.azureCognitiveServices.root/inputs/apiVersion.label@960a4c077af3', 'API 版本'],
    ['credential.azureCognitiveServices.root/inputs/apiVersion.placeholder@bed047371b37', '2024-05-15-preview'],
    [
        'credential.azureCognitiveServices.root/inputs/azureSubscriptionKey.description@2e5538781b14',
        '您的 Azure Cognitive Services 订阅密钥'
    ],
    ['credential.azureCognitiveServices.root/inputs/azureSubscriptionKey.label@41dc31726a6a', 'Azure 订阅密钥'],
    ['credential.azureCognitiveServices.root/inputs/serviceRegion.description@b3cf5e1b70ef', 'Azure 服务区域（例如“westus”“eastus”）'],
    ['credential.azureCognitiveServices.root/inputs/serviceRegion.label@58889a94df34', '服务区域'],
    ['credential.azureCognitiveServices.root/inputs/serviceRegion.placeholder@13a8a859c05e', 'westus'],
    [
        'credential.azureFoundryApi.root.description@ad764e6f0189',
        '有关设置说明，请参阅 <a target="_blank" href="https://docs.microsoft.com/en-us/azure/ai-foundry/">Azure AI Foundry 文档</a>'
    ],
    ['credential.azureFoundryApi.root.label@7fdcc3468088', 'Azure Foundry API'],
    ['credential.azureFoundryApi.root/inputs/azureFoundryApiKey.description@ca41018da1f8', '您的 Azure AI Foundry API 密钥'],
    ['credential.azureFoundryApi.root/inputs/azureFoundryApiKey.label@0ea8858fc646', 'Azure Foundry API 密钥'],
    ['credential.azureFoundryApi.root/inputs/azureFoundryEndpoint.description@fbe457b9e0f6', '您的 Azure AI Foundry 端点 URL'],
    ['credential.azureFoundryApi.root/inputs/azureFoundryEndpoint.label@0bf22cac45ca', 'Azure Foundry 端点'],
    [
        'credential.azureFoundryApi.root/inputs/azureFoundryEndpoint.placeholder@ef27bfa97143',
        'https://your-foundry-instance.services.ai.azure.com/providers/cohere/v2/rerank'
    ],
    [
        'credential.azureOpenAIApi.root.description@17abacb0fcaf',
        '请参阅<a target="_blank" href="https://azure.microsoft.com/en-us/products/cognitive-services/openai-service">官方指南</a>，了解如何使用 Azure OpenAI 服务'
    ],
    ['credential.azureOpenAIApi.root.label@cbfb7d5170b5', 'Azure OpenAI API'],
    ['credential.azureOpenAIApi.root/inputs/azureOpenAIApiDeploymentName.label@7dd6d17609d4', 'Azure OpenAI API 部署名称'],
    ['credential.azureOpenAIApi.root/inputs/azureOpenAIApiDeploymentName.placeholder@8a326fcf7039', 'YOUR-DEPLOYMENT-NAME'],
    ['credential.azureOpenAIApi.root/inputs/azureOpenAIApiInstanceName.label@4264c27dc918', 'Azure OpenAI API 实例名称'],
    ['credential.azureOpenAIApi.root/inputs/azureOpenAIApiInstanceName.placeholder@e3a6c6094b93', 'YOUR-INSTANCE-NAME'],
    [
        'credential.azureOpenAIApi.root/inputs/azureOpenAIApiKey.description@ea4e13bc8938',
        '请参阅<a target="_blank" href="https://learn.microsoft.com/en-us/azure/cognitive-services/openai/quickstart?tabs=command-line&pivots=rest-api#set-up">官方指南</a>，了解如何在 Azure OpenAI 创建 API 密钥'
    ],
    ['credential.azureOpenAIApi.root/inputs/azureOpenAIApiKey.label@b71b7e57d065', 'Azure OpenAI API 密钥'],
    [
        'credential.azureOpenAIApi.root/inputs/azureOpenAIApiVersion.description@6df325c5b2d1',
        '有关支持的 API 版本说明，请参阅 <a target="_blank" href="https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-version-lifecycle">API 版本生命周期</a>'
    ],
    ['credential.azureOpenAIApi.root/inputs/azureOpenAIApiVersion.label@22934c5bc210', 'Azure OpenAI API 版本'],
    ['credential.azureOpenAIApi.root/inputs/azureOpenAIApiVersion.placeholder@8a155a1f957b', '2024-10-21'],
    ['credential.baiduQianfanApi.root.label@5350bdcbd556', '百度千帆 API'],
    ['credential.baiduQianfanApi.root/inputs/qianfanAccessKey.label@88a3560e3d97', '千帆访问密钥'],
    ['credential.baiduQianfanApi.root/inputs/qianfanSecretKey.label@06602a567902', '千帆私密密钥'],
    ['credential.braveSearchApi.root.label@dd08fad66d5d', 'Brave Search API'],
    ['credential.braveSearchApi.root/inputs/braveApiKey.label@40e428070380', 'Brave Search API 密钥'],
    [
        'credential.browserlessApi.root.description@7d06c61e0f91',
        '请参阅<a target="_blank" href="https://docs.browserless.io/mcp/browserless-mcp-server">官方指南</a>，了解如何从 Browserless 控制台获取 API Token'
    ],
    ['credential.browserlessApi.root.label@42481db29731', 'Browserless API'],
    ['credential.browserlessApi.root/inputs/browserlessApiToken.label@c85b0e36e937', 'API Token'],
    ['credential.browserlessApi.root/inputs/browserlessApiToken.placeholder@ab1288b0b9d3', '<BROWSERLESS_API_TOKEN>'],
    ['credential.cerebrasAIApi.root.description@718fd0d1369e', '从 Cerebras Cloud 获取免费的 API 密钥'],
    ['credential.cerebrasAIApi.root.label@00b04e41a8ed', 'Cerebras API 密钥'],
    [
        'credential.cerebrasAIApi.root/inputs/cerebrasApiKey.description@04cfa3622222',
        '从 https://cloud.cerebras.ai/ 获取 API 密钥（以 csk- 开头）'
    ],
    ['credential.cerebrasAIApi.root/inputs/cerebrasApiKey.label@00b04e41a8ed', 'Cerebras API 密钥'],
    ['credential.chatflowApi.root.label@d93d988fad22', 'Chatflow API'],
    ['credential.chatflowApi.root/inputs/chatflowApiKey.label@a8940d172d17', 'Chatflow API 密钥'],
    ['credential.chromaApi.root.label@300b826ebc14', 'Chroma API'],
    ['credential.chromaApi.root/inputs/chromaApiKey.label@5710940356e9', 'Chroma API 密钥'],
    ['credential.chromaApi.root/inputs/chromaDatabase.label@41450b5e6a3e', 'Chroma 数据库'],
    ['credential.chromaApi.root/inputs/chromaTenant.label@83f5e3bd56ca', 'Chroma 租户'],
    ['credential.cloudflareApi.root.description@730bbe175624', '使用您的 Cloudflare 账户 ID 和 API Token'],
    ['credential.cloudflareApi.root.label@3997736adfdf', 'Cloudflare API'],
    ['credential.cloudflareApi.root/inputs/cloudflareAccountId.label@210cc0dc0bd0', 'Cloudflare 账户 ID'],
    ['credential.cloudflareApi.root/inputs/cloudflareApiToken.label@26cb9a45dc81', 'Cloudflare API Token'],
    ['credential.cohereApi.root.label@07f29135ff27', 'Cohere API'],
    ['credential.cohereApi.root/inputs/cohereApiKey.label@61842cf4b5b3', 'Cohere API 密钥'],
    ['credential.cometApi.root.label@e2c47be4d72c', 'Comet API'],
    ['credential.cometApi.root/inputs/cometApiKey.label@15b4e7755518', 'Comet API 密钥'],
    ['credential.composioApi.root.label@cb41fad1adcf', 'Composio API'],
    ['credential.composioApi.root/inputs/composioApi.label@9ab35c1e5d16', 'Composio API 密钥'],
    [
        'credential.confluenceCloudApi.root.description@5989d201db7d',
        '请参阅<a target="_blank" href="https://support.atlassian.com/confluence-cloud/docs/manage-oauth-access-tokens/">官方指南</a>，了解如何在 Confluence 获取访问 Token；也可前往 <a target="_blank" href="https://id.atlassian.com/manage-profile/security/api-tokens">API Token</a> 页面获取。'
    ],
    ['credential.confluenceCloudApi.root.label@3ba49fc89782', 'Confluence Cloud API'],
    ['credential.confluenceCloudApi.root/inputs/accessToken.label@f9db72ced1ee', '访问 Token'],
    ['credential.confluenceCloudApi.root/inputs/accessToken.placeholder@b7899d127eb0', '<CONFLUENCE_ACCESS_TOKEN>'],
    ['credential.confluenceCloudApi.root/inputs/username.label@e3b89e9d33f8', '用户名'],
    ['credential.confluenceCloudApi.root/inputs/username.placeholder@bbd45db3ed9e', '<CONFLUENCE_USERNAME>'],
    [
        'credential.confluenceServerDCApi.root.description@d7bb9536f6ca',
        '请参阅<a target="_blank" href="https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html/">官方指南</a>，了解如何在 Confluence 获取个人访问 Token</a>'
    ],
    ['credential.confluenceServerDCApi.root.label@f225b4a5db96', 'Confluence Server/Data Center API'],
    ['credential.confluenceServerDCApi.root/inputs/personalAccessToken.label@5572fccccdf4', '个人访问 Token'],
    ['credential.confluenceServerDCApi.root/inputs/personalAccessToken.placeholder@c4127aec90ba', '<CONFLUENCE_PERSONAL_ACCESS_TOKEN>'],
    ['credential.couchbaseApi.root.label@bf7e48d58831', 'Couchbase API'],
    ['credential.couchbaseApi.root/inputs/connectionString.label@585314996494', 'Couchbase 连接字符串'],
    ['credential.couchbaseApi.root/inputs/password.label@c8709a071d38', 'Couchbase 密码'],
    ['credential.couchbaseApi.root/inputs/username.label@b2033e97cb20', 'Couchbase 用户名'],
    ['credential.deepseekApi.root.label@ef8d6fcce550', 'DeepSeek AI API'],
    ['credential.deepseekApi.root/inputs/deepseekApiKey.label@96936981a2ed', 'DeepSeek AI API 密钥'],
    ['credential.dynamodbMemoryApi.root.label@6dc69aaae420', 'DynamoDB Memory API'],
    ['credential.dynamodbMemoryApi.root/inputs/accessKey.label@176f1c109e28', '访问密钥'],
    ['credential.dynamodbMemoryApi.root/inputs/secretAccessKey.label@d2aeacd6dbcf', '私密访问密钥'],
    ['credential.E2BApi.root.label@4ec2768ad43c', 'E2B API'],
    ['credential.E2BApi.root/inputs/e2bApiKey.label@3f881854e0ef', 'E2B API 密钥'],
    [
        'credential.elasticsearchApi.root.description@74864ce7311e',
        '请参阅<a target="_blank" href="https://www.elastic.co/guide/en/kibana/current/api-keys.html">官方指南</a>，了解如何从 Elasticsearch 获取 API 密钥'
    ],
    ['credential.elasticsearchApi.root.label@01fb9c53ed0c', 'Elasticsearch API'],
    ['credential.elasticsearchApi.root/inputs/apiKey.label@aee4eeb5ff7c', 'Elasticsearch API 密钥'],
    ['credential.elasticsearchApi.root/inputs/endpoint.label@45f85af43100', 'Elasticsearch 端点'],
    [
        'credential.elasticSearchUserPassword.root.description@f0899ddb1156',
        '在 Cloud ID 字段中输入您的 Elastic Cloud ID 或 Elastic 服务器实例 URL。请参阅<a target="_blank" href="https://www.elastic.co/guide/en/elasticsearch/reference/current/setting-up-authentication.html">官方指南</a>，了解如何获取 Elasticsearch 用户密码。'
    ],
    ['credential.elasticSearchUserPassword.root.label@c23341809eb5', 'Elasticsearch 用户名和密码'],
    ['credential.elasticSearchUserPassword.root/inputs/cloudId.label@efce58ffdd83', 'Cloud ID'],
    ['credential.elasticSearchUserPassword.root/inputs/password.label@b854b5aded1b', 'Elasticsearch 密码'],
    ['credential.elasticSearchUserPassword.root/inputs/username.label@1038dc022867', 'Elasticsearch 用户名'],
    [
        'credential.elevenLabsApi.root.description@70f1441fb512',
        '注册 ElevenLabs 账户并<a target="_blank" href="https://elevenlabs.io/app/settings/api-keys">创建 API 密钥</a>。'
    ],
    ['credential.elevenLabsApi.root.label@84e6d2594f0c', 'ElevenLabs API'],
    ['credential.elevenLabsApi.root/inputs/elevenLabsApiKey.label@42b35e6cc7c2', 'ElevenLabs API 密钥'],
    [
        'credential.exaSearchApi.root.description@b3215551d281',
        '请参阅<a target="_blank" href="https://docs.exa.ai/reference/getting-started#getting-access">官方指南</a>，了解如何从 Exa 获取 API 密钥'
    ],
    ['credential.exaSearchApi.root.label@dc8d709520fd', 'Exa Search API'],
    ['credential.exaSearchApi.root/inputs/exaSearchApiKey.label@60bc95398487', 'Exa Search API 密钥'],
    [
        'credential.figmaApi.root.description@519cff0edb9b',
        '请参阅<a target="_blank" href="https://www.figma.com/developers/api#access-tokens">官方指南</a>，了解如何在 Figma 获取访问 Token'
    ],
    ['credential.figmaApi.root.label@3b5d6a2a34cd', 'Figma API'],
    ['credential.figmaApi.root/inputs/accessToken.label@f9db72ced1ee', '访问 Token'],
    ['credential.figmaApi.root/inputs/accessToken.placeholder@7a2f985e2ba5', '<FIGMA_ACCESS_TOKEN>'],
    [
        'credential.fireCrawlApi.root.description@25c99d951747',
        '您可以在 <a target="_blank" href="https://www.firecrawl.dev/">FireCrawl 账户</a>页面找到 FireCrawl API Token。'
    ],
    ['credential.fireCrawlApi.root.label@f1585dcad9b8', 'FireCrawl API'],
    ['credential.fireCrawlApi.root/inputs/firecrawlApiToken.label@f1585dcad9b8', 'FireCrawl API'],
    ['credential.fireCrawlApi.root/inputs/firecrawlApiUrl.label@2de8ef0141f0', 'FireCrawl API URL'],
    ['credential.fireworksApi.root.label@616029f454d7', 'Fireworks API'],
    ['credential.fireworksApi.root/inputs/fireworksApiKey.label@907cb03339aa', 'Fireworks API 密钥'],
    [
        'credential.githubApi.root.description@8c84280e14e3',
        '请参阅<a target="_blank" href="https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens">官方指南</a>，了解如何在 GitHub 获取访问 Token'
    ],
    ['credential.githubApi.root.label@93f714a77ddc', 'GitHub API'],
    ['credential.githubApi.root/inputs/accessToken.label@f9db72ced1ee', '访问 Token'],
    ['credential.githubApi.root/inputs/accessToken.placeholder@eaedf36fea7e', '<GITHUB_ACCESS_TOKEN>'],
    [
        'credential.gmailOAuth2.root.description@1c2c1b663c67',
        '您可以在<a target="_blank" href="https://docs.flowiseai.com/integrations/langchain/tools/gmail">此处</a>查看设置说明'
    ],
    ['credential.gmailOAuth2.root.label@800f097842d7', 'Gmail OAuth2'],
    ['credential.gmailOAuth2.root/inputs/accessTokenUrl.label@a2c8a2ad63d4', '访问 Token URL'],
    ['credential.gmailOAuth2.root/inputs/additionalParameters.label@8d4ecad7c7e2', '附加参数'],
    ['credential.gmailOAuth2.root/inputs/authorizationUrl.label@c70b5f2b670e', '授权 URL'],
    ['credential.gmailOAuth2.root/inputs/clientId.label@8726db013948', '客户端 ID'],
    ['credential.gmailOAuth2.root/inputs/clientSecret.label@ae21cf6d24b8', '客户端密钥'],
    ['credential.gmailOAuth2.root/inputs/scope.label@b073f6c68ef8', '授权范围'],
    [
        'credential.googleCalendarOAuth2.root.description@41e72b6747f0',
        '您可以在<a target="_blank" href="https://docs.flowiseai.com/integrations/langchain/tools/google-calendar">此处</a>查看设置说明'
    ],
    ['credential.googleCalendarOAuth2.root.label@490a67d21263', 'Google Calendar OAuth2'],
    ['credential.googleCalendarOAuth2.root/inputs/accessTokenUrl.label@a2c8a2ad63d4', '访问 Token URL'],
    ['credential.googleCalendarOAuth2.root/inputs/additionalParameters.label@8d4ecad7c7e2', '附加参数'],
    ['credential.googleCalendarOAuth2.root/inputs/authorizationUrl.label@c70b5f2b670e', '授权 URL'],
    ['credential.googleCalendarOAuth2.root/inputs/clientId.label@8726db013948', '客户端 ID'],
    ['credential.googleCalendarOAuth2.root/inputs/clientSecret.label@ae21cf6d24b8', '客户端密钥'],
    ['credential.googleCalendarOAuth2.root/inputs/scope.label@b073f6c68ef8', '授权范围'],
    [
        'credential.googleCustomSearchApi.root.description@174358791f06',
        '请参阅 <a target="_blank" href="https://console.cloud.google.com/apis/credentials">Google Cloud Console</a>，了解如何创建 API 密钥；并访问<a target="_blank" href="https://programmablesearchengine.google.com/controlpanel/create">搜索引擎创建页面</a>，了解如何生成搜索引擎 ID。'
    ],
    ['credential.googleCustomSearchApi.root.label@296faacea3d2', 'Google 自定义搜索 API'],
    ['credential.googleCustomSearchApi.root/inputs/googleCustomSearchApiId.label@aa807606bcef', '可编程搜索引擎 ID'],
    ['credential.googleCustomSearchApi.root/inputs/googleCustomSearchApiKey.label@9b473dbb5a60', 'Google 自定义搜索 API 密钥'],
    [
        'credential.googleDocsOAuth2.root.description@43e592b3e1d1',
        '您可以在<a target="_blank" href="https://docs.flowiseai.com/integrations/langchain/tools/google-sheets">此处</a>查看设置说明'
    ],
    ['credential.googleDocsOAuth2.root.label@7b87aa8e14fb', 'Google Docs OAuth2'],
    ['credential.googleDocsOAuth2.root/inputs/accessTokenUrl.label@a2c8a2ad63d4', '访问 Token URL'],
    ['credential.googleDocsOAuth2.root/inputs/additionalParameters.label@8d4ecad7c7e2', '附加参数'],
    ['credential.googleDocsOAuth2.root/inputs/authorizationUrl.label@c70b5f2b670e', '授权 URL'],
    ['credential.googleDocsOAuth2.root/inputs/clientId.label@8726db013948', '客户端 ID'],
    ['credential.googleDocsOAuth2.root/inputs/clientSecret.label@ae21cf6d24b8', '客户端密钥'],
    ['credential.googleDocsOAuth2.root/inputs/scope.label@b073f6c68ef8', '授权范围'],
    [
        'credential.googleDriveOAuth2.root.description@4e93bf4f4f3a',
        '您可以在<a target="_blank" href="https://docs.flowiseai.com/integrations/langchain/tools/google-drive">此处</a>查看设置说明'
    ],
    ['credential.googleDriveOAuth2.root.label@70a69b9f39bf', 'Google Drive OAuth2'],
    ['credential.googleDriveOAuth2.root/inputs/accessTokenUrl.label@a2c8a2ad63d4', '访问 Token URL'],
    ['credential.googleDriveOAuth2.root/inputs/additionalParameters.label@8d4ecad7c7e2', '附加参数'],
    ['credential.googleDriveOAuth2.root/inputs/authorizationUrl.label@c70b5f2b670e', '授权 URL'],
    ['credential.googleDriveOAuth2.root/inputs/clientId.label@8726db013948', '客户端 ID'],
    ['credential.googleDriveOAuth2.root/inputs/clientSecret.label@ae21cf6d24b8', '客户端密钥'],
    ['credential.googleDriveOAuth2.root/inputs/scope.label@b073f6c68ef8', '授权范围'],
    [
        'credential.googleGenerativeAI.root.description@b6ead460b27f',
        '您可以从官方<a target="_blank" href="https://ai.google.dev/tutorials/setup">页面</a>获取 API 密钥。'
    ],
    ['credential.googleGenerativeAI.root.label@d2b7b3e4a144', 'Google Generative AI'],
    ['credential.googleGenerativeAI.root/inputs/googleGenerativeAPIKey.label@7416d2cdfda9', 'Google AI API 密钥'],
    [
        'credential.googleMakerSuite.root.description@97abee387f3a',
        '请使用 <a target="_blank" href="https://makersuite.google.com/app/apikey">Google MakerSuite API 凭据网站</a>获取此密钥。'
    ],
    ['credential.googleMakerSuite.root.label@20468bc66ffb', 'Google MakerSuite'],
    ['credential.googleMakerSuite.root/inputs/googleMakerSuiteKey.label@069f724a50ad', 'MakerSuite API 密钥'],
    [
        'credential.googleSheetsOAuth2.root.description@43e592b3e1d1',
        '您可以在<a target="_blank" href="https://docs.flowiseai.com/integrations/langchain/tools/google-sheets">此处</a>查看设置说明'
    ],
    ['credential.googleSheetsOAuth2.root.label@25bd360d66b5', 'Google Sheets OAuth2'],
    ['credential.googleSheetsOAuth2.root/inputs/accessTokenUrl.label@a2c8a2ad63d4', '访问 Token URL'],
    ['credential.googleSheetsOAuth2.root/inputs/additionalParameters.label@8d4ecad7c7e2', '附加参数'],
    ['credential.googleSheetsOAuth2.root/inputs/authorizationUrl.label@c70b5f2b670e', '授权 URL'],
    ['credential.googleSheetsOAuth2.root/inputs/clientId.label@8726db013948', '客户端 ID'],
    ['credential.googleSheetsOAuth2.root/inputs/clientSecret.label@ae21cf6d24b8', '客户端密钥'],
    ['credential.googleSheetsOAuth2.root/inputs/scope.label@b073f6c68ef8', '授权范围'],
    ['credential.googleVertexAuth.root.label@3a54ff0dbe4b', 'Google Vertex 身份验证'],
    [
        'credential.googleVertexAuth.root/inputs/googleApplicationCredential.description@70147c02f92c',
        'Google 应用凭据的 JSON 对象。也可以改用文件路径（二选一）'
    ],
    ['credential.googleVertexAuth.root/inputs/googleApplicationCredential.label@a04faedc93f7', 'Google 凭据 JSON 对象'],
    [
        'credential.googleVertexAuth.root/inputs/googleApplicationCredential.placeholder@f88e9f90db3f',
        `{
    "type": ...,
    "project_id": ...,
    "private_key_id": ...,
    "private_key": ...,
    "client_email": ...,
    "client_id": ...,
    "auth_uri": ...,
    "token_uri": ...,
    "auth_provider_x509_cert_url": ...,
    "client_x509_cert_url": ...
}`
    ],
    [
        'credential.googleVertexAuth.root/inputs/googleApplicationCredentialFilePath.description@585a02d70b80',
        'Google 应用凭据 JSON 文件的路径。也可以改用凭据 JSON 对象（二选一）'
    ],
    ['credential.googleVertexAuth.root/inputs/googleApplicationCredentialFilePath.label@f429890d5f08', 'Google 应用凭据文件路径'],
    [
        'credential.googleVertexAuth.root/inputs/googleApplicationCredentialFilePath.placeholder@321667d02cd5',
        'your-path/application_default_credentials.json'
    ],
    ['credential.googleVertexAuth.root/inputs/projectID.description@a36a2e48d3ef', 'GCP 项目 ID。未填写时，将从凭据文件中读取'],
    ['credential.googleVertexAuth.root/inputs/projectID.label@e511470b21a9', '项目 ID'],
    ['credential.groqApi.root.label@8d1400e81e25', 'Groq API'],
    ['credential.groqApi.root/inputs/groqApiKey.label@87119f93b8ec', 'Groq API 密钥']
]
