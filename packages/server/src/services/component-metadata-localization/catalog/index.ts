import { ZH_CN_BADGES, ZH_CN_CATEGORIES } from './zhCNCategories'
import { ZH_CN_DYNAMIC_POLICIES } from './zhCNDynamicPolicies'
import { ZH_CN_AGENTFLOW_A } from './zhCNAgentflowA'
import { ZH_CN_AGENTFLOW_B } from './zhCNAgentflowB'
import { ZH_CN_AGENTFLOW_C } from './zhCNAgentflowC'
import { ZH_CN_CREDENTIALS_A } from './zhCNCredentialsA'
import { ZH_CN_CREDENTIALS_B } from './zhCNCredentialsB'
import { ZH_CN_CREDENTIALS_C } from './zhCNCredentialsC'

export const ZH_CN_METADATA_TRANSLATIONS: ReadonlyMap<string, string> = new Map([
    ...ZH_CN_AGENTFLOW_A,
    ...ZH_CN_AGENTFLOW_B,
    ...ZH_CN_AGENTFLOW_C,
    ...ZH_CN_CREDENTIALS_A,
    ...ZH_CN_CREDENTIALS_B,
    ...ZH_CN_CREDENTIALS_C
])

export { ZH_CN_BADGES, ZH_CN_CATEGORIES, ZH_CN_DYNAMIC_POLICIES }
export type { DynamicMetadataPolicy } from './zhCNDynamicPolicies'
