export function resolveQuestionImageUrl(
  imageUrl: string | null | undefined,
  apiBaseUrl?: string | null,
): string | null {
  if (typeof imageUrl !== 'string') return null
  const trimmed = imageUrl.trim()
  if (!trimmed) return null

  const schemeCandidate = trimmed.replace(/[\u0000-\u0020]+/g, '')
  if (/^(javascript|vbscript):/i.test(schemeCandidate)) {
    return null
  }

  if (/^(https?:|data:|blob:)/i.test(trimmed)) {
    return trimmed
  }

  const normalizedRelative = trimmed.startsWith('/') ? trimmed : `/${trimmed}`

  if (typeof apiBaseUrl === 'string' && apiBaseUrl.trim()) {
    try {
      const parsedApi = new URL(apiBaseUrl.trim())
      if (parsedApi.protocol === 'http:' || parsedApi.protocol === 'https:') {
        return `${parsedApi.origin}${normalizedRelative}`
      }
    } catch {
      // Relative apiBaseUrl (e.g. '/api/v1') in browser dev mode; fall through.
    }
  }

  return trimmed
}
