// The analysis prompt accepts only the alert number already supplied by the
// authoritative Receiver/BFF contract. It must never derive one from other
// alert identifiers.
export function alertAnalysisInstruction(alertNumber: unknown, locale: string): string | null {
  const value = typeof alertNumber === 'string' ? alertNumber.trim() : ''
  if (!value) return null
  return locale === 'zh-CN' ? `分析告警 ${value}` : `Analyze alert ${value}`
}
