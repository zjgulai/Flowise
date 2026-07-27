import dns from 'dns/promises'
import { EventEmitter } from 'events'
import http from 'http'
import net from 'net'
import { checkDenyList, secureFetch } from '../../src/httpSecurity'
import {
    assertWebScraperUrlAllowed,
    resolvePinnedBrowserTarget,
    WEB_SCRAPER_POLICY_ERROR_CODE,
    WEB_SCRAPER_SECURE_FETCH_POLICY,
    WebScraperOperationTracker,
    WebScraperPolicyError
} from './webScraperSecurity'

jest.mock('./webScraperSecurity', () => {
    const actual = jest.requireActual('./webScraperSecurity')
    const proxyState = { denyOnClose: false }
    return {
        ...actual,
        __proxyState: proxyState,
        startPinnedBrowserProxy: jest.fn(async (guard: { record: (error: unknown) => void }) => ({
            server: 'http://127.0.0.1:43123',
            close: jest.fn(async () => {
                if (proxyState.denyOnClose) guard.record(new Error('late proxy policy denial'))
            })
        }))
    }
})

jest.mock('dns/promises', () => ({
    __esModule: true,
    default: { lookup: jest.fn() }
}))

jest.mock('../../src', () => ({
    handleEscapeCharacters: jest.fn((value: string) => value),
    webCrawl: jest.fn(),
    xmlScrape: jest.fn()
}))

jest.mock('../../src/utils', () => ({
    handleEscapeCharacters: jest.fn((value: string) => value),
    webCrawl: jest.fn(),
    xmlScrape: jest.fn()
}))

jest.mock('../../src/httpSecurity', () => ({
    ...jest.requireActual('../../src/httpSecurity'),
    checkDenyList: jest.fn(),
    secureFetch: jest.fn()
}))

jest.mock('@langchain/community/document_loaders/web/cheerio', () => {
    const state = {
        imports: jest.fn(async () => ({ load: jest.fn(() => ({ html: true })) })),
        load: jest.fn()
    }

    class MockCheerioWebBaseLoader {
        headers = { 'user-agent': 'flowise-security-test' }
        timeout = 1000
        textDecoder = undefined
        scrape!: () => Promise<unknown>

        static imports = state.imports

        async load() {
            state.load()
            await this.scrape()
            return [{ pageContent: 'cheerio-safe', metadata: {} }]
        }
    }

    return { CheerioWebBaseLoader: MockCheerioWebBaseLoader, __mockState: state }
})

jest.mock('@langchain/community/document_loaders/web/playwright', () => {
    const state: any = {
        routeHandler: undefined,
        requestUrls: ['https://example.com/'],
        finalUrl: 'https://example.com/',
        lateRequestOnClose: false,
        allowedContinue: jest.fn(),
        allowedAbort: jest.fn(),
        deniedContinue: jest.fn(),
        deniedAbort: jest.fn()
    }
    const page = {
        route: jest.fn(async (_pattern: string, handler: unknown) => {
            state.routeHandler = handler
        }),
        goto: jest.fn(async () => {
            for (const url of state.requestUrls) {
                const denied = url.includes('169.254.169.254')
                await state.routeHandler(
                    {
                        continue: denied ? state.deniedContinue : state.allowedContinue,
                        abort: denied ? state.deniedAbort : state.allowedAbort
                    },
                    { url: () => url }
                )
            }
            return { status: () => 200, url: () => state.finalUrl }
        }),
        content: jest.fn(async () => '<main>playwright-safe</main>'),
        url: jest.fn(() => state.finalUrl)
    }
    const context = { newPage: jest.fn(async () => page) }
    const browser = {
        newContext: jest.fn(async () => context),
        close: jest.fn(async () => {
            if (!state.lateRequestOnClose) return
            state.lateRequestOnClose = false
            await state.routeHandler(
                {
                    continue: state.deniedContinue,
                    abort: state.deniedAbort
                },
                { url: () => 'http://169.254.169.254/latest/meta-data/late' }
            )
        })
    }
    state.launch = jest.fn(async () => browser)
    state.page = page
    state.context = context
    state.browser = browser

    class MockPlaywrightWebBaseLoader {
        scrape!: () => Promise<string>

        static imports = jest.fn(async () => ({ chromium: { launch: state.launch } }))

        async load() {
            const html = await this.scrape()
            return [{ pageContent: html, metadata: {} }]
        }
    }

    return { PlaywrightWebBaseLoader: MockPlaywrightWebBaseLoader, __mockState: state }
})

jest.mock('@langchain/community/document_loaders/web/puppeteer', () => {
    const state: any = {
        requestHandler: undefined,
        requestUrls: ['https://example.com/'],
        finalUrl: 'https://example.com/',
        lateRequestOnClose: false,
        allowedContinue: jest.fn(),
        allowedAbort: jest.fn(),
        deniedContinue: jest.fn(),
        deniedAbort: jest.fn()
    }
    const page = {
        setBypassServiceWorker: jest.fn(async () => undefined),
        setRequestInterception: jest.fn(async () => undefined),
        on: jest.fn((_event: string, handler: unknown) => {
            state.requestHandler = handler
        }),
        goto: jest.fn(async () => {
            for (const url of state.requestUrls) {
                const denied = url.includes('169.254.169.254')
                await state.requestHandler({
                    url: () => url,
                    continue: denied ? state.deniedContinue : state.allowedContinue,
                    abort: denied ? state.deniedAbort : state.allowedAbort
                })
            }
            return { status: () => 200, url: () => state.finalUrl }
        }),
        evaluate: jest.fn(async () => '<main>puppeteer-safe</main>'),
        url: jest.fn(() => state.finalUrl)
    }
    const browser = {
        newPage: jest.fn(async () => page),
        close: jest.fn(async () => {
            if (!state.lateRequestOnClose) return
            state.lateRequestOnClose = false
            state.requestHandler({
                url: () => 'http://169.254.169.254/latest/meta-data/late',
                continue: state.deniedContinue,
                abort: state.deniedAbort
            })
        })
    }
    state.launch = jest.fn(async () => browser)
    state.page = page
    state.browser = browser

    class MockPuppeteerWebBaseLoader {
        scrape!: () => Promise<string>

        static imports = jest.fn(async () => ({ launch: state.launch }))

        async load() {
            const html = await this.scrape()
            return [{ pageContent: html, metadata: {} }]
        }
    }

    return { PuppeteerWebBaseLoader: MockPuppeteerWebBaseLoader, __mockState: state }
})

const { nodeClass: CheerioWebScraper } = require('./Cheerio/Cheerio')
const { nodeClass: PlaywrightWebScraper } = require('./Playwright/Playwright')
const { nodeClass: PuppeteerWebScraper } = require('./Puppeteer/Puppeteer')

const cheerioState = require('@langchain/community/document_loaders/web/cheerio').__mockState
const playwrightState = require('@langchain/community/document_loaders/web/playwright').__mockState
const puppeteerState = require('@langchain/community/document_loaders/web/puppeteer').__mockState
const proxyState = require('./webScraperSecurity').__proxyState
const directUtilsState = require('../../src/utils')
const barrelUtilsState = require('../../src')

const logger = { info: jest.fn(), error: jest.fn() }

function nodeData(url: string, inputs: Record<string, unknown> = {}) {
    return { inputs: { url, ...inputs }, outputs: { output: 'document' } }
}

function expectPolicyRejection(promise: Promise<unknown>) {
    return expect(promise).rejects.toMatchObject({
        code: WEB_SCRAPER_POLICY_ERROR_CODE,
        message: 'Web scraper request was denied by network policy.'
    })
}

describe('web scraper fail-closed transport policy', () => {
    beforeEach(() => {
        jest.clearAllMocks()
        playwrightState.routeHandler = undefined
        playwrightState.requestUrls = ['https://example.com/']
        playwrightState.finalUrl = 'https://example.com/'
        playwrightState.lateRequestOnClose = false
        puppeteerState.requestHandler = undefined
        puppeteerState.requestUrls = ['https://example.com/']
        puppeteerState.finalUrl = 'https://example.com/'
        puppeteerState.lateRequestOnClose = false
        proxyState.denyOnClose = false
        ;(dns.lookup as jest.Mock).mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
        ;(checkDenyList as jest.Mock).mockResolvedValue(undefined)
        ;(secureFetch as jest.Mock).mockResolvedValue({
            text: jest.fn(async () => '<main>cheerio-safe</main>'),
            arrayBuffer: jest.fn(async () => new ArrayBuffer(0))
        })
    })

    it.each([
        ['Cheerio', CheerioWebScraper, cheerioState.load],
        ['Playwright', PlaywrightWebScraper, playwrightState.launch],
        ['Puppeteer', PuppeteerWebScraper, puppeteerState.launch]
    ])('rejects a denied %s entry URL before the loader can perform I/O', async (_name, Loader, networkStart) => {
        ;(checkDenyList as jest.Mock).mockRejectedValueOnce(new Error('Access to this host is denied by policy.'))

        await expectPolicyRejection(new Loader().init(nodeData('http://127.0.0.1/admin'), '', { logger, orgId: 'org-security-test' }))

        expect(checkDenyList).toHaveBeenCalledWith('http://127.0.0.1/admin')
        expect(networkStart).not.toHaveBeenCalled()
    })

    it('routes Cheerio transport and every redirect through secureFetch', async () => {
        const result = await new CheerioWebScraper().init(nodeData('https://example.com/'), '', {
            logger,
            orgId: 'org-security-test'
        })

        expect(result).toEqual([{ pageContent: 'cheerio-safe', metadata: {} }])
        expect(checkDenyList).toHaveBeenCalledWith('https://example.com/')
        expect(secureFetch).toHaveBeenCalledWith(
            'https://example.com/',
            expect.objectContaining({ headers: { 'user-agent': 'flowise-security-test' } }),
            5,
            undefined,
            WEB_SCRAPER_SECURE_FETCH_POLICY
        )
    })

    it('keeps the default scraper deny list active when the global compatibility switch is disabled', async () => {
        const previous = process.env.HTTP_SECURITY_CHECK
        process.env.HTTP_SECURITY_CHECK = 'false'
        try {
            await expectPolicyRejection(assertWebScraperUrlAllowed('http://127.0.0.1/admin'))
            expect(checkDenyList).toHaveBeenCalledWith('http://127.0.0.1/admin')
        } finally {
            if (previous === undefined) delete process.env.HTTP_SECURITY_CHECK
            else process.env.HTTP_SECURITY_CHECK = previous
        }
    })

    it.each([
        ['Cheerio', CheerioWebScraper, directUtilsState.webCrawl, directUtilsState.xmlScrape, cheerioState.load],
        ['Playwright', PlaywrightWebScraper, barrelUtilsState.webCrawl, barrelUtilsState.xmlScrape, playwrightState.launch],
        ['Puppeteer', PuppeteerWebScraper, barrelUtilsState.webCrawl, barrelUtilsState.xmlScrape, puppeteerState.launch]
    ])(
        'rejects a private %s discovery entry before webCrawl or xmlScrape can perform I/O',
        async (_name, Loader, webCrawlMock, xmlScrapeMock, networkStart) => {
            const previous = process.env.HTTP_SECURITY_CHECK
            process.env.HTTP_SECURITY_CHECK = 'false'
            try {
                for (const relativeLinksMethod of ['webCrawl', 'xmlScrape']) {
                    await expectPolicyRejection(
                        new Loader().init(nodeData('http://127.0.0.1/admin', { limit: '1', relativeLinksMethod }), '', {
                            logger,
                            orgId: 'org-security-test'
                        })
                    )
                }

                expect(webCrawlMock).not.toHaveBeenCalled()
                expect(xmlScrapeMock).not.toHaveBeenCalled()
                expect(networkStart).not.toHaveBeenCalled()
            } finally {
                if (previous === undefined) delete process.env.HTTP_SECURITY_CHECK
                else process.env.HTTP_SECURITY_CHECK = previous
            }
        }
    )

    it.each([
        ['Cheerio', 'webCrawl', CheerioWebScraper, directUtilsState.webCrawl],
        ['Cheerio', 'xmlScrape', CheerioWebScraper, directUtilsState.xmlScrape],
        ['Playwright', 'webCrawl', PlaywrightWebScraper, barrelUtilsState.webCrawl],
        ['Playwright', 'xmlScrape', PlaywrightWebScraper, barrelUtilsState.xmlScrape],
        ['Puppeteer', 'webCrawl', PuppeteerWebScraper, barrelUtilsState.webCrawl],
        ['Puppeteer', 'xmlScrape', PuppeteerWebScraper, barrelUtilsState.xmlScrape]
    ])('passes the mandatory scraper policy into %s %s discovery transport', async (_name, relativeLinksMethod, Loader, discoveryMock) => {
        discoveryMock.mockResolvedValueOnce(['https://example.com/'])

        await new Loader().init(nodeData('https://example.com/', { limit: '1', relativeLinksMethod }), '', {
            logger,
            orgId: 'org-security-test'
        })

        expect(discoveryMock).toHaveBeenCalledWith('https://example.com/', 1, WEB_SCRAPER_SECURE_FETCH_POLICY)
    })

    it('propagates the mandatory policy into every actual webCrawl and xmlScrape secureFetch request', async () => {
        const actualUtils = jest.requireActual<typeof import('../../src/utils')>('../../src/utils')

        ;(secureFetch as jest.Mock).mockResolvedValueOnce({
            headers: { get: jest.fn(() => 'text/html') },
            status: 200,
            text: jest.fn(async () => '<html><body>fixture</body></html>')
        })
        await actualUtils.webCrawl('https://example.com/', 1, WEB_SCRAPER_SECURE_FETCH_POLICY)
        expect(secureFetch).toHaveBeenLastCalledWith('https://example.com', undefined, 5, undefined, WEB_SCRAPER_SECURE_FETCH_POLICY)
        ;(secureFetch as jest.Mock).mockResolvedValueOnce({
            headers: { get: jest.fn(() => 'application/xml') },
            status: 200,
            text: jest.fn(async () => '<urlset><url><loc>https://example.com/page</loc></url></urlset>')
        })
        await actualUtils.xmlScrape('https://example.com/sitemap.xml', 1, WEB_SCRAPER_SECURE_FETCH_POLICY)
        expect(secureFetch).toHaveBeenLastCalledWith(
            'https://example.com/sitemap.xml',
            undefined,
            5,
            undefined,
            WEB_SCRAPER_SECURE_FETCH_POLICY
        )
    })

    it('fails closed within the configured deadline when tracked policy work never settles', async () => {
        const tracker = new WebScraperOperationTracker(20)
        tracker.start(
            async () => {
                await new Promise<void>(() => undefined)
            },
            () => undefined
        )
        tracker.beginClosing()

        await expectPolicyRejection(tracker.drain())
    })

    it('does not turn a Cheerio secure transport rejection into an empty successful result', async () => {
        ;(secureFetch as jest.Mock).mockRejectedValueOnce(new Error('Access to redirect host is denied by policy.'))

        await expectPolicyRejection(
            new CheerioWebScraper().init(nodeData('https://example.com/'), '', { logger, orgId: 'org-security-test' })
        )
    })

    it('uses a pinned loopback proxy and blocks Playwright service workers for an allowed scrape', async () => {
        const result = await new PlaywrightWebScraper().init(nodeData('https://example.com/'), '', {
            logger,
            orgId: 'org-security-test'
        })

        expect(logger.error).not.toHaveBeenCalled()
        expect(result).toHaveLength(1)
        expect(playwrightState.browser.newContext).toHaveBeenCalledWith({ serviceWorkers: 'block' })
        expect(playwrightState.page.route).toHaveBeenCalledWith('**/*', expect.any(Function))
        expect(playwrightState.allowedContinue).toHaveBeenCalledTimes(1)
        expect(playwrightState.allowedAbort).not.toHaveBeenCalled()
        expect(playwrightState.launch).toHaveBeenCalledWith(
            expect.objectContaining({
                chromiumSandbox: true,
                args: expect.arrayContaining(['--proxy-bypass-list=<-loopback>', '--disable-quic']),
                proxy: { server: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) }
            })
        )
        expect(playwrightState.launch.mock.calls[0][0].args).not.toContain('--no-sandbox')
        expect(playwrightState.browser.close).toHaveBeenCalledTimes(1)
    })

    it('uses a pinned loopback proxy and bypasses Puppeteer service workers for an allowed scrape', async () => {
        const result = await new PuppeteerWebScraper().init(nodeData('https://example.com/'), '', {
            logger,
            orgId: 'org-security-test'
        })

        expect(logger.error).not.toHaveBeenCalled()
        expect(result).toHaveLength(1)
        expect(puppeteerState.page.setBypassServiceWorker).toHaveBeenCalledWith(true)
        expect(puppeteerState.page.setRequestInterception).toHaveBeenCalledWith(true)
        expect(puppeteerState.allowedContinue).toHaveBeenCalledTimes(1)
        expect(puppeteerState.allowedAbort).not.toHaveBeenCalled()
        expect(puppeteerState.launch).toHaveBeenCalledWith(
            expect.objectContaining({
                args: expect.arrayContaining([
                    expect.stringMatching(/^--proxy-server=http:\/\/127\.0\.0\.1:\d+$/),
                    '--proxy-bypass-list=<-loopback>',
                    '--disable-quic'
                ])
            })
        )
        expect(puppeteerState.launch.mock.calls[0][0].args).not.toContain('--no-sandbox')
        expect(puppeteerState.browser.close).toHaveBeenCalledTimes(1)
    })

    it.each([
        ['Playwright', PlaywrightWebScraper, playwrightState],
        ['Puppeteer', PuppeteerWebScraper, puppeteerState]
    ])('aborts and surfaces a denied %s redirect instead of returning partial content', async (_name, Loader, state) => {
        state.requestUrls = ['https://example.com/', 'http://169.254.169.254/latest/meta-data/']
        state.finalUrl = 'http://169.254.169.254/latest/meta-data/'
        ;(checkDenyList as jest.Mock).mockImplementation(async (url: string) => {
            if (url.startsWith('http://169.254.169.254/')) throw new Error('denied')
        })

        await expectPolicyRejection(new Loader().init(nodeData('https://example.com/'), '', { logger, orgId: 'org-security-test' }))

        expect(state.deniedContinue).not.toHaveBeenCalled()
        expect(state.deniedAbort).toHaveBeenCalledWith('blockedbyclient')
        expect(state.browser.close).toHaveBeenCalledTimes(1)
    })

    it.each([
        ['Playwright', PlaywrightWebScraper, playwrightState],
        ['Puppeteer', PuppeteerWebScraper, puppeteerState]
    ])('fails the entire %s scrape when any subresource is denied', async (_name, Loader, state) => {
        state.requestUrls = ['https://example.com/', 'http://169.254.169.254/latest/meta-data/']
        state.finalUrl = 'https://example.com/'
        ;(checkDenyList as jest.Mock).mockImplementation(async (url: string) => {
            if (url.startsWith('http://169.254.169.254/')) throw new Error('denied')
        })

        await expectPolicyRejection(new Loader().init(nodeData('https://example.com/'), '', { logger, orgId: 'org-security-test' }))
        expect(state.deniedAbort).toHaveBeenCalledWith('blockedbyclient')
    })

    it.each([
        ['Playwright', PlaywrightWebScraper, playwrightState],
        ['Puppeteer', PuppeteerWebScraper, puppeteerState]
    ])('revalidates the final %s response URL even if a redirect event was missed', async (_name, Loader, state) => {
        state.requestUrls = ['https://example.com/']
        state.finalUrl = 'http://169.254.169.254/latest/meta-data/'
        ;(checkDenyList as jest.Mock).mockImplementation(async (url: string) => {
            if (url.startsWith('http://169.254.169.254/')) throw new Error('denied')
        })

        await expectPolicyRejection(new Loader().init(nodeData('https://example.com/'), '', { logger, orgId: 'org-security-test' }))
    })

    it.each([
        ['Playwright', PlaywrightWebScraper, playwrightState],
        ['Puppeteer', PuppeteerWebScraper, puppeteerState]
    ])('surfaces a late %s proxy denial recorded during cleanup', async (_name, Loader, state) => {
        proxyState.denyOnClose = true

        await expectPolicyRejection(new Loader().init(nodeData('https://example.com/'), '', { logger, orgId: 'org-security-test' }))
        expect(state.browser.close).toHaveBeenCalledTimes(1)
    })

    it.each([
        ['Playwright', PlaywrightWebScraper, playwrightState],
        ['Puppeteer', PuppeteerWebScraper, puppeteerState]
    ])('waits for a late %s subresource policy check triggered during browser close', async (_name, Loader, state) => {
        state.lateRequestOnClose = true
        ;(checkDenyList as jest.Mock).mockImplementation(async (url: string) => {
            if (url.includes('169.254.169.254')) {
                await new Promise<void>((resolve) => setImmediate(resolve))
                throw new Error('denied')
            }
        })

        await expectPolicyRejection(new Loader().init(nodeData('https://example.com/'), '', { logger, orgId: 'org-security-test' }))
        expect(state.deniedContinue).not.toHaveBeenCalled()
        expect(state.deniedAbort).toHaveBeenCalledWith('blockedbyclient')
        expect(state.browser.close).toHaveBeenCalledTimes(1)
    })

    it('rejects a DNS answer that changes to a denied IP before the proxy pins a connection', async () => {
        ;(dns.lookup as jest.Mock)
            .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
            .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
        ;(checkDenyList as jest.Mock).mockImplementation(async (url: string) => {
            if (url === 'https://127.0.0.1/') throw new Error('denied')
        })

        await expect(resolvePinnedBrowserTarget(new URL('https://public.example/'))).rejects.toBeInstanceOf(WebScraperPolicyError)
        expect(checkDenyList).toHaveBeenNthCalledWith(1, 'https://public.example/')
        expect(checkDenyList).toHaveBeenNthCalledWith(2, 'https://127.0.0.1/')
    })

    it('selects only from the exact second DNS set after validating every address as a literal', async () => {
        ;(dns.lookup as jest.Mock).mockResolvedValueOnce([{ address: '9.9.9.9', family: 4 }]).mockResolvedValueOnce([
            { address: '2606:4700:4700::1111', family: 6 },
            { address: '8.8.8.8', family: 4 }
        ])

        await expect(resolvePinnedBrowserTarget(new URL('https://public.example/path'))).resolves.toEqual({
            address: '8.8.8.8',
            family: 4,
            hostname: 'public.example',
            port: 443
        })
        expect(checkDenyList).toHaveBeenCalledWith('https://[2606:4700:4700::1111]/')
        expect(checkDenyList).toHaveBeenCalledWith('https://8.8.8.8/')
    })

    it('drains delayed proxy DNS work and rejects new proxy requests after closing starts', async () => {
        const actualSecurity = jest.requireActual<typeof import('./webScraperSecurity')>('./webScraperSecurity')
        const server: any = new EventEmitter()
        server.listening = false
        server.listen = jest.fn((_port: number, _host: string, callback: () => void) => {
            server.listening = true
            callback()
            return server
        })
        server.address = jest.fn(() => ({ address: '127.0.0.1', family: 'IPv4', port: 43125 }))
        server.close = jest.fn((callback: (error?: Error) => void) => {
            server.listening = false
            callback()
        })

        let httpHandler: ((request: any, response: any) => void) | undefined
        const createServer = jest.spyOn(http, 'createServer').mockImplementation(((handler: any) => {
            httpHandler = handler
            return server
        }) as any)
        const request = jest.spyOn(http, 'request')

        let releaseLookup!: (records: Array<{ address: string; family: number }>) => void
        let markLookupStarted!: () => void
        const lookupStarted = new Promise<void>((resolve) => {
            markLookupStarted = resolve
        })
        const delayedLookup = new Promise<Array<{ address: string; family: number }>>((resolve) => {
            releaseLookup = resolve
        })
        ;(dns.lookup as jest.Mock).mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockImplementationOnce(async () => {
            markLookupStarted()
            return delayedLookup
        })

        const guard = new actualSecurity.WebScraperPolicyGuard()
        let proxy: any
        try {
            proxy = await actualSecurity.startPinnedBrowserProxy(guard)
            const browserRequest = {
                headers: { host: 'proxy.invalid' },
                method: 'GET',
                pipe: jest.fn(),
                url: 'http://public.example/path'
            }
            const browserResponse = { destroy: jest.fn(), writeHead: jest.fn() }
            httpHandler?.(browserRequest, browserResponse)
            await lookupStarted

            let closeSettled = false
            const closing = proxy.close().then(() => {
                closeSettled = true
            })
            await Promise.resolve()
            expect(closeSettled).toBe(false)

            const lateRequest = {
                headers: { host: 'proxy.invalid' },
                method: 'GET',
                pipe: jest.fn(),
                url: 'http://public.example/late'
            }
            const lateResponse = { destroy: jest.fn(), writeHead: jest.fn() }
            httpHandler?.(lateRequest, lateResponse)
            expect(lateResponse.destroy).toHaveBeenCalledTimes(1)

            releaseLookup([{ address: '1.1.1.1', family: 4 }])
            await closing
            proxy = undefined

            expect(request).not.toHaveBeenCalled()
            expect(browserRequest.pipe).not.toHaveBeenCalled()
            expect(browserResponse.destroy).toHaveBeenCalledTimes(1)
            expect(lateRequest.pipe).not.toHaveBeenCalled()
            expect(() => guard.throwIfDenied()).toThrow(WebScraperPolicyError)
        } finally {
            if (proxy) await proxy.close()
            createServer.mockRestore()
            request.mockRestore()
        }
    })

    it('pins HTTP and CONNECT, handles upgrade resets, and destroys tracked sockets on close', async () => {
        const actualSecurity = jest.requireActual<typeof import('./webScraperSecurity')>('./webScraperSecurity')
        const server: any = new EventEmitter()
        server.listening = false
        server.listen = jest.fn((_port: number, _host: string, callback: () => void) => {
            server.listening = true
            callback()
            return server
        })
        server.address = jest.fn(() => ({ address: '127.0.0.1', family: 'IPv4', port: 43124 }))
        server.close = jest.fn((callback: (error?: Error) => void) => {
            server.listening = false
            callback()
        })

        let httpHandler: ((request: any, response: any) => void) | undefined
        const createServer = jest.spyOn(http, 'createServer').mockImplementation(((handler: any) => {
            httpHandler = handler
            return server
        }) as any)

        const httpUpstream: any = new EventEmitter()
        httpUpstream.pipe = jest.fn()
        httpUpstream.write = jest.fn()
        httpUpstream.destroy = jest.fn(() => httpUpstream.emit('close'))
        const upstreamResponse: any = new EventEmitter()
        upstreamResponse.headers = { 'content-type': 'text/plain' }
        upstreamResponse.pipe = jest.fn()
        upstreamResponse.statusCode = 200
        upstreamResponse.statusMessage = 'OK'
        upstreamResponse.destroy = jest.fn(() => upstreamResponse.emit('close'))
        const request = jest.spyOn(http, 'request').mockImplementation(((options: any, callback: any) => {
            callback(upstreamResponse)
            return httpUpstream
        }) as any)

        const connectUpstream: any = new EventEmitter()
        connectUpstream.destroy = jest.fn(() => connectUpstream.emit('close'))
        connectUpstream.pipe = jest.fn()
        connectUpstream.write = jest.fn()
        const connect = jest.spyOn(net, 'connect').mockReturnValue(connectUpstream as any)

        ;(dns.lookup as jest.Mock)
            .mockResolvedValueOnce([{ address: '9.9.9.9', family: 4 }])
            .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
            .mockResolvedValueOnce([{ address: '9.9.9.9', family: 4 }])
            .mockResolvedValueOnce([{ address: '1.1.1.1', family: 4 }])
        ;(checkDenyList as jest.Mock).mockResolvedValue(undefined)

        const guard = new actualSecurity.WebScraperPolicyGuard()
        let proxy: any
        try {
            proxy = await actualSecurity.startPinnedBrowserProxy(guard)
            expect(proxy.server).toBe('http://127.0.0.1:43124')

            const upgradeSocket: any = new EventEmitter()
            upgradeSocket.destroy = jest.fn()
            upgradeSocket.end = jest.fn()
            server.emit('upgrade', {}, upgradeSocket)
            expect(upgradeSocket.end).toHaveBeenCalledWith('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
            expect(() => upgradeSocket.emit('error', new Error('upgrade reset fixture'))).not.toThrow()
            expect(upgradeSocket.destroy).toHaveBeenCalled()

            const clientConnection: any = new EventEmitter()
            clientConnection.destroy = jest.fn(() => clientConnection.emit('close'))
            server.emit('connection', clientConnection)

            const browserRequest: any = new EventEmitter()
            browserRequest.headers = { host: 'proxy.invalid', 'x-trace': 'fixture' }
            browserRequest.method = 'GET'
            browserRequest.pipe = jest.fn()
            browserRequest.url = 'http://public.example:8080/path?ok=1'
            const browserResponse: any = new EventEmitter()
            browserResponse.destroy = jest.fn(() => browserResponse.emit('close'))
            browserResponse.writeHead = jest.fn()
            httpHandler?.(browserRequest, browserResponse)
            await new Promise<void>((resolve) => setImmediate(resolve))

            expect(request).toHaveBeenCalledWith(
                expect.objectContaining({
                    agent: false,
                    family: 4,
                    headers: expect.objectContaining({ host: 'public.example:8080', 'x-trace': 'fixture' }),
                    host: '8.8.8.8',
                    path: '/path?ok=1',
                    port: 8080
                }),
                expect.any(Function)
            )
            expect(browserRequest.pipe).toHaveBeenCalledWith(httpUpstream)
            expect(upstreamResponse.listenerCount('error')).toBeGreaterThan(0)

            const httpSocket: any = new EventEmitter()
            httpSocket.destroy = jest.fn(() => httpSocket.emit('close'))
            httpUpstream.emit('socket', httpSocket)
            expect(() => upstreamResponse.emit('error', new Error('upstream reset fixture'))).not.toThrow()
            expect(browserResponse.destroy).toHaveBeenCalled()

            const connectRequest = { url: 'secure.example:8443' }
            const clientSocket: any = new EventEmitter()
            clientSocket.destroy = jest.fn(() => clientSocket.emit('close'))
            clientSocket.end = jest.fn()
            clientSocket.pipe = jest.fn()
            clientSocket.write = jest.fn()
            server.emit('connection', clientSocket)
            server.emit('connect', connectRequest, clientSocket, Buffer.alloc(0))
            expect(clientSocket.listenerCount('error')).toBeGreaterThan(0)
            await new Promise<void>((resolve) => setImmediate(resolve))

            expect(connect).toHaveBeenCalledWith({ family: 4, host: '1.1.1.1', port: 8443 })
            connectUpstream.emit('connect')
            expect(clientSocket.write).toHaveBeenCalledWith('HTTP/1.1 200 Connection Established\r\n\r\n')
            expect(connectUpstream.pipe).toHaveBeenCalledWith(clientSocket)
            expect(clientSocket.pipe).toHaveBeenCalledWith(connectUpstream)

            await proxy.close()
            proxy = undefined
            expect(httpUpstream.destroy).toHaveBeenCalled()
            expect(upstreamResponse.destroy).toHaveBeenCalled()
            expect(clientConnection.destroy).toHaveBeenCalled()
            expect(clientSocket.destroy).toHaveBeenCalled()
            expect(httpSocket.destroy).toHaveBeenCalled()
            expect(connectUpstream.destroy).toHaveBeenCalled()
            expect(server.close).toHaveBeenCalledTimes(1)
            expect(() => guard.throwIfDenied()).toThrow(WebScraperPolicyError)
        } finally {
            if (proxy) await proxy.close()
            createServer.mockRestore()
            request.mockRestore()
            connect.mockRestore()
        }
    })
})
