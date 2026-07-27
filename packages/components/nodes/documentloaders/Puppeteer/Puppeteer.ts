import { Browser, Page, PuppeteerWebBaseLoader, PuppeteerWebBaseLoaderOptions } from '@langchain/community/document_loaders/web/puppeteer'
import { Document } from '@langchain/core/documents'
import { TextSplitter } from '@langchain/textsplitters'
import { test } from 'linkifyjs'
import { omit } from 'lodash'
import { PuppeteerLifeCycleEvent } from 'puppeteer'
import { handleEscapeCharacters, INodeOutputsValue, webCrawl, xmlScrape } from '../../../src'
import { ICommonObject, INode, INodeData, INodeParams } from '../../../src/Interface'
import {
    assertWebScraperUrlAllowed,
    isWebScraperPolicyError,
    startPinnedBrowserProxy,
    WEB_SCRAPER_SECURE_FETCH_POLICY,
    WebScraperOperationTracker,
    WebScraperPolicyGuard
} from '../webScraperSecurity'

class Puppeteer_DocumentLoaders implements INode {
    label: string
    name: string
    version: number
    description: string
    type: string
    icon: string
    category: string
    baseClasses: string[]
    inputs: INodeParams[]
    outputs: INodeOutputsValue[]

    constructor() {
        this.label = 'Puppeteer Web Scraper'
        this.name = 'puppeteerWebScraper'
        this.version = 2.0
        this.type = 'Document'
        this.icon = 'puppeteer.svg'
        this.category = 'Document Loaders'
        this.description = `Load data from webpages`
        this.baseClasses = [this.type]
        this.inputs = [
            {
                label: 'URL',
                name: 'url',
                type: 'string'
            },
            {
                label: 'Text Splitter',
                name: 'textSplitter',
                type: 'TextSplitter',
                optional: true
            },
            {
                label: 'Get Relative Links Method',
                name: 'relativeLinksMethod',
                type: 'options',
                description: 'Select a method to retrieve relative links',
                options: [
                    {
                        label: 'Web Crawl',
                        name: 'webCrawl',
                        description: 'Crawl relative links from HTML URL'
                    },
                    {
                        label: 'Scrape XML Sitemap',
                        name: 'scrapeXMLSitemap',
                        description: 'Scrape relative links from XML sitemap URL'
                    }
                ],
                default: 'webCrawl',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Get Relative Links Limit',
                name: 'limit',
                type: 'number',
                optional: true,
                default: '10',
                additionalParams: true,
                description:
                    'Only used when "Get Relative Links Method" is selected. Set 0 to retrieve all relative links, default limit is 10.',
                warning: `Retrieving all links might take long time, and all links will be upserted again if the flow's state changed (eg: different URL, chunk size, etc)`
            },
            {
                label: 'Wait Until',
                name: 'waitUntilGoToOption',
                type: 'options',
                description: 'Select a go to wait until option',
                options: [
                    {
                        label: 'Load',
                        name: 'load',
                        description: `When the initial HTML document's DOM has been loaded and parsed`
                    },
                    {
                        label: 'DOM Content Loaded',
                        name: 'domcontentloaded',
                        description: `When the complete HTML document's DOM has been loaded and parsed`
                    },
                    {
                        label: 'Network Idle 0',
                        name: 'networkidle0',
                        description: 'Navigation is finished when there are no more than 0 network connections for at least 500 ms'
                    },
                    {
                        label: 'Network Idle 2',
                        name: 'networkidle2',
                        description: 'Navigation is finished when there are no more than 2 network connections for at least 500 ms'
                    }
                ],
                optional: true,
                additionalParams: true
            },
            {
                label: 'Wait for selector to load',
                name: 'waitForSelector',
                type: 'string',
                optional: true,
                additionalParams: true,
                description: 'CSS selectors like .div or #div'
            },
            {
                label: 'CSS Selector (Optional)',
                name: 'cssSelector',
                type: 'string',
                description: 'Only content inside this selector will be extracted. Leave empty to use the entire page body.',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Additional Metadata',
                name: 'metadata',
                type: 'json',
                description: 'Additional metadata to be added to the extracted documents',
                optional: true,
                additionalParams: true
            },
            {
                label: 'Omit Metadata Keys',
                name: 'omitMetadataKeys',
                type: 'string',
                rows: 4,
                description:
                    'Each document loader comes with a default set of metadata keys that are extracted from the document. You can use this field to omit some of the default metadata keys. The value should be a list of keys, seperated by comma. Use * to omit all metadata keys execept the ones you specify in the Additional Metadata field',
                placeholder: 'key1, key2, key3.nestedKey1',
                optional: true,
                additionalParams: true
            }
        ]
        this.outputs = [
            {
                label: 'Document',
                name: 'document',
                description: 'Array of document objects containing metadata and pageContent',
                baseClasses: [...this.baseClasses, 'json']
            },
            {
                label: 'Text',
                name: 'text',
                description: 'Concatenated string from pageContent of documents',
                baseClasses: ['string', 'json']
            }
        ]
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        const textSplitter = nodeData.inputs?.textSplitter as TextSplitter
        const metadata = nodeData.inputs?.metadata
        const relativeLinksMethod = nodeData.inputs?.relativeLinksMethod as string
        const selectedLinks = nodeData.inputs?.selectedLinks as string[]
        let limit = parseInt(nodeData.inputs?.limit as string)
        const waitUntilGoToOption = nodeData.inputs?.waitUntilGoToOption as PuppeteerLifeCycleEvent
        const waitForSelector = nodeData.inputs?.waitForSelector as string
        const cssSelector = nodeData.inputs?.cssSelector as string
        const _omitMetadataKeys = nodeData.inputs?.omitMetadataKeys as string
        const output = nodeData.outputs?.output as string
        const orgId = options.orgId

        let omitMetadataKeys: string[] = []
        if (_omitMetadataKeys) {
            omitMetadataKeys = _omitMetadataKeys.split(',').map((key) => key.trim())
        }

        let url = nodeData.inputs?.url as string
        url = url.trim()
        if (!test(url)) {
            throw new Error('Invalid URL')
        }

        async function puppeteerLoader(url: string): Promise<Document[] | undefined> {
            await assertWebScraperUrlAllowed(url)
            try {
                let docs: Document[] = []

                const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.PUPPETEER_EXECUTABLE_FILE_PATH

                const config: PuppeteerWebBaseLoaderOptions = {
                    launchOptions: {
                        headless: 'new',
                        executablePath: executablePath
                    }
                }
                if (waitUntilGoToOption) {
                    config['gotoOptions'] = {
                        waitUntil: waitUntilGoToOption
                    }
                }
                if (cssSelector || waitForSelector) {
                    config['evaluate'] = async (page: Page, _: Browser): Promise<string> => {
                        if (waitForSelector) {
                            await page.waitForSelector(waitForSelector)
                        }

                        if (cssSelector) {
                            const selectorHandle = await page.$(cssSelector)
                            const result = await page.evaluate(
                                (htmlSelection) => htmlSelection?.innerHTML ?? document.body.innerHTML,
                                selectorHandle
                            )
                            return result
                        } else {
                            return await page.evaluate(() => document.body.innerHTML)
                        }
                    }
                }
                const loader = new PuppeteerWebBaseLoader(url, config)
                loader.scrape = async (): Promise<string> => {
                    const { launch } = await PuppeteerWebBaseLoader.imports()
                    const policy = new WebScraperPolicyGuard()
                    const proxy = await startPinnedBrowserProxy(policy)
                    const policyChecks = new WebScraperOperationTracker()
                    let browser: Browser | undefined
                    let html: string | undefined
                    let scrapeError: unknown
                    try {
                        browser = await launch({
                            headless: true,
                            defaultViewport: null,
                            ignoreDefaultArgs: ['--disable-extensions'],
                            ...config.launchOptions,
                            args: [
                                ...(config.launchOptions?.args ?? []),
                                `--proxy-server=${proxy.server}`,
                                '--proxy-bypass-list=<-loopback>',
                                '--disable-quic',
                                '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'
                            ]
                        })
                        const page = await browser.newPage()
                        await page.setBypassServiceWorker(true)
                        await page.setRequestInterception(true)
                        page.on('request', (interceptedRequest) => {
                            const pending = policyChecks.start(
                                async () => {
                                    const allowed = await policy.allows(interceptedRequest.url())
                                    try {
                                        if (allowed) await interceptedRequest.continue()
                                        else await interceptedRequest.abort('blockedbyclient')
                                    } catch {
                                        // The page may close or cancel a request while the
                                        // asynchronous policy lookup is in flight.
                                    }
                                },
                                (error) => policy.record(error)
                            )
                            if (pending) return

                            // Puppeteer's event emitter does not await handlers.
                            // During teardown, abort without starting new policy
                            // or proxy work.
                            policy.record(new Error('Web scraper request arrived after browser shutdown'))
                            void interceptedRequest.abort('blockedbyclient').catch(() => undefined)
                        })
                        let response
                        try {
                            response = await page.goto(url, {
                                timeout: 180000,
                                waitUntil: 'domcontentloaded',
                                ...config.gotoOptions
                            })
                            await policyChecks.drain()
                        } catch (error) {
                            await policyChecks.drain()
                            policy.throwIfDenied()
                            throw error
                        }
                        policy.throwIfDenied()
                        if (response && !(await policy.allows(response.url()))) policy.throwIfDenied()
                        if (!(await policy.allows(page.url()))) policy.throwIfDenied()

                        html = config.evaluate ? await config.evaluate(page, browser) : await page.evaluate(() => document.body.innerHTML)
                        await policyChecks.drain()
                        policy.throwIfDenied()
                    } catch (error) {
                        scrapeError = error
                    }

                    let cleanupError: unknown
                    try {
                        if (browser) await browser.close()
                    } catch (error) {
                        cleanupError = error
                    }
                    policyChecks.beginClosing()
                    try {
                        await policyChecks.drain()
                    } catch (error) {
                        policy.record(error)
                        cleanupError ??= error
                    }
                    try {
                        await proxy.close()
                    } catch (error) {
                        cleanupError ??= error
                    }

                    if (scrapeError) {
                        policy.throwIfDenied()
                        throw scrapeError
                    }
                    if (cleanupError) {
                        policy.throwIfDenied()
                        throw cleanupError
                    }
                    policy.throwIfDenied()
                    if (html === undefined) {
                        throw new Error('Puppeteer scraper returned no content')
                    }
                    return html
                }
                if (textSplitter) {
                    docs = await loader.load()
                    docs = await textSplitter.splitDocuments(docs)
                } else {
                    docs = await loader.load()
                }
                return docs
            } catch (err) {
                if (isWebScraperPolicyError(err)) throw err
                options.logger.error(`[${orgId}]: Puppeteer web scraper failed`, err)
                throw new Error('Puppeteer web scraper failed')
            }
        }

        let docs: Document[] = []
        if (relativeLinksMethod) {
            if (process.env.DEBUG === 'true') options.logger.info(`[${orgId}]: Start PuppeteerWebBaseLoader ${relativeLinksMethod}`)
            // if limit is 0 we don't want it to default to 10 so we check explicitly for null or undefined
            // so when limit is 0 we can fetch all the links
            if (limit === null || limit === undefined) limit = 10
            else if (limit < 0) throw new Error('Limit cannot be less than 0')
            let pages: string[]
            if (selectedLinks && selectedLinks.length > 0) {
                pages = selectedLinks.slice(0, limit === 0 ? undefined : limit)
            } else {
                // Discovery is itself a network phase. Validate before it starts
                // and force the default deny list for every crawl/XML request.
                await assertWebScraperUrlAllowed(url)
                pages =
                    relativeLinksMethod === 'webCrawl'
                        ? await webCrawl(url, limit, WEB_SCRAPER_SECURE_FETCH_POLICY)
                        : await xmlScrape(url, limit, WEB_SCRAPER_SECURE_FETCH_POLICY)
            }
            if (process.env.DEBUG === 'true')
                options.logger.info(`[${orgId}]: PuppeteerWebBaseLoader pages: ${JSON.stringify(pages)}, length: ${pages.length}`)
            if (!pages || pages.length === 0) throw new Error('No relative links found')
            for (const page of pages) {
                const result = await puppeteerLoader(page)
                if (result) {
                    docs.push(...result)
                }
            }
            if (process.env.DEBUG === 'true') options.logger.info(`[${orgId}]: Finish PuppeteerWebBaseLoader ${relativeLinksMethod}`)
        } else if (selectedLinks && selectedLinks.length > 0) {
            if (process.env.DEBUG === 'true')
                options.logger.info(
                    `[${orgId}]: PuppeteerWebBaseLoader pages: ${JSON.stringify(selectedLinks)}, length: ${selectedLinks.length}`
                )
            for (const page of selectedLinks.slice(0, limit)) {
                const result = await puppeteerLoader(page)
                if (result) {
                    docs.push(...result)
                }
            }
        } else {
            const result = await puppeteerLoader(url)
            if (result) {
                docs.push(...result)
            }
        }

        if (metadata) {
            const parsedMetadata = typeof metadata === 'object' ? metadata : JSON.parse(metadata)
            docs = docs.map((doc) => ({
                ...doc,
                metadata:
                    _omitMetadataKeys === '*'
                        ? {
                              ...parsedMetadata
                          }
                        : omit(
                              {
                                  ...doc.metadata,
                                  ...parsedMetadata
                              },
                              omitMetadataKeys
                          )
            }))
        } else {
            docs = docs.map((doc) => ({
                ...doc,
                metadata:
                    _omitMetadataKeys === '*'
                        ? {}
                        : omit(
                              {
                                  ...doc.metadata
                              },
                              omitMetadataKeys
                          )
            }))
        }

        if (output === 'document') {
            return docs
        } else {
            let finaltext = ''
            for (const doc of docs) {
                finaltext += `${doc.pageContent}\n`
            }
            return handleEscapeCharacters(finaltext, false)
        }
    }
}

module.exports = { nodeClass: Puppeteer_DocumentLoaders }
