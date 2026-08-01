import { useDispatch } from 'react-redux'
import { useState, useEffect } from 'react'
import PropTypes from 'prop-types'
import { useSelector } from 'react-redux'

// material-ui
import {
    IconButton,
    Button,
    Box,
    Typography,
    TableContainer,
    Table,
    TableHead,
    TableBody,
    TableRow,
    TableCell,
    Paper,
    Accordion,
    AccordionSummary,
    AccordionDetails,
    Card
} from '@mui/material'
import { IconArrowsMaximize, IconX } from '@tabler/icons-react'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import { useTheme } from '@mui/material/styles'

// Project import
import { StyledButton } from '@/ui-component/button/StyledButton'
import { SwitchInput } from '@/ui-component/switch/Switch'
import { CodeEditor } from '@/ui-component/editor/CodeEditor'
import ExpandTextDialog from '@/ui-component/dialog/ExpandTextDialog'

// store
import { enqueueSnackbar as enqueueSnackbarAction, closeSnackbar as closeSnackbarAction, SET_CHATFLOW } from '@/store/actions'
import useNotifier from '@/utils/useNotifier'
import { getErrorMessage } from '@/utils/getErrorMessage'

// API
import chatflowsApi from '@/api/chatflows'

const sampleFunction = `// 将对话历史读取为字符串
const chatHistory = JSON.stringify($flow.chatHistory, null, 2); 

// 返回处理后的响应
return $flow.rawOutput + " 这是经过后处理的响应！";`

const PostProcessing = ({ dialogProps }) => {
    const dispatch = useDispatch()

    useNotifier()
    const theme = useTheme()
    const customization = useSelector((state) => state.customization)

    const enqueueSnackbar = (...args) => dispatch(enqueueSnackbarAction(...args))
    const closeSnackbar = (...args) => dispatch(closeSnackbarAction(...args))

    const [postProcessingEnabled, setPostProcessingEnabled] = useState(false)
    const [postProcessingFunction, setPostProcessingFunction] = useState('')
    const [chatbotConfig, setChatbotConfig] = useState({})
    const [showExpandDialog, setShowExpandDialog] = useState(false)
    const [expandDialogProps, setExpandDialogProps] = useState({})

    const handleChange = (value) => {
        setPostProcessingEnabled(value)
    }

    const onExpandDialogClicked = (value) => {
        const dialogProps = {
            value,
            inputParam: {
                label: '后处理函数',
                name: 'postProcessingFunction',
                type: 'code',
                placeholder: sampleFunction,
                hideCodeExecute: true
            },
            languageType: 'js',
            confirmButtonName: '保存',
            cancelButtonName: '取消'
        }
        setExpandDialogProps(dialogProps)
        setShowExpandDialog(true)
    }

    const onSave = async () => {
        try {
            let value = {
                postProcessing: {
                    enabled: postProcessingEnabled,
                    customFunction: JSON.stringify(postProcessingFunction)
                }
            }
            chatbotConfig.postProcessing = value.postProcessing
            const saveResp = await chatflowsApi.updateChatflow(dialogProps.chatflow.id, {
                chatbotConfig: JSON.stringify(chatbotConfig)
            })
            if (saveResp.data) {
                enqueueSnackbar({
                    message: '后处理设置已保存',
                    options: {
                        key: new Date().getTime() + Math.random(),
                        variant: 'success',
                        action: (key) => (
                            <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                                <IconX />
                            </Button>
                        )
                    }
                })
                dispatch({ type: SET_CHATFLOW, chatflow: saveResp.data })
            }
        } catch (error) {
            enqueueSnackbar({
                message: `保存后处理设置失败：${getErrorMessage(error, '未知错误')}`,
                options: {
                    key: new Date().getTime() + Math.random(),
                    variant: 'error',
                    persist: true,
                    action: (key) => (
                        <Button style={{ color: 'white' }} onClick={() => closeSnackbar(key)}>
                            <IconX />
                        </Button>
                    )
                }
            })
        }
    }

    useEffect(() => {
        if (dialogProps.chatflow && dialogProps.chatflow.chatbotConfig) {
            let chatbotConfig = JSON.parse(dialogProps.chatflow.chatbotConfig)
            setChatbotConfig(chatbotConfig || {})
            if (chatbotConfig.postProcessing) {
                setPostProcessingEnabled(chatbotConfig.postProcessing.enabled)
                if (chatbotConfig.postProcessing.customFunction) {
                    setPostProcessingFunction(JSON.parse(chatbotConfig.postProcessing.customFunction))
                }
            }
        }

        return () => {}
    }, [dialogProps])

    return (
        <>
            <Box sx={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
                <SwitchInput label='启用后处理' onChange={handleChange} value={postProcessingEnabled} />
            </Box>
            <Box sx={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1 }}>
                <Box sx={{ width: '100%', display: 'flex', alignItems: 'center' }}>
                    <Typography>脚本函数</Typography>
                    <Button
                        sx={{ ml: 2 }}
                        variant='outlined'
                        onClick={() => {
                            setPostProcessingFunction(sampleFunction)
                        }}
                    >
                        查看示例
                    </Button>
                    <div style={{ flex: 1 }} />
                    <IconButton
                        size='small'
                        sx={{
                            height: 25,
                            width: 25
                        }}
                        title='展开'
                        color='primary'
                        onClick={() => onExpandDialogClicked(postProcessingFunction)}
                    >
                        <IconArrowsMaximize />
                    </IconButton>
                </Box>

                <div
                    style={{
                        marginTop: '10px',
                        border: '1px solid',
                        borderColor: customization.isDarkMode ? 'rgba(255,255,255,0.12)' : theme.palette.grey['300'],
                        borderRadius: '6px',
                        height: '200px',
                        width: '100%'
                    }}
                >
                    <CodeEditor
                        value={postProcessingFunction}
                        height='200px'
                        theme={customization.isDarkMode ? 'dark' : 'light'}
                        lang={'js'}
                        placeholder={sampleFunction}
                        onValueChange={(code) => setPostProcessingFunction(code)}
                        basicSetup={{ highlightActiveLine: false, highlightActiveLineGutter: false }}
                    />
                </div>
            </Box>
            <Card
                elevation={0}
                sx={{
                    borderRadius: '8px',
                    border: '1px solid',
                    borderColor: customization.isDarkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)',
                    mt: 2,
                    mb: 2
                }}
            >
                <Accordion
                    disableGutters
                    sx={{
                        '&:before': {
                            display: 'none'
                        }
                    }}
                >
                    <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                        <Typography sx={{ fontSize: '0.875rem', fontWeight: 500 }}>可用变量</Typography>
                    </AccordionSummary>
                    <AccordionDetails sx={{ p: 0 }}>
                        <TableContainer component={Paper} elevation={0} sx={{ boxShadow: 'none', bgcolor: 'transparent' }}>
                            <Table size='small' aria-label='可用变量表'>
                                <TableHead>
                                    <TableRow>
                                        <TableCell
                                            sx={{
                                                width: '30%',
                                                fontSize: '0.8125rem',
                                                fontWeight: 600,
                                                color: 'text.secondary',
                                                py: 1.5,
                                                borderColor: customization.isDarkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)'
                                            }}
                                        >
                                            变量
                                        </TableCell>
                                        <TableCell
                                            sx={{
                                                width: '15%',
                                                fontSize: '0.8125rem',
                                                fontWeight: 600,
                                                color: 'text.secondary',
                                                py: 1.5,
                                                borderColor: customization.isDarkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)'
                                            }}
                                        >
                                            类型
                                        </TableCell>
                                        <TableCell
                                            sx={{
                                                width: '55%',
                                                fontSize: '0.8125rem',
                                                fontWeight: 600,
                                                color: 'text.secondary',
                                                py: 1.5,
                                                borderColor: customization.isDarkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)'
                                            }}
                                        >
                                            说明
                                        </TableCell>
                                    </TableRow>
                                </TableHead>
                                <TableBody
                                    sx={{
                                        '& td': {
                                            fontSize: '0.8rem',
                                            py: 1.5,
                                            borderColor: customization.isDarkMode ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)'
                                        },
                                        '& tr:last-child td': { border: 0 }
                                    }}
                                >
                                    <TableRow>
                                        <TableCell>
                                            <code>$flow.rawOutput</code>
                                        </TableCell>
                                        <TableCell>字符串</TableCell>
                                        <TableCell>流程的原始输出响应</TableCell>
                                    </TableRow>
                                    <TableRow>
                                        <TableCell>
                                            <code>$flow.input</code>
                                        </TableCell>
                                        <TableCell>字符串</TableCell>
                                        <TableCell>用户输入消息</TableCell>
                                    </TableRow>
                                    <TableRow>
                                        <TableCell>
                                            <code>$flow.chatHistory</code>
                                        </TableCell>
                                        <TableCell>数组</TableCell>
                                        <TableCell>对话中的历史消息数组</TableCell>
                                    </TableRow>
                                    <TableRow>
                                        <TableCell>
                                            <code>$flow.chatflowId</code>
                                        </TableCell>
                                        <TableCell>字符串</TableCell>
                                        <TableCell>对话流程的唯一标识</TableCell>
                                    </TableRow>
                                    <TableRow>
                                        <TableCell>
                                            <code>$flow.sessionId</code>
                                        </TableCell>
                                        <TableCell>字符串</TableCell>
                                        <TableCell>当前会话标识</TableCell>
                                    </TableRow>
                                    <TableRow>
                                        <TableCell>
                                            <code>$flow.chatId</code>
                                        </TableCell>
                                        <TableCell>字符串</TableCell>
                                        <TableCell>当前对话标识</TableCell>
                                    </TableRow>
                                    <TableRow>
                                        <TableCell>
                                            <code>$flow.sourceDocuments</code>
                                        </TableCell>
                                        <TableCell>数组</TableCell>
                                        <TableCell>检索时使用的来源文档（如适用）</TableCell>
                                    </TableRow>
                                    <TableRow>
                                        <TableCell>
                                            <code>$flow.usedTools</code>
                                        </TableCell>
                                        <TableCell>数组</TableCell>
                                        <TableCell>执行期间使用的工具列表</TableCell>
                                    </TableRow>
                                    <TableRow>
                                        <TableCell>
                                            <code>$flow.artifacts</code>
                                        </TableCell>
                                        <TableCell>数组</TableCell>
                                        <TableCell>执行期间生成的内容列表</TableCell>
                                    </TableRow>
                                    <TableRow>
                                        <TableCell>
                                            <code>$flow.fileAnnotations</code>
                                        </TableCell>
                                        <TableCell>数组</TableCell>
                                        <TableCell>与响应关联的文件注解</TableCell>
                                    </TableRow>
                                </TableBody>
                            </Table>
                        </TableContainer>
                    </AccordionDetails>
                </Accordion>
            </Card>
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', width: '100%', mt: 2 }}>
                <StyledButton
                    variant='contained'
                    disabled={!postProcessingFunction || postProcessingFunction?.trim().length === 0}
                    onClick={onSave}
                    sx={{ minWidth: 100 }}
                >
                    保存
                </StyledButton>
            </Box>
            <ExpandTextDialog
                show={showExpandDialog}
                dialogProps={expandDialogProps}
                onCancel={() => setShowExpandDialog(false)}
                onConfirm={(newValue) => {
                    setPostProcessingFunction(newValue)
                    setShowExpandDialog(false)
                }}
            ></ExpandTextDialog>
        </>
    )
}

PostProcessing.propTypes = {
    dialogProps: PropTypes.object
}

export default PostProcessing
