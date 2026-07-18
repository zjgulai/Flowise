// TODO: add settings

import { Platform } from '../../Interface'
import { getRunningExpressApp } from '../../utils/getRunningExpressApp'

const getSettings = async () => {
    const publicLoginEnabled = process.env.PUBLIC_LOGIN_ENABLED !== 'false'

    try {
        const appServer = getRunningExpressApp()
        const platformType = appServer.identityManager.getPlatformType()

        switch (platformType) {
            case Platform.ENTERPRISE: {
                if (!appServer.identityManager.isLicenseValid()) {
                    return { PUBLIC_LOGIN_ENABLED: publicLoginEnabled }
                } else {
                    return { PLATFORM_TYPE: Platform.ENTERPRISE, PUBLIC_LOGIN_ENABLED: publicLoginEnabled }
                }
            }
            case Platform.CLOUD: {
                return { PLATFORM_TYPE: Platform.CLOUD, PUBLIC_LOGIN_ENABLED: publicLoginEnabled }
            }
            default: {
                return { PLATFORM_TYPE: Platform.OPEN_SOURCE, PUBLIC_LOGIN_ENABLED: publicLoginEnabled }
            }
        }
    } catch (error) {
        return { PUBLIC_LOGIN_ENABLED: publicLoginEnabled }
    }
}

export default {
    getSettings
}
