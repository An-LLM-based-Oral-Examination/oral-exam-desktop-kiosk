import { ApiProblemError } from '../services/api'

export interface Sha256DigestPair {
  hex: string
  base64: string
}

const PERMANENT_CLIENT_ERROR_STATUSES = new Set([400, 401, 403, 404, 409, 413, 415, 422])

function isRetryableError(error: unknown, shouldRetry?: (error: unknown) => boolean): boolean {
  if (shouldRetry) {
    return shouldRetry(error)
  }
  if (error instanceof ApiProblemError && PERMANENT_CLIENT_ERROR_STATUSES.has(error.status)) {
    return false
  }
  return true
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

export async function sha256HexAndBase64(blob: Blob): Promise<Sha256DigestPair> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  const bytes = new Uint8Array(digest)
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  const base64 = bytesToBase64(bytes)
  return { hex, base64 }
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const { hex } = await sha256HexAndBase64(blob)
  return hex
}

export async function retryOnce<T>(
  operation: () => Promise<T>,
  delayMs = 600,
  shouldRetry?: (error: unknown) => boolean,
): Promise<T> {
  try {
    return await operation()
  } catch (firstError) {
    if (!isRetryableError(firstError, shouldRetry)) {
      throw firstError
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, delayMs))
    try {
      return await operation()
    } catch {
      throw firstError
    }
  }
}
