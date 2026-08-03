import { StatusCodes } from 'http-status-codes'
import { EnumChatflowType } from '../../database/entities/ChatFlow'
import {
    getPermittedChatflowTypes,
    requireGenericChatflowType,
    requirePermittedChatflowType,
    stripGenericChatflowServerState
} from './accessControl'

describe('chatflow type access control', () => {
    it('maps Chatflow and both Agentflow types to separate permission resources', () => {
        expect(getPermittedChatflowTypes(['chatflows:view'], false, 'view')).toEqual([EnumChatflowType.CHATFLOW])
        expect(getPermittedChatflowTypes(['agentflows:view'], false, 'view')).toEqual([
            EnumChatflowType.AGENTFLOW,
            EnumChatflowType.MULTIAGENT
        ])
    })

    it('allows organization admins only the three generic flow types', () => {
        expect(getPermittedChatflowTypes([], true, 'config')).toEqual([
            EnumChatflowType.CHATFLOW,
            EnumChatflowType.AGENTFLOW,
            EnumChatflowType.MULTIAGENT
        ])
    })

    it('rejects Assistant flows from generic endpoints', () => {
        expect(() => requireGenericChatflowType(EnumChatflowType.ASSISTANT)).toThrow(
            expect.objectContaining({ statusCode: StatusCodes.FORBIDDEN })
        )
    })

    it('rejects unknown flow types as bad requests', () => {
        expect(() => requireGenericChatflowType('UNKNOWN')).toThrow(expect.objectContaining({ statusCode: StatusCodes.BAD_REQUEST }))
    })

    it('rejects a valid but unauthorized cross-type operation', () => {
        expect(() => requirePermittedChatflowType(EnumChatflowType.AGENTFLOW, [EnumChatflowType.CHATFLOW])).toThrow(
            expect.objectContaining({ statusCode: StatusCodes.FORBIDDEN })
        )
    })

    it('removes MCP and webhook server state without touching ordinary fields', () => {
        const flow = {
            id: 'flow-1',
            name: 'Safe',
            flowData: '{}',
            workspaceId: 'workspace-1',
            mcpServerConfig: '{"token":"secret"}',
            webhookSecret: 'secret',
            webhookSecretConfigured: true
        } as any

        expect(stripGenericChatflowServerState(flow)).toEqual({
            id: 'flow-1',
            name: 'Safe',
            flowData: '{}',
            workspaceId: 'workspace-1'
        })
    })
})
