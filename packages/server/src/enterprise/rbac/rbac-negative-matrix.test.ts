/**
 * RBAC 负向权限矩阵测试套件
 *
 * 覆盖 PermissionCheck.ts 中 checkPermission / checkAnyPermission 的所有 403 拒绝场景。
 * 正向路径（next() 被调用）也包含，用于对比验证边界条件。
 */

import { Request, Response, NextFunction } from 'express'
import { checkPermission, checkAnyPermission } from './PermissionCheck'
import { ErrorMessage } from '../Interface.Enterprise'

// ---------------------------------------------------------------------------
// 辅助构建 mock request / response / next
// ---------------------------------------------------------------------------

type PartialUser = {
    isOrganizationAdmin?: boolean
    permissions?: string[]
}

function buildReq(user?: PartialUser): Request {
    return { user } as unknown as Request
}

function buildRes(): { res: Response; status: jest.Mock; json: jest.Mock } {
    const json = jest.fn().mockReturnThis()
    const status = jest.fn().mockReturnValue({ json })
    const res = { status } as unknown as Response
    return { res, status, json }
}

function buildNext(): NextFunction {
    return jest.fn()
}

// ---------------------------------------------------------------------------
// checkPermission
// ---------------------------------------------------------------------------

describe('checkPermission — 负向矩阵', () => {
    const REQUIRED = 'chatflows:delete'
    const UNRELATED = 'tools:view'

    describe('403 场景', () => {
        it('用户未登录（req.user = undefined）→ 返回 403', () => {
            const req = buildReq(undefined)
            const { res, status, json } = buildRes()
            const next = buildNext()

            checkPermission(REQUIRED)(req, res, next)

            expect(status).toHaveBeenCalledWith(403)
            expect(json).toHaveBeenCalledWith({ message: ErrorMessage.FORBIDDEN })
            expect(next).not.toHaveBeenCalled()
        })

        it('用户已登录但 permissions 为 undefined → 返回 403', () => {
            const req = buildReq({ isOrganizationAdmin: false, permissions: undefined })
            const { res, status, json } = buildRes()
            const next = buildNext()

            checkPermission(REQUIRED)(req, res, next)

            expect(status).toHaveBeenCalledWith(403)
            expect(json).toHaveBeenCalledWith({ message: ErrorMessage.FORBIDDEN })
            expect(next).not.toHaveBeenCalled()
        })

        it('用户已登录但 permissions 为空数组 → 返回 403', () => {
            const req = buildReq({ isOrganizationAdmin: false, permissions: [] })
            const { res, status, json } = buildRes()
            const next = buildNext()

            checkPermission(REQUIRED)(req, res, next)

            expect(status).toHaveBeenCalledWith(403)
            expect(json).toHaveBeenCalledWith({ message: ErrorMessage.FORBIDDEN })
            expect(next).not.toHaveBeenCalled()
        })

        it('用户有其他权限但缺少所需权限 → 返回 403', () => {
            const req = buildReq({ isOrganizationAdmin: false, permissions: [UNRELATED, 'credentials:view'] })
            const { res, status, json } = buildRes()
            const next = buildNext()

            checkPermission(REQUIRED)(req, res, next)

            expect(status).toHaveBeenCalledWith(403)
            expect(json).toHaveBeenCalledWith({ message: ErrorMessage.FORBIDDEN })
            expect(next).not.toHaveBeenCalled()
        })

        it('权限名称大小写不同（"Chatflows:Delete"）不满足精确匹配 → 返回 403', () => {
            const req = buildReq({ isOrganizationAdmin: false, permissions: ['Chatflows:Delete'] })
            const { res, status, json } = buildRes()
            const next = buildNext()

            checkPermission(REQUIRED)(req, res, next)

            expect(status).toHaveBeenCalledWith(403)
            expect(json).toHaveBeenCalledWith({ message: ErrorMessage.FORBIDDEN })
            expect(next).not.toHaveBeenCalled()
        })

        it('权限名称为前缀子串（"chatflows"）不匹配完整 key → 返回 403', () => {
            const req = buildReq({ isOrganizationAdmin: false, permissions: ['chatflows'] })
            const { res, status, json } = buildRes()
            const next = buildNext()

            checkPermission(REQUIRED)(req, res, next)

            expect(status).toHaveBeenCalledWith(403)
            expect(json).toHaveBeenCalledWith({ message: ErrorMessage.FORBIDDEN })
            expect(next).not.toHaveBeenCalled()
        })

        it('isOrganizationAdmin = false，即使有其他很多权限但缺目标权限 → 返回 403', () => {
            const req = buildReq({
                isOrganizationAdmin: false,
                permissions: ['chatflows:view', 'chatflows:create', 'chatflows:update', 'chatflows:export']
            })
            const { res, status, json } = buildRes()
            const next = buildNext()

            checkPermission(REQUIRED)(req, res, next)

            expect(status).toHaveBeenCalledWith(403)
            expect(json).toHaveBeenCalledWith({ message: ErrorMessage.FORBIDDEN })
            expect(next).not.toHaveBeenCalled()
        })
    })

    describe('通过场景（对比验证边界）', () => {
        it('isOrganizationAdmin = true 时无需任何权限 → next() 被调用', () => {
            const req = buildReq({ isOrganizationAdmin: true, permissions: [] })
            const { res, status } = buildRes()
            const next = buildNext()

            checkPermission(REQUIRED)(req, res, next)

            expect(next).toHaveBeenCalledTimes(1)
            expect(status).not.toHaveBeenCalled()
        })

        it('用户持有精确权限字符串 → next() 被调用', () => {
            const req = buildReq({ isOrganizationAdmin: false, permissions: [REQUIRED] })
            const { res, status } = buildRes()
            const next = buildNext()

            checkPermission(REQUIRED)(req, res, next)

            expect(next).toHaveBeenCalledTimes(1)
            expect(status).not.toHaveBeenCalled()
        })
    })
})

// ---------------------------------------------------------------------------
// checkAnyPermission
// ---------------------------------------------------------------------------

describe('checkAnyPermission — 负向矩阵', () => {
    const PERM_A = 'chatflows:delete'
    const PERM_B = 'tools:create'
    const PERM_C = 'credentials:share'
    const REQUIRED_ANY = `${PERM_A},${PERM_B},${PERM_C}`

    describe('403 场景', () => {
        it('用户未登录（req.user = undefined）→ 返回 403', () => {
            const req = buildReq(undefined)
            const { res, status, json } = buildRes()
            const next = buildNext()

            checkAnyPermission(REQUIRED_ANY)(req, res, next)

            expect(status).toHaveBeenCalledWith(403)
            expect(json).toHaveBeenCalledWith({ message: ErrorMessage.FORBIDDEN })
            expect(next).not.toHaveBeenCalled()
        })

        it('用户已登录但 permissions = undefined → 返回 403', () => {
            const req = buildReq({ isOrganizationAdmin: false, permissions: undefined })
            const { res, status, json } = buildRes()
            const next = buildNext()

            checkAnyPermission(REQUIRED_ANY)(req, res, next)

            expect(status).toHaveBeenCalledWith(403)
            expect(json).toHaveBeenCalledWith({ message: ErrorMessage.FORBIDDEN })
            expect(next).not.toHaveBeenCalled()
        })

        it('用户 permissions 为空数组 → 返回 403', () => {
            const req = buildReq({ isOrganizationAdmin: false, permissions: [] })
            const { res, status, json } = buildRes()
            const next = buildNext()

            checkAnyPermission(REQUIRED_ANY)(req, res, next)

            expect(status).toHaveBeenCalledWith(403)
            expect(json).toHaveBeenCalledWith({ message: ErrorMessage.FORBIDDEN })
            expect(next).not.toHaveBeenCalled()
        })

        it('用户只有不相关权限，三个候选均不匹配 → 返回 403', () => {
            const req = buildReq({
                isOrganizationAdmin: false,
                permissions: ['variables:view', 'assistants:view', 'workspace:view']
            })
            const { res, status, json } = buildRes()
            const next = buildNext()

            checkAnyPermission(REQUIRED_ANY)(req, res, next)

            expect(status).toHaveBeenCalledWith(403)
            expect(json).toHaveBeenCalledWith({ message: ErrorMessage.FORBIDDEN })
            expect(next).not.toHaveBeenCalled()
        })

        it('单一候选权限串，用户持有错误大小写版本 → 返回 403', () => {
            const req = buildReq({ isOrganizationAdmin: false, permissions: ['Chatflows:Delete'] })
            const { res, status, json } = buildRes()
            const next = buildNext()

            checkAnyPermission(PERM_A)(req, res, next)

            expect(status).toHaveBeenCalledWith(403)
            expect(json).toHaveBeenCalledWith({ message: ErrorMessage.FORBIDDEN })
            expect(next).not.toHaveBeenCalled()
        })

        it('候选权限串仅包含空格（" "），用户无权限 → 返回 403', () => {
            // 空格作为权限 id 无效，数组 includes 不匹配任何真实权限
            const req = buildReq({ isOrganizationAdmin: false, permissions: ['chatflows:delete'] })
            const { res, status, json } = buildRes()
            const next = buildNext()

            checkAnyPermission(' ')(req, res, next)

            expect(status).toHaveBeenCalledWith(403)
            expect(json).toHaveBeenCalledWith({ message: ErrorMessage.FORBIDDEN })
            expect(next).not.toHaveBeenCalled()
        })

        it('isOrganizationAdmin = false 且持有所有候选以外权限 → 返回 403', () => {
            const req = buildReq({
                isOrganizationAdmin: false,
                permissions: [
                    'chatflows:view',
                    'chatflows:create',
                    'chatflows:update',
                    'tools:view',
                    'tools:update',
                    'tools:delete',
                    'credentials:view',
                    'credentials:create'
                ]
            })
            const { res, status, json } = buildRes()
            const next = buildNext()

            // 需要 delete / tools:create / credentials:share，用户都没有
            checkAnyPermission(REQUIRED_ANY)(req, res, next)

            expect(status).toHaveBeenCalledWith(403)
            expect(json).toHaveBeenCalledWith({ message: ErrorMessage.FORBIDDEN })
            expect(next).not.toHaveBeenCalled()
        })
    })

    describe('通过场景（对比验证边界）', () => {
        it('isOrganizationAdmin = true → next() 被调用', () => {
            const req = buildReq({ isOrganizationAdmin: true, permissions: [] })
            const { res, status } = buildRes()
            const next = buildNext()

            checkAnyPermission(REQUIRED_ANY)(req, res, next)

            expect(next).toHaveBeenCalledTimes(1)
            expect(status).not.toHaveBeenCalled()
        })

        it('用户持有候选列表中第一个权限 → next() 被调用', () => {
            const req = buildReq({ isOrganizationAdmin: false, permissions: [PERM_A] })
            const { res, status } = buildRes()
            const next = buildNext()

            checkAnyPermission(REQUIRED_ANY)(req, res, next)

            expect(next).toHaveBeenCalledTimes(1)
            expect(status).not.toHaveBeenCalled()
        })

        it('用户持有候选列表中最后一个权限 → next() 被调用', () => {
            const req = buildReq({ isOrganizationAdmin: false, permissions: [PERM_C] })
            const { res, status } = buildRes()
            const next = buildNext()

            checkAnyPermission(REQUIRED_ANY)(req, res, next)

            expect(next).toHaveBeenCalledTimes(1)
            expect(status).not.toHaveBeenCalled()
        })

        it('单一候选权限串，用户精确匹配 → next() 被调用', () => {
            const req = buildReq({ isOrganizationAdmin: false, permissions: [PERM_B] })
            const { res, status } = buildRes()
            const next = buildNext()

            checkAnyPermission(PERM_B)(req, res, next)

            expect(next).toHaveBeenCalledTimes(1)
            expect(status).not.toHaveBeenCalled()
        })
    })
})

// ---------------------------------------------------------------------------
// 边界：response 的 status().json() 链式调用只发生一次
// ---------------------------------------------------------------------------

describe('checkPermission — 响应只发送一次', () => {
    it('403 时 status 被调用恰好一次', () => {
        const req = buildReq({ isOrganizationAdmin: false, permissions: [] })
        const { res, status, json } = buildRes()
        const next = buildNext()

        checkPermission('chatflows:delete')(req, res, next)

        expect(status).toHaveBeenCalledTimes(1)
        expect(json).toHaveBeenCalledTimes(1)
    })
})

describe('checkAnyPermission — 响应只发送一次', () => {
    it('403 时 status 被调用恰好一次', () => {
        const req = buildReq({ isOrganizationAdmin: false, permissions: [] })
        const { res, status, json } = buildRes()
        const next = buildNext()

        checkAnyPermission('chatflows:delete,tools:create')(req, res, next)

        expect(status).toHaveBeenCalledTimes(1)
        expect(json).toHaveBeenCalledTimes(1)
    })
})
