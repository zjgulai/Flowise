import { createHash } from 'crypto'

export type ComponentMetadataKind = 'node' | 'credential' | 'dynamic'

export const metadataTextDigest = (source: string): string => createHash('sha256').update(source, 'utf8').digest('hex').slice(0, 12)

export const escapeMetadataPathSegment = (value: unknown): string => String(value).replaceAll('~', '~0').replaceAll('/', '~1')

export const metadataTranslationKey = (
    kind: ComponentMetadataKind,
    id: string,
    metadataPath: string,
    field: string,
    source: string
): string => `${kind}.${escapeMetadataPathSegment(id)}.${metadataPath}.${field}@${metadataTextDigest(source)}`
