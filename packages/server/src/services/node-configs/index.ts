import { StatusCodes } from 'http-status-codes'
import { findAvailableConfigs } from '../../utils'
import { IReactFlowNode } from '../../Interface'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { getErrorMessage } from '../../errors/utils'
import { decorateComponentCredentials } from '../component-metadata-localization'

const getAllNodeConfigs = async (requestBody: any) => {
    try {
        const appServer = getRunningExpressApp()
        const nodes = [{ data: requestBody }] as IReactFlowNode[]
        const dbResponse = findAvailableConfigs(nodes, decorateComponentCredentials(appServer.nodesPool.componentCredentials))
        return dbResponse
    } catch (error) {
        throw new InternalFlowiseError(
            StatusCodes.INTERNAL_SERVER_ERROR,
            `Error: nodeConfigsService.getAllNodeConfigs - ${getErrorMessage(error)}`
        )
    }
}

export default {
    getAllNodeConfigs
}
