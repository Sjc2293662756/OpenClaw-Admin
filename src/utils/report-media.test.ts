import { describe, expect, it } from 'vitest'
import { stripInternalDocxMediaPaths } from './report-media'

describe('stripInternalDocxMediaPaths', () => {
  it('removes the internal Word path while retaining the user-facing reply and file name', () => {
    expect(stripInternalDocxMediaPaths(
      '报告已生成。\nMEDIA:/home/netinside/.openclaw/workspace/skills/report/output/巡检报告.docx',
    )).toBe('报告已生成。\n巡检报告.docx')
  })

  it('matches case-insensitive Word paths with a query string', () => {
    expect(stripInternalDocxMediaPaths('MEDIA:file:///tmp/REPORT.DOCX?version=1')).toBe('REPORT.DOCX')
  })

  it('does not alter ordinary filenames or image MEDIA content', () => {
    expect(stripInternalDocxMediaPaths('请查看报告.docx 与 MEDIA:browser/chart.png')).toBe(
      '请查看报告.docx 与 MEDIA:browser/chart.png',
    )
  })
})
