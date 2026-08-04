import { getStateKeyOptions } from './stateKeyOptions'

describe('state key options', () => {
    it('returns keys from supported array and object state metadata', () => {
        expect(getStateKeyOptions('[{"key":"customerId"},{"key":"priority"}]')).toEqual(['customerId', 'priority'])
        expect(getStateKeyOptions('{"ticketId":"","status":""}')).toEqual(['ticketId', 'status'])
    })

    it.each([undefined, '', 'null', '"text"', '{invalid-json'])('returns an editable empty option list for %p', (serializedState) => {
        expect(getStateKeyOptions(serializedState)).toEqual([])
    })

    it('ignores array entries without usable string keys', () => {
        expect(getStateKeyOptions('[{"key":"valid"},{"key":""},{"other":"missing"},{"key":42}]')).toEqual(['valid'])
    })
})
