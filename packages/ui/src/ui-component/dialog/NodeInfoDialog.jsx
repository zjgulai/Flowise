import { createPortal } from 'react-dom'
import { useDispatch, useSelector } from 'react-redux'
import { useEffect } from 'react'
import PropTypes from 'prop-types'

// Material
import { Button, Dialog, DialogContent, DialogTitle } from '@mui/material'
import { TableViewOnly } from '@/ui-component/table/Table'
import { IconBook2 } from '@tabler/icons-react'
import { useTheme } from '@mui/material/styles'

// Store
import { HIDE_CANVAS_DIALOG, SHOW_CANVAS_DIALOG } from '@/store/actions'
import { baseURL, AGENTFLOW_ICONS } from '@/store/constant'

// API
import configApi from '@/api/config'
import useApi from '@/hooks/useApi'
import { getMetadataDisplayText, resolveCurrentMetadataItem, resolveInstanceDisplayLabel } from '@/utils/componentMetadataDisplay'

const NodeInfoDialog = ({ show, dialogProps, onCancel }) => {
    const portalElement = document.getElementById('portal')
    const dispatch = useDispatch()
    const theme = useTheme()
    const componentNodes = useSelector((state) => state.canvas.componentNodes)
    const componentMetadata = dialogProps.componentMetadata ?? componentNodes.find((node) => node.name === dialogProps.data?.name)

    const getNodeConfigApi = useApi(configApi.getNodeConfig)

    const renderIcon = (node) => {
        const foundIcon = AGENTFLOW_ICONS.find((icon) => icon.name === node.name)

        if (!foundIcon) return null
        return <foundIcon.icon size={24} color={'white'} />
    }

    useEffect(() => {
        if (dialogProps.data) {
            getNodeConfigApi.request(dialogProps.data)
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dialogProps])

    useEffect(() => {
        if (show) dispatch({ type: SHOW_CANVAS_DIALOG })
        else dispatch({ type: HIDE_CANVAS_DIALOG })
        return () => dispatch({ type: HIDE_CANVAS_DIALOG })
    }, [show, dispatch])

    const component = show ? (
        <Dialog
            onClose={onCancel}
            open={show}
            fullWidth
            maxWidth='md'
            aria-labelledby='alert-dialog-title'
            aria-describedby='alert-dialog-description'
        >
            <DialogTitle sx={{ fontSize: '1rem' }} id='alert-dialog-title'>
                {dialogProps.data && dialogProps.data.name && dialogProps.data.label && (
                    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
                        {dialogProps.data.color && !dialogProps.data.icon ? (
                            <div
                                style={{
                                    ...theme.typography.commonAvatar,
                                    ...theme.typography.largeAvatar,
                                    borderRadius: '15px',
                                    backgroundColor: dialogProps.data.color,
                                    cursor: 'grab',
                                    display: 'flex',
                                    justifyContent: 'center',
                                    alignItems: 'center',
                                    background: dialogProps.data.color,
                                    marginRight: 10
                                }}
                            >
                                {renderIcon(dialogProps.data)}
                            </div>
                        ) : (
                            <div
                                style={{
                                    width: 50,
                                    height: 50,
                                    marginRight: 10,
                                    borderRadius: '50%',
                                    backgroundColor: 'white',
                                    flexShrink: 0,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center'
                                }}
                            >
                                <img
                                    style={{
                                        width: '100%',
                                        height: '100%',
                                        padding: 7,
                                        borderRadius: '50%',
                                        objectFit: 'contain'
                                    }}
                                    alt={resolveInstanceDisplayLabel(dialogProps.data, componentMetadata)}
                                    src={`${baseURL}/api/v1/node-icon/${dialogProps.data.name}`}
                                />
                            </div>
                        )}
                        <div style={{ display: 'flex', flexDirection: 'column', marginLeft: 10 }}>
                            {resolveInstanceDisplayLabel(dialogProps.data, componentMetadata)}
                            <div style={{ display: 'flex', flexDirection: 'row' }}>
                                <div
                                    style={{
                                        display: 'flex',
                                        flexDirection: 'row',
                                        width: 'max-content',
                                        borderRadius: 15,
                                        background: 'rgb(254,252,191)',
                                        padding: 5,
                                        paddingLeft: 10,
                                        paddingRight: 10,
                                        marginTop: 5,
                                        marginBottom: 5
                                    }}
                                >
                                    <span style={{ color: 'rgb(116,66,16)', fontSize: '0.825rem' }}>{dialogProps.data.id}</span>
                                </div>
                                {dialogProps.data.version && (
                                    <div
                                        style={{
                                            display: 'flex',
                                            flexDirection: 'row',
                                            width: 'max-content',
                                            borderRadius: 15,
                                            background: '#e9edc9',
                                            padding: 5,
                                            paddingLeft: 10,
                                            paddingRight: 10,
                                            marginTop: 5,
                                            marginLeft: 10,
                                            marginBottom: 5
                                        }}
                                    >
                                        <span style={{ color: '#606c38', fontSize: '0.825rem' }}>版本 {dialogProps.data.version}</span>
                                    </div>
                                )}
                                {dialogProps.data.badge && (
                                    <div
                                        style={{
                                            display: 'flex',
                                            flexDirection: 'row',
                                            width: 'max-content',
                                            borderRadius: 15,
                                            background: dialogProps.data.badge === 'DEPRECATING' ? '#ffe57f' : '#52b69a',
                                            padding: 5,
                                            paddingLeft: 10,
                                            paddingRight: 10,
                                            marginTop: 5,
                                            marginLeft: 10,
                                            marginBottom: 5
                                        }}
                                    >
                                        <span
                                            style={{
                                                color: dialogProps.data.badge !== 'DEPRECATING' ? 'white' : 'inherit',
                                                fontSize: '0.825rem'
                                            }}
                                        >
                                            {getMetadataDisplayText(componentMetadata, 'badge', dialogProps.data.badge)}
                                        </span>
                                    </div>
                                )}
                                {dialogProps.data.tags &&
                                    dialogProps.data.tags.length &&
                                    dialogProps.data.tags.map((tag, index) => (
                                        <div
                                            style={{
                                                display: 'flex',
                                                flexDirection: 'row',
                                                width: 'max-content',
                                                borderRadius: 15,
                                                background: '#cae9ff',
                                                padding: 5,
                                                paddingLeft: 10,
                                                paddingRight: 10,
                                                marginTop: 5,
                                                marginLeft: 10,
                                                marginBottom: 5
                                            }}
                                            key={index}
                                        >
                                            <span
                                                style={{
                                                    color: '#023e7d',
                                                    fontSize: '0.825rem'
                                                }}
                                            >
                                                {tag.toLowerCase()}
                                            </span>
                                        </div>
                                    ))}
                            </div>
                        </div>
                        <div style={{ flex: 1 }}></div>
                        {dialogProps.data.documentation && (
                            <Button
                                variant='outlined'
                                color='primary'
                                title='打开文档'
                                onClick={() => {
                                    window.open(dialogProps.data.documentation, '_blank', 'noopener,noreferrer')
                                }}
                                startIcon={<IconBook2 />}
                            >
                                文档
                            </Button>
                        )}
                    </div>
                )}
            </DialogTitle>
            <DialogContent>
                {dialogProps.data?.description && (
                    <div
                        style={{
                            padding: 10,
                            marginBottom: 10
                        }}
                    >
                        <span>{getMetadataDisplayText(componentMetadata, 'description', dialogProps.data.description)}</span>
                    </div>
                )}
                {getNodeConfigApi.data && getNodeConfigApi.data.length > 0 && (
                    <TableViewOnly
                        rows={getNodeConfigApi.data.map((obj) => {
                            // eslint-disable-next-line
                            const { node, nodeId, ...rest } = obj
                            const configName = rest.name?.endsWith('Config') ? rest.name.slice(0, -'Config'.length) : rest.name
                            const currentMetadata = resolveCurrentMetadataItem(componentMetadata, { name: configName })
                            const displayLabel =
                                typeof rest.displayLabel === 'string' && rest.displayLabel
                                    ? rest.displayLabel
                                    : getMetadataDisplayText(currentMetadata, 'label', rest.label)
                            return {
                                ...rest,
                                label: rest.name?.endsWith('Config') ? `${displayLabel}配置` : displayLabel
                            }
                        })}
                        columns={Object.keys(getNodeConfigApi.data[0])
                            .filter((key) => key !== 'displayLabel')
                            .slice(-3)}
                    />
                )}
            </DialogContent>
        </Dialog>
    ) : null

    return createPortal(component, portalElement)
}

NodeInfoDialog.propTypes = {
    show: PropTypes.bool,
    dialogProps: PropTypes.object,
    onCancel: PropTypes.func
}

export default NodeInfoDialog
