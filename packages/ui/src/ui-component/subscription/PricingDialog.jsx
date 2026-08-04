import accountApi from '@/api/account.api'
import apiKeyApi from '@/api/apikey'
import pricingApi from '@/api/pricing'
import userApi from '@/api/user'
import workspaceApi from '@/api/workspace'
import useApi from '@/hooks/useApi'
import { store } from '@/store'
import { upgradePlanSuccess } from '@/store/reducers/authSlice'
import { getErrorMessage } from '@/utils/getErrorMessage'
import {
    Box,
    Button,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Grid,
    IconButton,
    Typography
} from '@mui/material'
import { alpha, useTheme } from '@mui/material/styles'
import { IconAlertCircle, IconCheck, IconCreditCard, IconExternalLink, IconX } from '@tabler/icons-react'
import { useSnackbar } from 'notistack'
import PropTypes from 'prop-types'
import { useEffect, useMemo, useState } from 'react'
import { useSelector } from 'react-redux'

const pricingCopy = Object.freeze({
    Free: '免费版',
    Starter: '入门版',
    Pro: '专业版',
    Enterprise: '企业版',
    'For trying out the platform': '适合体验平台',
    'For individuals & small teams': '适合个人与小型团队',
    'For medium-sized businesses': '适合中型企业',
    'For large organizations': '适合大型组织',
    '/month': '/月',
    'Contact Us': '联系我们',
    '2 Flows & Assistants': '2 个流程或助手',
    '100 Predictions / month': '每月 100 次预测',
    '5MB Storage': '5 MB 存储空间',
    'Evaluations & Metrics': '评估与指标',
    'Custom Embedded Chatbot Branding': '自定义嵌入式聊天机器人品牌',
    'Community Support': '社区支持',
    'Everything in Free plan, plus': '包含免费版全部功能，另有',
    'Unlimited Flows & Assistants': '不限量流程与助手',
    '10,000 Predictions / month': '每月 10,000 次预测',
    '1GB Storage': '1 GB 存储空间',
    'Email Support': '邮件支持',
    'Everything in Starter plan, plus': '包含入门版全部功能，另有',
    '50,000 Predictions / month': '每月 50,000 次预测',
    '10GB Storage': '10 GB 存储空间',
    'Unlimited Workspaces': '不限量工作区',
    '5 users': '5 位用户',
    '+ $15/user/month': '+ 15 美元/用户/月',
    'Admin Roles & Permissions': '管理员角色与权限',
    'Priority Support': '优先支持',
    'On-Premise Deployment': '本地化部署',
    'Air-gapped Environments': '物理隔离环境',
    'SSO & SAML': 'SSO 与 SAML',
    'LDAP & RBAC': 'LDAP 与 RBAC',
    Versioning: '版本管理',
    'Audit Logs': '审计日志',
    '99.99% Uptime SLA': '99.99% 可用性 SLA',
    'Personalized Support': '专属支持'
})

const localizePricingCopy = (value, fallback = '暂未提供中文说明') => {
    if (typeof value !== 'string') return value
    if (Object.hasOwn(pricingCopy, value)) return pricingCopy[value]
    if (/[㐀-鿿]/u.test(value) || !/[A-Za-z]/.test(value)) return value
    return fallback
}

const PricingDialog = ({ open, onClose }) => {
    const customization = useSelector((state) => state.customization)
    const currentUser = useSelector((state) => state.auth.user)
    const theme = useTheme()
    const { enqueueSnackbar } = useSnackbar()

    const [openPlanDialog, setOpenPlanDialog] = useState(false)
    const [selectedPlan, setSelectedPlan] = useState(null)
    const [prorationInfo, setProrationInfo] = useState(null)
    const [isUpdatingPlan, setIsUpdatingPlan] = useState(false)
    const [purchasedSeats, setPurchasedSeats] = useState(0)
    const [occupiedSeats, setOccupiedSeats] = useState(0)
    const [workspaceCount, setWorkspaceCount] = useState(0)
    const [proAPIKeysCount, setProAPIKeysCount] = useState(0)
    const [isOpeningBillingPortal, setIsOpeningBillingPortal] = useState(false)

    const getPricingPlansApi = useApi(pricingApi.getPricingPlans)
    const getCustomerDefaultSourceApi = useApi(userApi.getCustomerDefaultSource)
    const getPlanProrationApi = useApi(userApi.getPlanProration)
    const getAdditionalSeatsQuantityApi = useApi(userApi.getAdditionalSeatsQuantity)
    const getAllWorkspacesApi = useApi(workspaceApi.getAllWorkspacesByOrganizationId)
    const getAllAPIKeysApi = useApi(apiKeyApi.getAllAPIKeys)

    useEffect(() => {
        getPricingPlansApi.request()
        getAdditionalSeatsQuantityApi.request(currentUser?.activeOrganizationSubscriptionId)

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const handlePlanClick = async (plan) => {
        if (plan.title === 'Enterprise') {
            window.location.href = 'mailto:hello@flowiseai.com'
            return
        }

        setSelectedPlan(plan)
        setOpenPlanDialog(true)
        getCustomerDefaultSourceApi.request(currentUser?.activeOrganizationCustomerId)
    }

    const handleBillingPortalClick = async () => {
        setIsOpeningBillingPortal(true)
        try {
            const response = await accountApi.getBillingData()
            if (response.data?.url) {
                setOpenPlanDialog(false)
                window.open(response.data.url, '_blank')
            } else {
                enqueueSnackbar('账单门户暂不可用，请稍后重试', { variant: 'error' })
            }
        } catch (error) {
            enqueueSnackbar(getErrorMessage(error, '无法打开账单门户，请稍后重试'), { variant: 'error' })
        } finally {
            setIsOpeningBillingPortal(false)
        }
    }

    const handleUpdatePlan = async () => {
        if (!selectedPlan || !prorationInfo) return

        setIsUpdatingPlan(true)
        try {
            const response = await userApi.updateSubscriptionPlan(
                currentUser.activeOrganizationSubscriptionId,
                selectedPlan.prodId,
                prorationInfo.prorationDate
            )
            if (response.data.status === 'success') {
                // Subscription updated successfully
                store.dispatch(upgradePlanSuccess(response.data.user))
                enqueueSnackbar('订阅方案已更新', { variant: 'success' })
                onClose(true)
            } else {
                const errorMessage = getErrorMessage({ response }, '订阅方案更新失败，请稍后重试')
                enqueueSnackbar(errorMessage, { variant: 'error' })
                onClose()
            }
        } catch (error) {
            const errorMessage = getErrorMessage(error, '无法验证订阅状态，请稍后重试')
            enqueueSnackbar(errorMessage, { variant: 'error' })
            onClose()
        } finally {
            setIsUpdatingPlan(false)
            setOpenPlanDialog(false)
        }
    }

    useEffect(() => {
        if (getAllWorkspacesApi.data) {
            setWorkspaceCount(getAllWorkspacesApi.data?.length || 0)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getAllWorkspacesApi.data])

    useEffect(() => {
        if (getAllAPIKeysApi.data) {
            if (getAllAPIKeysApi.data?.length > 0) {
                // Count API keys that have sharing permissions
                const sharingKeysCount = getAllAPIKeysApi.data.filter((apiKey) => {
                    return apiKey.permissions.includes('credentials:share') || apiKey.permissions.includes('templates:custom-share')
                }).length

                setProAPIKeysCount(sharingKeysCount)
            }
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getAllAPIKeysApi.data])

    useEffect(() => {
        if (
            getCustomerDefaultSourceApi.data &&
            getCustomerDefaultSourceApi.data?.invoice_settings?.default_payment_method &&
            currentUser?.activeOrganizationSubscriptionId
        ) {
            getPlanProrationApi.request(currentUser.activeOrganizationSubscriptionId, selectedPlan.prodId)
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getCustomerDefaultSourceApi.data])

    useEffect(() => {
        if (getPlanProrationApi.data) {
            setProrationInfo(getPlanProrationApi.data)
        }
    }, [getPlanProrationApi.data])

    useEffect(() => {
        if (getAdditionalSeatsQuantityApi.data) {
            const purchased = getAdditionalSeatsQuantityApi.data?.quantity || 0
            const occupied = getAdditionalSeatsQuantityApi.data?.totalOrgUsers || 1

            setPurchasedSeats(purchased)
            setOccupiedSeats(occupied)
        }
    }, [getAdditionalSeatsQuantityApi.data])

    const pricingPlans = useMemo(() => {
        if (!getPricingPlansApi.data) return []

        return getPricingPlansApi.data.map((plan) => {
            // Enterprise plan has special handling
            if (plan.title === 'Enterprise') {
                return {
                    ...plan,
                    buttonText: '联系我们',
                    buttonVariant: 'outlined',
                    buttonAction: () => handlePlanClick(plan)
                }
            }

            const isCurrentPlanValue = currentUser?.activeOrganizationProductId === plan.prodId
            const isStarterPlan = plan.title === 'Starter'

            if (isCurrentPlanValue && (plan.title === 'Pro' || plan.title === 'Enterprise')) {
                getAllWorkspacesApi.request(currentUser?.activeOrganizationId)
                getAllAPIKeysApi.request({ type: 'organization' })
            }

            return {
                ...plan,
                currentPlan: isCurrentPlanValue,
                isStarterPlan,
                buttonText: isCurrentPlanValue ? '当前方案' : '开始使用',
                buttonVariant: plan.mostPopular ? 'contained' : 'outlined',
                disabled: isCurrentPlanValue || !currentUser.isOrganizationAdmin,
                buttonAction: () => handlePlanClick(plan)
            }
        })

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [getPricingPlansApi.data, currentUser.isOrganizationAdmin])

    const handleClose = () => {
        if (!isUpdatingPlan) {
            setProrationInfo(null)
            onClose()
        }
    }

    const handlePlanDialogClose = () => {
        if (!isUpdatingPlan) {
            setProrationInfo(null)
            setOpenPlanDialog(false)
        }
    }

    return (
        <>
            <Dialog
                open={open}
                onClose={handleClose}
                maxWidth='lg'
                PaperProps={{
                    sx: {
                        borderRadius: 2,
                        backgroundColor: (theme) => theme.palette.background.default,
                        boxShadow: customization.isDarkMode ? '0 0 50px 0 rgba(255, 255, 255, 0.5)' : '0 0 10px 0 rgba(0, 0, 0, 0.1)'
                    }
                }}
            >
                <DialogTitle
                    sx={{
                        mt: 2,
                        p: 2,
                        display: 'flex',
                        justifyContent: 'center',
                        alignItems: 'center',
                        position: 'relative'
                    }}
                >
                    <Typography variant='h3'>订阅方案</Typography>
                    <IconButton
                        onClick={handleClose}
                        sx={{
                            position: 'absolute',
                            right: 8,
                            top: '50%',
                            transform: 'translateY(-50%)'
                        }}
                        disabled={isUpdatingPlan}
                        aria-label='关闭订阅方案'
                    >
                        <IconX />
                    </IconButton>
                </DialogTitle>
                <DialogContent>
                    <Grid container spacing={3} sx={{ p: 2 }}>
                        {pricingPlans.map((plan) => (
                            <Grid item xs={12} sm={6} md={3} key={plan.title}>
                                <Box
                                    sx={{
                                        p: 3,
                                        height: '100%',
                                        border: '2px solid',
                                        borderColor: (theme) =>
                                            plan.mostPopular
                                                ? theme.palette.primary.main
                                                : plan.currentPlan
                                                ? theme.palette.success.main
                                                : theme.palette.background.paper,
                                        borderRadius: 2,
                                        display: 'flex',
                                        flexDirection: 'column',
                                        minHeight: '450px',
                                        position: 'relative',
                                        boxShadow: customization.isDarkMode
                                            ? '0 0 10px 0 rgba(255, 255, 255, 0.5)'
                                            : '0 0 10px 0 rgba(0, 0, 0, 0.1)',
                                        backgroundColor: (theme) => (plan.currentPlan ? alpha(theme.palette.success.main, 0.05) : 'inherit')
                                    }}
                                >
                                    {plan.currentPlan && (
                                        <Box
                                            sx={{
                                                position: 'absolute',
                                                top: 12,
                                                right: 12,
                                                backgroundColor: 'success.dark',
                                                borderRadius: 1,
                                                px: 1,
                                                py: 0.5
                                            }}
                                        >
                                            <Typography sx={{ color: 'white' }} variant='caption' fontWeight='bold'>
                                                当前方案
                                            </Typography>
                                        </Box>
                                    )}
                                    {plan.mostPopular && !plan.currentPlan && (
                                        <Box
                                            sx={{
                                                position: 'absolute',
                                                top: 12,
                                                right: 12,
                                                backgroundColor: 'primary.main',
                                                borderRadius: 1,
                                                px: 1,
                                                py: 0.5
                                            }}
                                        >
                                            <Typography sx={{ color: 'white' }} variant='caption' fontWeight='bold'>
                                                最受欢迎
                                            </Typography>
                                        </Box>
                                    )}
                                    <Typography variant='h4' gutterBottom>
                                        {localizePricingCopy(plan.title)}
                                    </Typography>
                                    <Typography
                                        variant='body2'
                                        color='text.secondary'
                                        sx={{
                                            opacity: customization.isDarkMode ? 0.7 : 1
                                        }}
                                        gutterBottom
                                    >
                                        {localizePricingCopy(plan.subtitle)}
                                    </Typography>
                                    <Box sx={{ mb: 3 }}>
                                        <Typography variant='h3' component='span'>
                                            {localizePricingCopy(plan.price, '请咨询客服')}
                                        </Typography>
                                        {plan.period && (
                                            <Typography
                                                sx={{
                                                    opacity: customization.isDarkMode ? 0.7 : 1
                                                }}
                                                variant='body1'
                                                component='span'
                                                color='text.secondary'
                                            >
                                                {localizePricingCopy(plan.period)}
                                            </Typography>
                                        )}
                                    </Box>
                                    <Box sx={{ flexGrow: 1 }}>
                                        {plan.features.map((feature, index) => (
                                            <Box key={index} sx={{ display: 'flex', alignItems: 'start', mb: 1 }}>
                                                <IconCheck color={theme.palette.success.dark} size={15} style={{ marginRight: 8 }} />
                                                <Box>
                                                    <Typography variant='body1'>{localizePricingCopy(feature.text)}</Typography>
                                                    {feature.subtext && (
                                                        <Typography
                                                            sx={{
                                                                opacity: customization.isDarkMode ? 0.7 : 1
                                                            }}
                                                            variant='caption'
                                                            color='text.secondary'
                                                        >
                                                            {localizePricingCopy(feature.subtext)}
                                                        </Typography>
                                                    )}
                                                </Box>
                                            </Box>
                                        ))}
                                    </Box>
                                    {plan.isStarterPlan && !plan.currentPlan && (
                                        <Box
                                            sx={{
                                                mt: 1,
                                                mb: -1,
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center'
                                            }}
                                        >
                                            <Box
                                                sx={{
                                                    bgcolor: 'warning.light',
                                                    color: '#FF9800',
                                                    px: 2,
                                                    py: 0.5,
                                                    borderRadius: '16px',
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    fontWeight: 'bold',
                                                    fontSize: '0.9rem',
                                                    boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
                                                    position: 'relative'
                                                }}
                                            >
                                                首月免费
                                            </Box>
                                        </Box>
                                    )}
                                    <Button
                                        fullWidth
                                        variant={plan.buttonVariant}
                                        sx={{ mt: 3 }}
                                        onClick={plan.buttonAction}
                                        disabled={plan.disabled}
                                    >
                                        {plan.currentPlan ? '当前方案' : plan.buttonText}
                                    </Button>
                                </Box>
                            </Grid>
                        ))}
                    </Grid>
                </DialogContent>
            </Dialog>

            <Dialog fullWidth maxWidth='sm' open={openPlanDialog} onClose={handlePlanDialogClose}>
                <DialogTitle variant='h4'>确认更改订阅方案</DialogTitle>
                <DialogContent>
                    <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 3 }}>
                        {purchasedSeats > 0 || occupiedSeats > 1 ? (
                            <Typography
                                color='error'
                                sx={{
                                    p: 2,
                                    borderRadius: 1,
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 1
                                }}
                            >
                                <IconAlertCircle size={20} />
                                更改方案前，请先移除额外席位和用户。
                            </Typography>
                        ) : workspaceCount > 1 ? (
                            <>
                                <Typography
                                    color='error'
                                    sx={{
                                        p: 2,
                                        borderRadius: 1,
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 1
                                    }}
                                >
                                    <IconAlertCircle size={20} />
                                    更改方案前，请先移除默认工作区之外的所有工作区。
                                </Typography>
                            </>
                        ) : proAPIKeysCount > 0 ? (
                            <>
                                <Typography
                                    color='error'
                                    sx={{
                                        p: 2,
                                        borderRadius: 1,
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 1
                                    }}
                                >
                                    <IconAlertCircle size={20} />
                                    更改方案前，请先移除所有具有共享权限的 API 密钥。
                                </Typography>
                            </>
                        ) : (
                            <>
                                {getCustomerDefaultSourceApi.loading ? (
                                    <CircularProgress size={20} />
                                ) : getCustomerDefaultSourceApi.data?.invoice_settings?.default_payment_method ? (
                                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, p: 2 }}>
                                        <Typography variant='subtitle2'>付款方式</Typography>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                            {getCustomerDefaultSourceApi.data.invoice_settings.default_payment_method.card && (
                                                <>
                                                    <IconCreditCard size={20} stroke={1.5} color={theme.palette.primary.main} />
                                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                        <Typography sx={{ textTransform: 'capitalize' }}>
                                                            {
                                                                getCustomerDefaultSourceApi.data.invoice_settings.default_payment_method
                                                                    .card.brand
                                                            }
                                                        </Typography>
                                                        <Typography>
                                                            ••••{' '}
                                                            {
                                                                getCustomerDefaultSourceApi.data.invoice_settings.default_payment_method
                                                                    .card.last4
                                                            }
                                                        </Typography>
                                                        <Typography color='text.secondary'>
                                                            （有效期至{' '}
                                                            {
                                                                getCustomerDefaultSourceApi.data.invoice_settings.default_payment_method
                                                                    .card.exp_month
                                                            }
                                                            /
                                                            {
                                                                getCustomerDefaultSourceApi.data.invoice_settings.default_payment_method
                                                                    .card.exp_year
                                                            }
                                                            ）
                                                        </Typography>
                                                    </Box>
                                                </>
                                            )}
                                        </Box>
                                    </Box>
                                ) : (
                                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, p: 2 }}>
                                        <Typography color='error' sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                            <IconAlertCircle size={20} />
                                            未找到付款方式
                                        </Typography>
                                        <Button
                                            disabled={isOpeningBillingPortal}
                                            variant='contained'
                                            endIcon={!isOpeningBillingPortal && <IconExternalLink />}
                                            onClick={handleBillingPortalClick}
                                        >
                                            {isOpeningBillingPortal ? (
                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                                    <CircularProgress size={16} color='inherit' />
                                                    <span>正在打开账单门户…</span>
                                                </Box>
                                            ) : (
                                                '在账单门户中添加付款方式'
                                            )}
                                        </Button>
                                    </Box>
                                )}

                                {getPlanProrationApi.loading && (
                                    <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                        <CircularProgress size={16} />
                                    </Box>
                                )}

                                {prorationInfo && (
                                    <Box
                                        sx={{
                                            display: 'flex',
                                            flexDirection: 'column',
                                            gap: 2,
                                            backgroundColor: theme.palette.background.paper,
                                            borderRadius: 1,
                                            p: 2
                                        }}
                                    >
                                        {/* Date Range */}
                                        <Typography variant='body2' color='text.secondary'>
                                            {new Date(prorationInfo.currentPeriodStart * 1000).toLocaleDateString('zh-CN', {
                                                month: 'short',
                                                day: 'numeric'
                                            })}{' '}
                                            至{' '}
                                            {new Date(prorationInfo.currentPeriodEnd * 1000).toLocaleDateString('zh-CN', {
                                                month: 'short',
                                                day: 'numeric',
                                                year: 'numeric'
                                            })}
                                        </Typography>

                                        {/* First Month Free Notice */}
                                        {selectedPlan?.title === 'Starter' && prorationInfo.eligibleForFirstMonthFree && (
                                            <Box
                                                sx={{
                                                    p: 1.5,
                                                    bgcolor: 'warning.light',
                                                    color: 'warning.dark',
                                                    borderRadius: 1,
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    gap: 1,
                                                    fontWeight: 'medium'
                                                }}
                                            >
                                                <Typography variant='body2' fontWeight='bold'>
                                                    您符合首月免费条件！
                                                </Typography>
                                            </Box>
                                        )}

                                        {/* Base Plan */}
                                        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <Typography variant='body2'>{localizePricingCopy(selectedPlan.title)}方案</Typography>
                                            <Typography variant='body2'>
                                                {prorationInfo.currency} {Math.max(0, prorationInfo.newPlanAmount).toFixed(2)}
                                            </Typography>
                                        </Box>

                                        {selectedPlan?.title === 'Starter' && prorationInfo.eligibleForFirstMonthFree && (
                                            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                <Typography variant='body2'>首月优惠</Typography>
                                                <Typography variant='body2' color='success.main'>
                                                    -{prorationInfo.currency} {Math.max(0, prorationInfo.newPlanAmount).toFixed(2)}
                                                </Typography>
                                            </Box>
                                        )}

                                        {/* Credit Balance */}
                                        {prorationInfo.prorationAmount > 0 && prorationInfo.creditBalance !== 0 && (
                                            <Box
                                                sx={{
                                                    display: 'flex',
                                                    justifyContent: 'space-between',
                                                    alignItems: 'center'
                                                }}
                                            >
                                                <Typography variant='body2'>已抵扣账户余额</Typography>
                                                <Typography
                                                    variant='body2'
                                                    color={prorationInfo.creditBalance < 0 ? 'success.main' : 'error.main'}
                                                >
                                                    {prorationInfo.currency} {prorationInfo.creditBalance.toFixed(2)}
                                                </Typography>
                                            </Box>
                                        )}

                                        {prorationInfo.prorationAmount < 0 && (
                                            <Box
                                                sx={{
                                                    display: 'flex',
                                                    justifyContent: 'space-between',
                                                    alignItems: 'center'
                                                }}
                                            >
                                                <Typography variant='body2'>可用余额</Typography>
                                                <Typography
                                                    variant='body2'
                                                    color={prorationInfo.prorationAmount < 0 ? 'success.main' : 'error.main'}
                                                >
                                                    {prorationInfo.currency} {prorationInfo.prorationAmount < 0 ? '+' : ''}
                                                    {Math.abs(prorationInfo.prorationAmount).toFixed(2)}
                                                </Typography>
                                            </Box>
                                        )}

                                        {/* Next Payment */}
                                        <Box
                                            sx={{
                                                display: 'flex',
                                                justifyContent: 'space-between',
                                                alignItems: 'center',
                                                pt: 1.5,
                                                borderTop: `1px solid ${theme.palette.divider}`
                                            }}
                                        >
                                            <Typography variant='h5'>今日应付</Typography>
                                            <Typography variant='h5'>
                                                {prorationInfo.currency}{' '}
                                                {Math.max(0, prorationInfo.prorationAmount + prorationInfo.creditBalance).toFixed(2)}
                                            </Typography>
                                        </Box>

                                        {prorationInfo.prorationAmount < 0 && (
                                            <Typography
                                                variant='body2'
                                                sx={{
                                                    color: 'info.main',
                                                    fontStyle: 'italic'
                                                }}
                                            >
                                                可用余额将自动抵扣下一张账单。
                                            </Typography>
                                        )}
                                    </Box>
                                )}
                            </>
                        )}
                    </Box>
                </DialogContent>
                {getCustomerDefaultSourceApi.data?.invoice_settings?.default_payment_method && (
                    <DialogActions>
                        <Button onClick={handlePlanDialogClose} disabled={isUpdatingPlan}>
                            取消
                        </Button>
                        <Button
                            variant='contained'
                            onClick={handleUpdatePlan}
                            disabled={
                                getCustomerDefaultSourceApi.loading ||
                                !getCustomerDefaultSourceApi.data ||
                                getPlanProrationApi.loading ||
                                isUpdatingPlan ||
                                !prorationInfo ||
                                purchasedSeats > 0 ||
                                occupiedSeats > 1 ||
                                workspaceCount > 1 ||
                                proAPIKeysCount > 0
                            }
                        >
                            {isUpdatingPlan ? (
                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                    <CircularProgress size={16} color='inherit' />
                                    <span>正在更新方案…</span>
                                </Box>
                            ) : (
                                '确认更改'
                            )}
                        </Button>
                    </DialogActions>
                )}
            </Dialog>
        </>
    )
}

PricingDialog.propTypes = {
    open: PropTypes.bool,
    onClose: PropTypes.func
}

export default PricingDialog
