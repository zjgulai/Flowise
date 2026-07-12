declare module 'global-agent' {
    export interface GlobalAgentBootstrapConfiguration {
        forceGlobalAgent?: boolean
    }

    export function bootstrap(configuration?: GlobalAgentBootstrapConfiguration): boolean
}
