import { createPortal } from 'react-dom'
import { useState, useEffect, useId } from 'react'
import PropTypes from 'prop-types'
import {
    Dialog,
    DialogContent,
    DialogTitle,
    TableContainer,
    Table,
    TableHead,
    TableRow,
    TableCell,
    TableBody,
    Paper,
    Typography
} from '@mui/material'
import moment from 'moment'
import axios from 'axios'
import { baseURL } from '@/store/constant'

const ABOUT_STATUS = {
    IDLE: 'idle',
    LOADING: 'loading',
    ERROR: 'error',
    EMPTY: 'empty',
    READY: 'ready'
}

const normalizeVersionData = (latestRelease, currentVersionResponse) => {
    const currentVersion = currentVersionResponse?.version
    const latestVersion = latestRelease?.name || latestRelease?.tag_name
    const publishedAt = latestRelease?.published_at
    let releaseUrl

    try {
        releaseUrl = new URL(latestRelease?.html_url)
    } catch {
        return null
    }

    if (
        typeof currentVersion !== 'string' ||
        !currentVersion.trim() ||
        typeof latestVersion !== 'string' ||
        !latestVersion.trim() ||
        typeof publishedAt !== 'string' ||
        Number.isNaN(Date.parse(publishedAt)) ||
        releaseUrl.protocol !== 'https:' ||
        releaseUrl.hostname !== 'github.com'
    ) {
        return null
    }

    return {
        currentVersion: currentVersion.trim(),
        name: latestVersion.trim(),
        published_at: publishedAt,
        html_url: releaseUrl.toString()
    }
}

const AboutDialog = ({ show, onCancel }) => {
    const portalElement = document.getElementById('portal')
    const dialogId = `about-${useId()}`
    const titleId = `${dialogId}-title`
    const contentId = `${dialogId}-content`

    const [data, setData] = useState(null)
    const [status, setStatus] = useState(ABOUT_STATUS.IDLE)

    useEffect(() => {
        let active = true

        if (!show) {
            setData(null)
            setStatus(ABOUT_STATUS.IDLE)
            return () => {
                active = false
            }
        }

        setData(null)
        setStatus(ABOUT_STATUS.LOADING)

        const latestReleaseReq = axios.get('https://api.github.com/repos/FlowiseAI/Flowise/releases/latest')
        const currentVersionReq = axios.get(`${baseURL}/api/v1/version`, {
            withCredentials: true,
            headers: { 'Content-type': 'application/json', 'x-request-from': 'internal' }
        })

        Promise.all([latestReleaseReq, currentVersionReq])
            .then(([latestReleaseData, currentVersionData]) => {
                if (!active) return
                const nextData = normalizeVersionData(latestReleaseData.data, currentVersionData.data)
                setData(nextData)
                setStatus(nextData ? ABOUT_STATUS.READY : ABOUT_STATUS.EMPTY)
            })
            .catch(() => {
                if (!active) return
                setData(null)
                setStatus(ABOUT_STATUS.ERROR)
            })

        return () => {
            active = false
        }
    }, [show])

    const component = show ? (
        <Dialog onClose={onCancel} open={show} fullWidth maxWidth='sm' aria-labelledby={titleId} aria-describedby={contentId}>
            <DialogTitle sx={{ fontSize: '1rem' }} id={titleId}>
                Flowise 版本
            </DialogTitle>
            <DialogContent id={contentId}>
                {status === ABOUT_STATUS.LOADING && <Typography role='status'>正在加载版本信息…</Typography>}
                {status === ABOUT_STATUS.ERROR && (
                    <Typography role='alert' color='error'>
                        版本信息加载失败，请稍后重试。
                    </Typography>
                )}
                {status === ABOUT_STATUS.EMPTY && <Typography role='status'>暂无可用版本信息。</Typography>}
                {status === ABOUT_STATUS.READY && data && (
                    <TableContainer component={Paper}>
                        <Table aria-label='Flowise 版本信息表'>
                            <TableHead>
                                <TableRow>
                                    <TableCell>当前版本</TableCell>
                                    <TableCell>最新版本</TableCell>
                                    <TableCell>发布时间</TableCell>
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                <TableRow sx={{ '&:last-child td, &:last-child th': { border: 0 } }}>
                                    <TableCell component='th' scope='row'>
                                        {data.currentVersion}
                                    </TableCell>
                                    <TableCell component='th' scope='row'>
                                        <a target='_blank' rel='noreferrer' href={data.html_url}>
                                            {data.name}
                                        </a>
                                    </TableCell>
                                    <TableCell>{moment(data.published_at).fromNow()}</TableCell>
                                </TableRow>
                            </TableBody>
                        </Table>
                    </TableContainer>
                )}
            </DialogContent>
        </Dialog>
    ) : null

    return createPortal(component, portalElement)
}

AboutDialog.propTypes = {
    show: PropTypes.bool,
    onCancel: PropTypes.func
}

export default AboutDialog
