import { INodeCredential, INodeParams } from '../src/Interface'

class KimiApi implements INodeCredential {
    label: string
    name: string
    version: number
    inputs: INodeParams[]

    constructor() {
        this.label = 'Kimi (Moonshot) API'
        this.name = 'kimiApi'
        this.version = 1.0
        this.inputs = [
            {
                label: 'Kimi API Key',
                name: 'kimiApiKey',
                type: 'password'
            }
        ]
    }
}

module.exports = { credClass: KimiApi }
