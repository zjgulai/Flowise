import { ZH_CN_BADGES, ZH_CN_CATEGORIES } from './zhCNCategories'
import { ZH_CN_DYNAMIC_POLICIES } from './zhCNDynamicPolicies'
import { ZH_CN_AGENTFLOW_A } from './zhCNAgentflowA'
import { ZH_CN_AGENTFLOW_B } from './zhCNAgentflowB'
import { ZH_CN_AGENTFLOW_C } from './zhCNAgentflowC'
import { ZH_CN_CREDENTIALS_A } from './zhCNCredentialsA'
import { ZH_CN_CREDENTIALS_B } from './zhCNCredentialsB'
import { ZH_CN_CREDENTIALS_C } from './zhCNCredentialsC'
import { ZH_CN_DYNAMIC_DESCRIPTIONS } from './zhCNDynamicDescriptions'
import { ZH_CN_NODE_SOURCES_A } from './zhCNNodeSourcesA'
import { ZH_CN_NODE_SOURCES_B } from './zhCNNodeSourcesB'
import { ZH_CN_NODE_SOURCES_C } from './zhCNNodeSourcesC'
import { ZH_CN_NODE_SOURCES_D } from './zhCNNodeSourcesD'
import { ZH_CN_NODE_SOURCES_E } from './zhCNNodeSourcesE'
import { ZH_CN_NODE_SOURCES_F } from './zhCNNodeSourcesF'
import { ZH_CN_NODE_OVERRIDES } from './zhCNNodeOverrides'
import { ZH_CN_NODE_VALUE_OPTIONS } from './zhCNNodeValueOptions'

export const ZH_CN_METADATA_TRANSLATIONS: ReadonlyMap<string, string> = new Map([
    ...ZH_CN_AGENTFLOW_A,
    ...ZH_CN_AGENTFLOW_B,
    ...ZH_CN_AGENTFLOW_C,
    ...ZH_CN_CREDENTIALS_A,
    ...ZH_CN_CREDENTIALS_B,
    ...ZH_CN_CREDENTIALS_C,
    ...ZH_CN_NODE_OVERRIDES
])

/** Source-hash fallbacks preserve raw machine values while reusing display text across nodes. */
export const ZH_CN_METADATA_SOURCE_TRANSLATIONS: ReadonlyMap<string, string> = new Map([
    ...ZH_CN_NODE_SOURCES_A,
    ...ZH_CN_NODE_SOURCES_B,
    ...ZH_CN_NODE_SOURCES_C,
    ...ZH_CN_NODE_SOURCES_D,
    ...ZH_CN_NODE_SOURCES_E,
    ...ZH_CN_NODE_SOURCES_F,
    ...ZH_CN_NODE_VALUE_OPTIONS,
    ...ZH_CN_DYNAMIC_DESCRIPTIONS
])

export { ZH_CN_BADGES, ZH_CN_CATEGORIES, ZH_CN_DYNAMIC_POLICIES }
export type { DynamicMetadataPolicy } from './zhCNDynamicPolicies'
