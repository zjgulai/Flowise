import fs from 'fs'
import path from 'path'

describe('document store route security order', () => {
    const routeSource = fs.readFileSync(path.join(__dirname, 'index.ts'), 'utf8')
    const controllerSource = fs.readFileSync(path.join(__dirname, '../../controllers/documentstore/index.ts'), 'utf8')

    it('authorizes upsert before invoking multipart parsing', () => {
        const routeStart = routeSource.indexOf("['/upsert/', '/upsert/:id']")
        const routeEnd = routeSource.indexOf('documentStoreController.upsertDocStoreMiddleware', routeStart)
        const upsertRoute = routeSource.slice(routeStart, routeEnd)

        expect(routeStart).toBeGreaterThan(-1)
        expect(upsertRoute.indexOf("checkPermission('documentStores:upsert-config')")).toBeGreaterThan(-1)
        expect(upsertRoute.indexOf("checkPermission('documentStores:upsert-config')")).toBeLessThan(
            upsertRoute.indexOf("getMulterStorage().array('files')")
        )
    })

    it('requires create authority in addition to upsert authority for create-new uploads', () => {
        const permissionGuardStart = controllerSource.indexOf('const assertDocumentStoreUpsertPermission')
        const permissionGuard = controllerSource.slice(permissionGuardStart, permissionGuardStart + 700)
        const upsertStart = controllerSource.indexOf('const upsertDocStoreMiddleware')
        const upsertController = controllerSource.slice(upsertStart, upsertStart + 2200)

        expect(permissionGuard).toContain("hasDocumentStorePermission(req, 'documentStores:upsert-config')")
        expect(permissionGuard).toContain("hasDocumentStorePermission(req, 'documentStores:create')")
        expect(upsertController).toContain('assertDocumentStoreUpsertPermission(req, files, createNewDocStore)')
    })

    it('requires credential view in addition to document-store edit authority before Provider-backed description generation', () => {
        const routeStart = routeSource.indexOf("'/generate-tool-desc/:id'")
        const routeEnd = routeSource.indexOf('documentStoreController.generateDocStoreToolDesc', routeStart)
        const route = routeSource.slice(routeStart, routeEnd)

        expect(routeStart).toBeGreaterThan(-1)
        expect(route).toContain("checkPermission('documentStores:upsert-config')")
        expect(route).toContain("checkPermission('credentials:view')")
    })
})
