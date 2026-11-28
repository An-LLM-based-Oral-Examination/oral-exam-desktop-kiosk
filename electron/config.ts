import { app } from 'electron/main'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_DEV_API_BASE_URL = 'http://127.0.0.1:5000/api/v1'
export const DEFAULT_PROD_API_BASE_URL = 'https://oralexam.io.vn/api/v1'
const DEV_RENDERER_ORIGIN = 'http://127.0.0.1:5174'
const R2_HOST_SUFFIX = '.r2.cloudflarestorage.com'
const DEV_ALLOWED_R2_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal'])

export function isKioskMode(): boolean {
  if (app.isPackaged) return true
  return process.env.KIOSK_MODE !== '0'
}

export function isAltTabTestMode(): boolean {
  if (app.isPackaged) return false
  return process.env.KIOSK_DISABLE_ALT_TAB === '1' || process.argv.includes('--disable-alt-tab')
}

export function isWindowLockdownEnabled(): boolean {
  return isKioskMode() && !isAltTabTestMode()
}

export function isAltTabLockEnabled(): boolean {
  return !isAltTabTestMode()
}

export function getApiBaseUrl(): string {
  // Packaged production builds strictly lock API traffic to the official HTTPS endpoint.
  if (app.isPackaged) {
    return DEFAULT_PROD_API_BASE_URL
  }

  const configuredUrl = process.env.KIOSK_API_BASE_URL?.trim()
  if (!configuredUrl) {
    if (!process.argv.includes('--serve-built')) {
      return `${DEV_RENDERER_ORIGIN}/api/v1`
    }
    return DEFAULT_DEV_API_BASE_URL
  }

  try {
    const parsedUrl = new URL(configuredUrl)
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      return DEFAULT_DEV_API_BASE_URL
    }
    return `${parsedUrl.origin}${parsedUrl.pathname.replace(/\/$/, '')}`
  } catch {
    return DEFAULT_DEV_API_BASE_URL
  }
}

export function isAllowedR2UploadHostname(hostname: string, isPackaged: boolean): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, '')
  if (!normalized) return false

  if (normalized.endsWith(R2_HOST_SUFFIX) && normalized.length > R2_HOST_SUFFIX.length) {
    return true
  }

  if (!isPackaged && DEV_ALLOWED_R2_HOSTS.has(normalized)) {
    return true
  }

  return false
}

export function getDevRendererUrl(): string {
  return DEV_RENDERER_ORIGIN
}

export function isTrustedRendererUrl(candidate: string, electronDirectory: string): boolean {
  try {
    const parsedUrl = new URL(candidate)
    if (parsedUrl.protocol === 'file:') {
      const expectedPath = path.resolve(electronDirectory, '..', 'dist', 'index.html')
      return path.resolve(fileURLToPath(parsedUrl)) === expectedPath
    }
    return !app.isPackaged && parsedUrl.origin === DEV_RENDERER_ORIGIN
  } catch {
    return false
  }
}
