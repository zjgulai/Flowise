import {
    Button,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControl,
    InputLabel,
    MenuItem,
    Select,
    Step,
    StepLabel,
    Stepper,
    TextField
} from '@mui/material'
import axios from 'axios'
import PropTypes from 'prop-types'
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { getErrorMessage } from '@/utils/getErrorMessage'

const NvidiaNIMDialog = ({ open, onClose, onComplete }) => {
    const portalElement = document.getElementById('portal')

    const modelOptions = {
        'nvcr.io/nim/meta/llama-3.1-8b-instruct:1.8.0-RTX': {
            label: 'Llama 3.1 8B Instruct',
            licenseUrl: 'https://catalog.ngc.nvidia.com/orgs/nim/teams/meta/containers/llama-3.1-8b-instruct'
        },
        'nvcr.io/nim/deepseek-ai/deepseek-r1-distill-llama-8b:1.8.0-RTX': {
            label: 'DeepSeek R1 Distill Llama 8B',
            licenseUrl: 'https://catalog.ngc.nvidia.com/orgs/nim/teams/deepseek-ai/containers/deepseek-r1-distill-llama-8b'
        },
        'nvcr.io/nim/nv-mistralai/mistral-nemo-12b-instruct:1.8.0-rtx': {
            label: 'Mistral Nemo 12B Instruct',
            licenseUrl: 'https://catalog.ngc.nvidia.com/orgs/nim/teams/nv-mistralai/containers/mistral-nemo-12b-instruct'
        }
    }

    const [activeStep, setActiveStep] = useState(0)
    const [loading, setLoading] = useState(false)
    const [imageTag, setImageTag] = useState('')
    const [pollInterval, setPollInterval] = useState(null)
    const [nimRelaxMemConstraints, setNimRelaxMemConstraints] = useState('0')
    const [hostPort, setHostPort] = useState('8080')
    const [showContainerConfirm, setShowContainerConfirm] = useState(false)
    const [existingContainer, setExistingContainer] = useState(null)

    const steps = ['下载安装程序', '拉取镜像', '启动容器']

    const handleDownloadInstaller = async () => {
        try {
            setLoading(true)
            await axios.get('/api/v1/nvidia-nim/download-installer')
            setLoading(false)
        } catch (err) {
            alert(getErrorMessage(err, '下载安装程序失败，请稍后重试'))
            setLoading(false)
        }
    }

    const preload = async () => {
        try {
            setLoading(true)
            await axios.get('/api/v1/nvidia-nim/preload')
            setLoading(false)
            setActiveStep(1)
        } catch (err) {
            alert(getErrorMessage(err, '预加载失败，请稍后重试'))
            setLoading(false)
        }
    }

    const handlePullImage = async () => {
        try {
            setLoading(true)
            try {
                const imageResponse = await axios.post('/api/v1/nvidia-nim/get-image', { imageTag })
                if (imageResponse.data && imageResponse.data.tag === imageTag) {
                    setLoading(false)
                    setActiveStep(2)
                    return
                }
            } catch (err) {
                // Continue if image not found
                if (err.response?.status !== 404) {
                    throw err
                }
            }

            // Get token first
            const tokenResponse = await axios.get('/api/v1/nvidia-nim/get-token')
            const apiKey = tokenResponse.data.access_token

            // Pull image
            await axios.post('/api/v1/nvidia-nim/pull-image', {
                imageTag,
                apiKey
            })

            // Start polling for image status
            const interval = setInterval(async () => {
                try {
                    const imageResponse = await axios.post('/api/v1/nvidia-nim/get-image', { imageTag })
                    if (imageResponse.data) {
                        clearInterval(interval)
                        setLoading(false)
                        setActiveStep(2)
                    }
                } catch (err) {
                    // Continue polling if image not found
                    if (err.response?.status !== 404) {
                        clearInterval(interval)
                        alert(getErrorMessage(err, '检查镜像状态失败，请稍后重试'))
                        setLoading(false)
                    }
                }
            }, 5000)

            setPollInterval(interval)
        } catch (err) {
            alert(getErrorMessage(err, '拉取镜像失败，请稍后重试'))
            setLoading(false)
        }
    }

    const handleStartContainer = async () => {
        try {
            setLoading(true)
            try {
                const containerResponse = await axios.post('/api/v1/nvidia-nim/get-container', {
                    imageTag,
                    port: parseInt(hostPort)
                })
                if (containerResponse.data) {
                    setExistingContainer(containerResponse.data)
                    setShowContainerConfirm(true)
                    setLoading(false)
                    return
                }
            } catch (err) {
                // Handle port in use by non-model container
                if (err.response?.status === 409) {
                    alert(`端口 ${hostPort} 已被其他容器占用，请选择其他端口。`)
                    setLoading(false)
                    return
                }
                // Continue if container not found
                if (err.response?.status !== 404) {
                    throw err
                }
            }

            // No container found with this port, proceed with starting new container
            await startNewContainer()
        } catch (err) {
            alert(getErrorMessage(err, '检查容器状态失败，请稍后重试'))
            setLoading(false)
        }
    }

    const startNewContainer = async () => {
        try {
            setLoading(true)
            const tokenResponse = await axios.get('/api/v1/nvidia-nim/get-token')
            const apiKey = tokenResponse.data.access_token

            await axios.post('/api/v1/nvidia-nim/start-container', {
                imageTag,
                apiKey,
                nimRelaxMemConstraints: parseInt(nimRelaxMemConstraints),
                hostPort: parseInt(hostPort)
            })

            // Start polling for container status
            const interval = setInterval(async () => {
                try {
                    const containerResponse = await axios.post('/api/v1/nvidia-nim/get-container', {
                        imageTag,
                        port: parseInt(hostPort)
                    })
                    if (containerResponse.data) {
                        clearInterval(interval)
                        setLoading(false)
                        onComplete(containerResponse.data)
                        onClose()
                    }
                } catch (err) {
                    // Continue polling if container not found
                    if (err.response?.status !== 404) {
                        clearInterval(interval)
                        alert(getErrorMessage(err, '检查容器状态失败，请稍后重试'))
                        setLoading(false)
                    }
                }
            }, 5000)

            setPollInterval(interval)
        } catch (err) {
            alert(getErrorMessage(err, '启动容器失败，请稍后重试'))
            setLoading(false)
        }
    }

    const handleUseExistingContainer = async () => {
        try {
            setLoading(true)
            // Start polling for container status
            const interval = setInterval(async () => {
                try {
                    const containerResponse = await axios.post('/api/v1/nvidia-nim/get-container', {
                        imageTag,
                        port: parseInt(hostPort)
                    })
                    if (containerResponse.data) {
                        clearInterval(interval)
                        setLoading(false)
                        onComplete(containerResponse.data)
                        onClose()
                    }
                } catch (err) {
                    // Continue polling if container not found
                    if (err.response?.status !== 404) {
                        clearInterval(interval)
                        alert(getErrorMessage(err, '检查容器状态失败，请稍后重试'))
                        setLoading(false)
                    }
                }
            }, 5000)

            setPollInterval(interval)
        } catch (err) {
            alert(getErrorMessage(err, '检查容器状态失败，请稍后重试'))
            setLoading(false)
        }
    }

    const handleNext = () => {
        if (activeStep === 1 && !imageTag) {
            alert('请选择镜像')
            return
        }

        if (activeStep === 2) {
            const port = parseInt(hostPort)
            if (isNaN(port) || port < 1 || port > 65535) {
                alert('请输入 1 到 65535 之间的有效端口号')
                return
            }
        }

        switch (activeStep) {
            case 0:
                preload()
                break
            case 1:
                handlePullImage()
                break
            case 2:
                handleStartContainer()
                break
            default:
                setActiveStep((prev) => prev + 1)
        }
    }

    // Cleanup polling on unmount
    useEffect(() => {
        return () => {
            if (pollInterval) {
                clearInterval(pollInterval)
            }
        }
    }, [pollInterval])

    // clear state on close
    useEffect(() => {
        if (!open) {
            setActiveStep(0)
            setLoading(false)
            setImageTag('')
        }
    }, [open])

    const component = open ? (
        <>
            <Dialog open={open}>
                <DialogTitle>NIM 配置</DialogTitle>
                <DialogContent>
                    <Stepper activeStep={activeStep}>
                        {steps.map((label) => (
                            <Step key={label}>
                                <StepLabel>{label}</StepLabel>
                            </Step>
                        ))}
                    </Stepper>

                    {activeStep === 0 && (
                        <div style={{ marginTop: 20 }}>
                            <p style={{ marginBottom: 20 }}>是否需要下载 NIM 安装程序？若已安装，请点击“下一步”。</p>
                            {loading && <CircularProgress />}
                        </div>
                    )}

                    {activeStep === 1 && (
                        <div>
                            <FormControl fullWidth sx={{ mt: 2 }}>
                                <InputLabel>模型</InputLabel>
                                <Select label='模型' value={imageTag} onChange={(e) => setImageTag(e.target.value)}>
                                    {Object.entries(modelOptions).map(([value, { label }]) => (
                                        <MenuItem key={value} value={value}>
                                            {label}
                                        </MenuItem>
                                    ))}
                                </Select>
                            </FormControl>
                            {imageTag && (
                                <Button
                                    variant='text'
                                    size='small'
                                    sx={{ mt: 1 }}
                                    onClick={() => window.open(modelOptions[imageTag].licenseUrl, '_blank')}
                                >
                                    查看许可证
                                </Button>
                            )}
                            {loading && (
                                <div>
                                    <div style={{ marginBottom: 20 }} />
                                    <CircularProgress />
                                    <p>正在拉取镜像……</p>
                                </div>
                            )}
                        </div>
                    )}

                    {activeStep === 2 && (
                        <div>
                            {loading ? (
                                <>
                                    <div style={{ marginBottom: 20 }} />
                                    <CircularProgress />
                                    <p>正在启动容器……</p>
                                </>
                            ) : (
                                <>
                                    <FormControl fullWidth sx={{ mt: 2 }}>
                                        <InputLabel>放宽内存限制</InputLabel>
                                        <Select
                                            label='放宽内存限制'
                                            value={nimRelaxMemConstraints}
                                            onChange={(e) => setNimRelaxMemConstraints(e.target.value)}
                                        >
                                            <MenuItem value='1'>是</MenuItem>
                                            <MenuItem value='0'>否</MenuItem>
                                        </Select>
                                    </FormControl>
                                    <TextField
                                        fullWidth
                                        type='number'
                                        label='主机端口'
                                        value={hostPort}
                                        onChange={(e) => setHostPort(e.target.value)}
                                        inputProps={{ min: 1, max: 65535 }}
                                        sx={{ mt: 2 }}
                                    />
                                    <p style={{ marginTop: 20 }}>点击“下一步”启动容器。</p>
                                </>
                            )}
                        </div>
                    )}
                </DialogContent>
                <DialogActions>
                    <Button onClick={onClose} variant='outline'>
                        取消
                    </Button>
                    {activeStep === 0 && (
                        <Button onClick={handleNext} variant='outline' color='secondary'>
                            下一步
                        </Button>
                    )}
                    <Button
                        onClick={activeStep === 0 ? handleDownloadInstaller : handleNext}
                        disabled={loading || (activeStep === 2 && (!nimRelaxMemConstraints || !hostPort))}
                    >
                        {activeStep === 0 ? '下载' : '下一步'}
                    </Button>
                </DialogActions>
            </Dialog>
            <Dialog open={showContainerConfirm} onClose={() => setShowContainerConfirm(false)}>
                <DialogTitle>容器已存在</DialogTitle>
                <DialogContent>
                    <p>此镜像已有对应容器：</p>
                    <div>
                        <p>
                            <strong>名称：</strong> {existingContainer?.name || '未知'}
                        </p>
                        <p>
                            <strong>状态：</strong> {existingContainer?.status || '未知'}
                        </p>
                    </div>
                    <p>您可以：</p>
                    <ul>
                        <li>使用现有容器（推荐）</li>
                        <li>更换端口后重试</li>
                    </ul>
                </DialogContent>
                <DialogActions>
                    <Button
                        onClick={() => {
                            setShowContainerConfirm(false)
                            setExistingContainer(null)
                        }}
                    >
                        取消
                    </Button>
                    <Button
                        onClick={() => {
                            setShowContainerConfirm(false)
                            handleUseExistingContainer()
                        }}
                    >
                        使用现有容器
                    </Button>
                </DialogActions>
            </Dialog>
        </>
    ) : null

    return createPortal(component, portalElement)
}

NvidiaNIMDialog.propTypes = {
    open: PropTypes.bool,
    onClose: PropTypes.func,
    onComplete: PropTypes.func
}

export default NvidiaNIMDialog
