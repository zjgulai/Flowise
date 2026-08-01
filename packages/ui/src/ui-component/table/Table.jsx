import PropTypes from 'prop-types'
import { TableContainer, Table, TableHead, TableCell, TableRow, TableBody, Paper, Chip, Stack, Typography } from '@mui/material'
import { TooltipWithParser } from '@/ui-component/tooltip/TooltipWithParser'

const columnLabels = {
    enabled: '覆盖',
    label: '标签',
    name: '名称',
    nodeIds: '节点 ID',
    type: '类型',
    value: '值'
}

export const TableViewOnly = ({ columns, rows, sx }) => {
    // Helper function to safely render cell content
    const renderCellContent = (key, row) => {
        if (row[key] === null || row[key] === undefined) {
            return ''
        } else if (key === 'enabled') {
            return row[key] ? <Chip label='已启用' color='primary' /> : <Chip label='已禁用' />
        } else if (key === 'type' && row.schema) {
            // If there's schema information, add a tooltip
            let schemaContent
            if (Array.isArray(row.schema)) {
                // Handle array format: [{ name: "field", type: "string" }, ...]
                schemaContent =
                    '[<br>' +
                    row.schema
                        .map(
                            (item) =>
                                `&nbsp;&nbsp;${JSON.stringify(
                                    {
                                        [item.name]: item.type
                                    },
                                    null,
                                    2
                                )}`
                        )
                        .join(',<br>') +
                    '<br>]'
            } else if (typeof row.schema === 'object' && row.schema !== null) {
                // Handle object format: { "field": "string", "field2": "number", ... }
                schemaContent = JSON.stringify(row.schema, null, 2).replace(/\n/g, '<br>').replace(/ /g, '&nbsp;')
            } else {
                schemaContent = '暂无可用结构信息'
            }

            return (
                <Stack direction='row' alignItems='center' spacing={1}>
                    <Typography>{row[key]}</Typography>
                    <TooltipWithParser title={`<div>结构：<br/>${schemaContent}</div>`} />
                </Stack>
            )
        } else if (typeof row[key] === 'object') {
            // For other objects (that are not handled by special cases above)
            return JSON.stringify(row[key])
        } else {
            return row[key]
        }
    }

    return (
        <>
            <TableContainer component={Paper}>
                <Table sx={{ minWidth: 650, ...sx }} aria-label='配置表格'>
                    <TableHead>
                        <TableRow>
                            {columns.map((col, index) => (
                                <TableCell key={index}>
                                    {col === 'enabled' ? (
                                        <>
                                            覆盖
                                            <TooltipWithParser
                                                style={{ mb: 1, mt: 2, marginLeft: 10 }}
                                                title={
                                                    '启用后，可在 API 调用和嵌入配置中覆盖此变量；禁用后，系统将忽略所有覆盖值。如需修改，请前往对话流程配置的安全设置。'
                                                }
                                            />
                                        </>
                                    ) : (
                                        columnLabels[col] ?? col
                                    )}
                                </TableCell>
                            ))}
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {rows.map((row, index) => (
                            <TableRow key={index} sx={{ '&:last-child td, &:last-child th': { border: 0 } }}>
                                {Object.keys(row).map((key, index) => {
                                    if (key !== 'id' && key !== 'schema') {
                                        return <TableCell key={index}>{renderCellContent(key, row)}</TableCell>
                                    }
                                })}
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>
        </>
    )
}

TableViewOnly.propTypes = {
    rows: PropTypes.array,
    columns: PropTypes.array,
    sx: PropTypes.object
}
