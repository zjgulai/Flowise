// TODO: add settings

import { Platform } from '../../Interface'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'
import { isAdminOnlyModeEnabled } from '../../enterprise/utils/adminOnlyPolicy'

const getSettings = async () => {
    const publicLoginEnabled = process.env.PUBLIC_LOGIN_ENABLED !== 'false'
    const adminOnlyMode = isAdminOnlyModeEnabled()
    const publicSettings = { PUBLIC_LOGIN_ENABLED: publicLoginEnabled, ADMIN_ONLY_MODE: adminOnlyMode }

    try {
        const appServer = getRunningExpressApp()
        const platformType = appServer.identityManager.getPlatformType()

        switch (platformType) {
            case Platform.ENTERPRISE: {
                if (!appServer.identityManager.isLicenseValid()) {
                    return publicSettings
                } else {
                    return { PLATFORM_TYPE: Platform.ENTERPRISE, ...publicSettings }
                }
            }
            case Platform.CLOUD: {
                return { PLATFORM_TYPE: Platform.CLOUD, ...publicSettings }
            }
            default: {
                return { PLATFORM_TYPE: Platform.OPEN_SOURCE, ...publicSettings }
            }
        }
    } catch (error) {
        return publicSettings
    }
}

export default {
    getSettings
}
