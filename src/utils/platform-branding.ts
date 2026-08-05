/**
 * Rebrand upstream product names only at the presentation boundary.
 * Keep source identifiers and Gateway payloads unchanged so RPC calls,
 * persistence, and plugin ownership remain stable.
 */
export function formatGAIOPDisplayText(value: string | null | undefined): string {
  return String(value || '')
    .replace(/openclaw-(?:napm)/gi, 'GAIOP-NAPM')
    .replace(/openclaw\s+(?:napm)/gi, 'GAIOP NAPM')
    .replace(/openclaw/gi, 'GAIOP')
}
