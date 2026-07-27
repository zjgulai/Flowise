import { bootstrap } from 'global-agent'

// Preserve explicit Agents such as the DNS-pinned transport used by secureFetch.
bootstrap({ forceGlobalAgent: false })
