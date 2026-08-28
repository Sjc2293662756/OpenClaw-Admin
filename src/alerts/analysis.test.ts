import { describe, expect, it } from 'vitest'
import { alertAnalysisInstruction } from './analysis'

describe('alertAnalysisInstruction', () => {
  it('uses the authoritative alert number unchanged', () => {
    expect(alertAnalysisInstruction('GJ-4HBZZS7A', 'zh-CN')).toBe('分析告警 GJ-4HBZZS7A')
    expect(alertAnalysisInstruction('GJ-4HBZZS7A', 'en-US')).toBe('Analyze alert GJ-4HBZZS7A')
  })

  it('does not fall back to an internal ID or event ID', () => {
    expect(alertAnalysisInstruction('', 'zh-CN')).toBeNull()
    expect(alertAnalysisInstruction('   ', 'en-US')).toBeNull()
  })
})
