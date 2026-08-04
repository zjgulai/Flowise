import { getPermissionDisplayLabel, permissionCategoryLabels, permissionValueLabels } from './permissionLabels'

describe('API key permission labels', () => {
    it('renders common and specialized permission keys in Chinese', () => {
        expect(getPermissionDisplayLabel('chatflows:view')).toBe('聊天流：查看')
        expect(getPermissionDisplayLabel('documentStores:preview-process')).toBe('文档库：预览并处理文档分块')
        expect(getPermissionDisplayLabel('templates:custom-share')).toBe('模板：分享自定义模板')
    })

    it('fails closed when a permission key is malformed or has not been mapped', () => {
        expect(getPermissionDisplayLabel()).toBe('未知权限')
        expect(getPermissionDisplayLabel('chatflows')).toBe('未知权限')
        expect(getPermissionDisplayLabel('newFeature:view')).toBe('未知权限（newFeature:view）')
        expect(getPermissionDisplayLabel('chatflows:manage')).toBe('未知权限（chatflows:manage）')
    })

    it('shares the same category and value labels with the edit dialog', () => {
        expect(permissionCategoryLabels.apikeys).toBe('API 密钥')
        expect(permissionValueLabels['Allowed Domains']).toBe('允许的域名')
    })
})
