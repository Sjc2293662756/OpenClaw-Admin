import { describe, expect, it } from 'vitest'
import { stripInternalDocxMediaPaths } from './report-media'

describe('stripInternalDocxMediaPaths', () => {
  it('removes an internal Word MEDIA path while retaining the user-facing reply', () => {
    expect(stripInternalDocxMediaPaths(
      '报告已生成。\nMEDIA:/home/netinside/.openclaw/workspace/skills/report/output/巡检报告.docx',
    )).toBe('报告已生成。\n')
  })

  it('matches case-insensitive Word paths with a query string', () => {
    expect(stripInternalDocxMediaPaths('MEDIA:file:///tmp/REPORT.DOCX?version=1')).toBe('')
  })

  it('does not alter ordinary filenames or image MEDIA content', () => {
    expect(stripInternalDocxMediaPaths('请查看报告.docx 与 MEDIA:browser/chart.png')).toBe(
      '请查看报告.docx 与 MEDIA:browser/chart.png',
    )
  })
})
