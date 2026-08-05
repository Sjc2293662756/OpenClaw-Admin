const INTERNAL_DOCX_MEDIA_PATTERN = /MEDIA:[^\s\n]*\.docx(?:[?#][^\s\n]*)?/gi

/**
 * `MEDIA:` is an internal transport marker, not a browser-downloadable URL.
 * Keep Word report paths out of rendered and copied chat content until the
 * workspace has a controlled report-download action.
 */
export function stripInternalDocxMediaPaths(content: string): string {
  return String(content || '').replace(INTERNAL_DOCX_MEDIA_PATTERN, '')
}
