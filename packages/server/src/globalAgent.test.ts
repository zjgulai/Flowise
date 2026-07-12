import { spawnSync } from 'child_process'
import path from 'path'

describe('global HTTP proxy bootstrap', () => {
    it('preserves an explicit DNS-pinning agent', () => {
        const bootstrapModule = path.join(__dirname, 'globalAgent.ts')
        const script = `
            const http = require('http')
            const fixture = http.createServer((_request, response) => response.end('pinned-agent-ok'))
            const finish = (code) => fixture.close(() => process.exit(code))
            const timer = setTimeout(() => finish(2), 5000)

            fixture.listen(0, '127.0.0.1', () => {
                require(${JSON.stringify(bootstrapModule)})
                const address = fixture.address()
                const agent = new http.Agent({
                    lookup: (_hostname, options, callback) => {
                        if (options && options.all) {
                            callback(null, [{ address: '127.0.0.1', family: 4 }])
                        } else {
                            callback(null, '127.0.0.1', 4)
                        }
                    }
                })
                const request = http.get(
                    { hostname: 'dns-pin.invalid', port: address.port, path: '/', agent },
                    (response) => {
                        let body = ''
                        response.setEncoding('utf8')
                        response.on('data', (chunk) => (body += chunk))
                        response.on('end', () => {
                            clearTimeout(timer)
                            process.stdout.write(body)
                            finish(body === 'pinned-agent-ok' ? 0 : 3)
                        })
                    }
                )
                request.on('error', (error) => {
                    clearTimeout(timer)
                    process.stderr.write(error.message)
                    finish(4)
                })
            })
        `
        const childEnv = { ...process.env }
        delete childEnv.GLOBAL_AGENT_FORCE_GLOBAL_AGENT
        delete childEnv.GLOBAL_AGENT_HTTP_PROXY
        delete childEnv.GLOBAL_AGENT_HTTPS_PROXY
        delete childEnv.GLOBAL_AGENT_NO_PROXY

        const result = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script], {
            cwd: path.join(__dirname, '..'),
            encoding: 'utf8',
            env: childEnv,
            timeout: 10_000
        })

        expect(result.status).toBe(0)
        expect(result.stdout).toBe('pinned-agent-ok')
    })
})
