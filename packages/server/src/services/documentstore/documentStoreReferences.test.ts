import { parseCanonicalDocumentStoreReference } from './documentStoreReferences'

describe('canonical document store references', () => {
    it('normalizes direct and typed legacy references without losing the suffix', () => {
        expect(parseCanonicalDocumentStoreReference('  store-1  ', false)).toEqual({
            storeId: 'store-1',
            suffix: '',
            canonicalValue: 'store-1'
        })
        expect(parseCanonicalDocumentStoreReference('  store-1 :Knowledge  ', true)).toEqual({
            storeId: 'store-1',
            suffix: ':Knowledge',
            canonicalValue: 'store-1:Knowledge'
        })
    })

    it.each([undefined, null, '', '   ', '\0store', 'x'.repeat(257)])('rejects an invalid reference (%p)', (value) => {
        expect(parseCanonicalDocumentStoreReference(value, true)).toBeNull()
    })
})
