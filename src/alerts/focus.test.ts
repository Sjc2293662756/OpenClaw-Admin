import { describe, expect, it } from 'vitest'
import { findAlertById, focusAlertId } from './focus'

describe('alert focus deep link', () => {
  it('accepts a single safe id and preserves exact matching', () => {
    expect(focusAlertId(['one', 'two'])).toBe('one')
    expect(focusAlertId('  target  ')).toBe('target')
    expect(focusAlertId('')).toBeNull()
    expect(findAlertById([{ id: 'one' }, { id: 'target' }], 'target')).toEqual({ id: 'target' })
  })
})
