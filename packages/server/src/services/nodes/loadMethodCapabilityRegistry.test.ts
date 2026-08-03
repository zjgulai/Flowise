import fs from 'fs'
import path from 'path'
import { ZH_CN_DYNAMIC_POLICIES } from '../component-metadata-localization/catalog/zhCNDynamicPolicies'

const collectFiles = (directory: string): string[] =>
    fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const resolved = path.join(directory, entry.name)
        return entry.isDirectory() ? collectFiles(resolved) : [resolved]
    })

describe('node load capability registry matches the built component runtime', () => {
    it('covers every known method and matches each exact runtime node category and method', () => {
        const serviceSource = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8')
        const denySource = serviceSource.slice(
            serviceSource.indexOf('export const NODE_LOAD_DENY_CAPABILITIES'),
            serviceSource.indexOf('export const INTENTIONALLY_DENIED_NODE_LOAD_CAPABILITIES')
        )
        const allowSource = serviceSource.slice(
            serviceSource.indexOf('export const NODE_LOAD_CAPABILITIES'),
            serviceSource.indexOf('const hasAnyPermission')
        )
        const capabilityEntries = Object.fromEntries(
            [
                ...denySource.matchAll(/^\s*'([^']+)'\s*:\s*\{\s*category:\s*'([^']+)'/gm),
                ...allowSource.matchAll(/^\s*'([^']+)'\s*:\s*\{\s*category:\s*'([^']+)'/gm)
            ].map((match) => [match[1], { category: match[2] }])
        )
        expect(Object.keys(capabilityEntries).sort()).toEqual(Object.keys(ZH_CN_DYNAMIC_POLICIES).sort())

        const targetNodeNames = new Set(Object.keys(capabilityEntries).map((key) => key.slice(0, key.lastIndexOf('.'))))
        const runtimeNodes: Record<string, any> = {}
        const componentNodesDirectory = path.resolve(__dirname, '../../../../components/dist/nodes')

        for (const filePath of collectFiles(componentNodesDirectory)) {
            if (!filePath.endsWith('.js')) continue
            try {
                const nodeModule = require(filePath)
                if (!nodeModule.nodeClass) continue
                const nodeInstance = new nodeModule.nodeClass()
                if (targetNodeNames.has(nodeInstance.name)) runtimeNodes[nodeInstance.name] = nodeInstance
            } catch {
                // A target that cannot be loaded remains absent and fails explicitly below.
            }
        }

        const failures: string[] = []
        for (const [capabilityKey, capability] of Object.entries(capabilityEntries)) {
            const separator = capabilityKey.lastIndexOf('.')
            const nodeName = capabilityKey.slice(0, separator)
            const methodName = capabilityKey.slice(separator + 1)
            const nodeInstance = runtimeNodes[nodeName]
            if (!nodeInstance) {
                failures.push(`${capabilityKey}: missing runtime node`)
                continue
            }
            if (nodeInstance.category !== capability.category) {
                failures.push(`${capabilityKey}: expected ${capability.category}, received ${String(nodeInstance.category)}`)
            }
            if (!nodeInstance.loadMethods || typeof nodeInstance.loadMethods[methodName] !== 'function') {
                failures.push(`${capabilityKey}: missing runtime load method`)
            }
        }

        expect(failures).toEqual([])
    })
})
