import { Request, Response, NextFunction } from 'express'
import agentflowv2Service from '../../services/agentflowv2-generator'
import { InternalFlowiseError } from '../../errors/internalFlowiseError'
import { StatusCodes } from 'http-status-codes'

const MAX_AGENTFLOW_QUESTION_LENGTH = 10_000
const INVALID_AGENTFLOW_REQUEST = 'Invalid Agentflow generation request'

const generateAgentflowv2 = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const workspaceId = req.user?.activeWorkspaceId
        if (!workspaceId) throw new InternalFlowiseError(StatusCodes.FORBIDDEN, 'Agentflow generation is not authorized')

        const question = req.body?.question
        const selectedChatModel = req.body?.selectedChatModel
        const normalizedQuestion = typeof question === 'string' ? question.trim() : ''
        if (
            !normalizedQuestion ||
            normalizedQuestion.length > MAX_AGENTFLOW_QUESTION_LENGTH ||
            !selectedChatModel ||
            typeof selectedChatModel !== 'object' ||
            Array.isArray(selectedChatModel)
        ) {
            throw new InternalFlowiseError(StatusCodes.BAD_REQUEST, INVALID_AGENTFLOW_REQUEST)
        }

        const apiResponse = await agentflowv2Service.generateAgentflowv2(normalizedQuestion, selectedChatModel, workspaceId)
        return res.json(apiResponse)
    } catch (error) {
        next(error)
    }
}

export default {
    generateAgentflowv2
}
