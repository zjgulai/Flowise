import { memo, useCallback, useEffect, useState } from 'react'

import { Info } from '@mui/icons-material'
import {
    Box,
    Button,
    Chip,
    Dialog,
    DialogContent,
    DialogTitle,
    IconButton,
    Paper,
    Stack,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    Tooltip,
    Typography
} from '@mui/material'
import { IconBook2, IconInfoCircle } from '@tabler/icons-react'

import type { InputParam, NodeConfigEntry, NodeData, NodeDataSchema } from '@/core/types'
import { getMetadataDisplayText, resolveInstanceDisplayLabel } from '@/core/utils'
import { useApiContext } from '@/infrastructure/store'

import { renderNodeIcon } from '../nodeIcons'

export interface NodeInfoDialogProps {
    open: boolean
    onClose: () => void
    data: NodeData
}

/** Badge-style pill used in the dialog title area */
function InfoBadge({ label, bgColor, textColor }: { label: string; bgColor: string; textColor: string }) {
    return (
        <Box
            sx={{
                display: 'inline-flex',
                borderRadius: '15px',
                background: bgColor,
                px: 1.25,
                py: 0.625,
                my: 0.625
            }}
        >
            <Typography component='span' sx={{ color: textColor, fontSize: '0.825rem' }}>
                {label}
            </Typography>
        </Box>
    )
}

/** Renders the schema tooltip content as structured JSX, matching the legacy TooltipWithParser style */
function SchemaTooltipContent({ schema }: { schema: NodeConfigEntry['schema'] }) {
    if (!schema) return null

    let content: string
    if (Array.isArray(schema)) {
        const items = schema.map((item) => `  ${JSON.stringify({ [item.name]: item.type })}`).join(',\n')
        content = `[\n${items}\n]`
    } else if (typeof schema === 'object') {
        content = JSON.stringify(schema, null, 2)
    } else {
        content = '暂无可用 Schema'
    }

    return (
        <Box>
            <Typography variant='caption' fontWeight={600}>
                Schema：
            </Typography>
            <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', fontSize: '0.75rem' }}>{content}</pre>
        </Box>
    )
}

/**
 * Dialog showing full node information including icon, badges, description,
 * documentation link, and parameter configuration table.
 */
function NodeInfoDialogComponent({ open, onClose, data }: NodeInfoDialogProps) {
    const { nodesApi, apiBaseUrl } = useApiContext()
    const [nodeConfig, setNodeConfig] = useState<NodeConfigEntry[]>([])
    const [componentDef, setComponentDef] = useState<NodeDataSchema | null>(null)

    const fetchData = useCallback(async () => {
        if (!data) return
        try {
            // Fetch the component definition first — it has the full input
            // parameter definitions that the config endpoint requires.
            const def = await nodesApi.getNodeByName(data.name)
            setComponentDef(def)

            // Build config request with component definition schema merged
            // with the node's user-entered values.
            const configData: NodeData = {
                ...data,
                inputParams: def.inputs ?? data.inputParams, // schema from API
                inputs: data.inputs // keep canvas values
            }
            const config = await nodesApi.getNodeConfig(configData)
            setNodeConfig(config)
        } catch {
            setNodeConfig([])
        }
    }, [data, nodesApi])

    useEffect(() => {
        if (open && data) {
            fetchData()
        }
    }, [open, data, fetchData])

    if (!data) return null

    // Merge component definition metadata with node data — component def
    // provides fields like description, version, badge, tags, documentation
    // that may be missing from nodes loaded from saved flows or examples.
    const version = data.version ?? componentDef?.version
    const badge = data.badge ?? componentDef?.badge
    const tags = data.tags ?? componentDef?.tags
    const documentation = data.documentation ?? componentDef?.documentation
    const description = getMetadataDisplayText(componentDef, 'description', data.description ?? componentDef?.description)
    const displayLabel = resolveInstanceDisplayLabel(data, componentDef ?? undefined)
    const displayBadge = getMetadataDisplayText(componentDef, 'badge', badge)

    return (
        <Dialog onClose={onClose} open={open} fullWidth maxWidth='md' aria-labelledby='node-info-dialog-title'>
            <DialogTitle sx={{ fontSize: '1rem' }} id='node-info-dialog-title'>
                {data.name && data.label && (
                    <Box sx={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
                        {/* Node icon */}
                        {data.color && !data.icon ? (
                            <Box
                                sx={{
                                    width: 50,
                                    height: 50,
                                    borderRadius: '15px',
                                    backgroundColor: data.color,
                                    display: 'flex',
                                    justifyContent: 'center',
                                    alignItems: 'center',
                                    mr: 1.25,
                                    flexShrink: 0
                                }}
                            >
                                {renderNodeIcon(data)}
                            </Box>
                        ) : (
                            <Box
                                sx={{
                                    width: 50,
                                    height: 50,
                                    mr: 1.25,
                                    borderRadius: '50%',
                                    backgroundColor: 'white',
                                    flexShrink: 0,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center'
                                }}
                            >
                                <Box
                                    component='img'
                                    sx={{
                                        width: '100%',
                                        height: '100%',
                                        p: 0.875,
                                        borderRadius: '50%',
                                        objectFit: 'contain'
                                    }}
                                    alt={data.name}
                                    src={`${apiBaseUrl}/api/v1/node-icon/${data.name}`}
                                />
                            </Box>
                        )}

                        {/* Label and badges */}
                        <Box sx={{ display: 'flex', flexDirection: 'column', ml: 1.25 }}>
                            <Typography variant='subtitle1' fontWeight={600}>
                                {displayLabel}
                            </Typography>
                            <Box sx={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 1 }}>
                                <InfoBadge label={data.id} bgColor='rgb(254,252,191)' textColor='rgb(116,66,16)' />
                                {version != null && <InfoBadge label={`版本 ${version}`} bgColor='#e9edc9' textColor='#606c38' />}
                                {badge && (
                                    <InfoBadge
                                        label={displayBadge}
                                        bgColor={badge === 'DEPRECATING' ? '#ffe57f' : '#52b69a'}
                                        textColor={badge === 'DEPRECATING' ? 'inherit' : 'white'}
                                    />
                                )}
                                {tags?.map((tag, index) => (
                                    <InfoBadge key={index} label={tag.toLowerCase()} bgColor='#cae9ff' textColor='#023e7d' />
                                ))}
                            </Box>
                        </Box>

                        {/* Spacer */}
                        <Box sx={{ flex: 1 }} />

                        {/* Documentation button */}
                        {documentation && (
                            <Button
                                variant='outlined'
                                color='primary'
                                title='打开文档'
                                onClick={() => window.open(documentation, '_blank', 'noopener,noreferrer')}
                                startIcon={<IconBook2 />}
                            >
                                文档
                            </Button>
                        )}
                    </Box>
                )}
            </DialogTitle>
            <DialogContent>
                {description && (
                    <Box sx={{ p: 1.25, mb: 1.25 }}>
                        <Typography variant='body2'>{description}</Typography>
                    </Box>
                )}
                {nodeConfig.length > 0 && <NodeConfigTable config={nodeConfig} componentDef={componentDef} />}
            </DialogContent>
        </Dialog>
    )
}

/** Table displaying the node configuration (parameters, types, overrides) */
function findInputParamExact(inputs: InputParam[] | undefined, name: string): InputParam | undefined {
    for (const input of inputs ?? []) {
        if (input.name === name) return input
        const nested = findInputParamExact(input.array, name)
        if (nested) return nested
    }
    return undefined
}

function findInputParam(inputs: InputParam[] | undefined, name: string): InputParam | undefined {
    return (
        findInputParamExact(inputs, name) ??
        (name.endsWith('Config') ? findInputParamExact(inputs, name.slice(0, -'Config'.length)) : undefined)
    )
}

function NodeConfigTable({ config, componentDef }: { config: NodeConfigEntry[]; componentDef: NodeDataSchema | null }) {
    // Determine columns from the first entry, excluding 'node' and 'nodeId'
    const allKeys = Object.keys(config[0]).filter(
        (k) => k !== 'node' && k !== 'nodeId' && k !== 'id' && k !== 'schema' && k !== 'displayLabel'
    )
    // Typically: label, name, type, enabled

    return (
        <TableContainer component={Paper} elevation={0} sx={{ boxShadow: 'none' }}>
            <Table sx={{ minWidth: 650, '& td, & th': { borderColor: 'divider' } }} aria-label='Node configuration'>
                <TableHead>
                    <TableRow>
                        {allKeys.map((col) => (
                            <TableCell key={col}>
                                {col === 'enabled' ? (
                                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                                        允许覆盖
                                        <Tooltip
                                            title='启用后，可在 API 调用和嵌入组件中覆盖此变量；禁用后将忽略所有覆盖值。如需修改，请前往对话流程配置中的安全设置。'
                                            arrow
                                        >
                                            <IconInfoCircle size={16} style={{ cursor: 'help', opacity: 0.6 }} />
                                        </Tooltip>
                                    </Box>
                                ) : col === 'label' ? (
                                    '参数'
                                ) : col === 'name' ? (
                                    '名称'
                                ) : col === 'type' ? (
                                    '类型'
                                ) : (
                                    col
                                )}
                            </TableCell>
                        ))}
                    </TableRow>
                </TableHead>
                <TableBody>
                    {config.map((row, rowIndex) => (
                        <TableRow key={rowIndex} sx={{ '&:last-child td, &:last-child th': { border: 0 } }}>
                            {allKeys.map((key) => (
                                <TableCell key={key}>{renderConfigCell(key, row, componentDef)}</TableCell>
                            ))}
                        </TableRow>
                    ))}
                </TableBody>
            </Table>
        </TableContainer>
    )
}

/** Render a single cell in the config table */
function renderConfigCell(key: string, row: NodeConfigEntry, componentDef: NodeDataSchema | null) {
    const value = row[key as keyof NodeConfigEntry]

    if (value === null || value === undefined) return ''

    if (key === 'enabled') {
        return value ? <Chip label='已启用' color='primary' size='small' /> : <Chip label='未启用' size='small' />
    }

    if (key === 'label' && typeof row.name === 'string') {
        const input = findInputParam(componentDef?.inputs, row.name)
        return typeof row.displayLabel === 'string' && row.displayLabel
            ? row.displayLabel
            : getMetadataDisplayText(input, 'label', String(value))
    }

    if (key === 'type' && row.schema) {
        return (
            <Stack direction='row' alignItems='center' spacing={1}>
                <Typography variant='body2'>{String(value)}</Typography>
                <Tooltip title={<SchemaTooltipContent schema={row.schema} />} placement='right'>
                    <IconButton sx={{ height: 15, width: 15 }}>
                        <Info sx={{ height: 15, width: 15 }} />
                    </IconButton>
                </Tooltip>
            </Stack>
        )
    }

    if (typeof value === 'object') return JSON.stringify(value)

    return String(value)
}

export const NodeInfoDialog = memo(NodeInfoDialogComponent)
