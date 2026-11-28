import { app, BrowserWindow, ipcMain, Menu, net, session } from 'electron/main'
import path from 'node:path'
import {
  getApiBaseUrl,
  getDevRendererUrl,
  isAllowedR2UploadHostname,
  isAltTabTestMode,
  isTrustedRendererUrl,
  isWindowLockdownEnabled,
} from './config'
import { getOrCreatePersistentDeviceId } from './device'
import {
  configureWindowSecurity,
  enforceKioskWindow,
  getDisplayCount,
  watchDisplayChanges,
  type KioskSecurityEvent,
} from './security'
import {
  getLatestWindowsAgentSnapshot,
  isWindowsAgentAvailable,
  startWindowsAgentWatch,
  stopWindowsAgentWatch,
} from './windows-agent'

const electronDirectory = __dirname
const MAX_R2_UPLOAD_BYTES = 26 * 1024 * 1024
const ALLOWED_UPLOAD_HEADER_NAMES = new Set(['content-type', 'if-none-match'])
let mainWindow: BrowserWindow | null = null
let exitAuthorized = false
let stopDisplayWatcher: (() => void) | null = null

function isTrustedSender(sender: Electron.WebContents): boolean {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && sender === mainWindow.webContents)
}

function sendSecurityEventToRenderer(event: KioskSecurityEvent): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('kiosk:security-event', event)
}

type R2UploadPayload = {
  uploadUrl?: unknown
  headers?: unknown
  data?: unknown
}

function hasHeaderIgnoreCase(
  headers: Record<string, string | string[]>,
  targetLowerCase: string,
): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === targetLowerCase)
}

function deleteHeaderIgnoreCase(headers: Record<string, string>, targetLowerCase: string): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === targetLowerCase) {
      delete headers[key]
    }
  }
}

function deleteHeaderIgnoreCaseArray(
  headers: Record<string, string | string[]>,
  targetLowerCase: string,
): void {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === targetLowerCase) {
      delete headers[key]
    }
  }
}

function sanitizeUploadHeaders(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const sanitized: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') continue
    const cleanKey = key.replace(/[\r\n]/g, '').trim()
    const lowerKey = cleanKey.toLowerCase()
    if (!cleanKey || /[\r\n]/.test(key)) continue
    if (!ALLOWED_UPLOAD_HEADER_NAMES.has(lowerKey) && !lowerKey.startsWith('x-amz-')) {
      continue
    }
    deleteHeaderIgnoreCase(sanitized, lowerKey)
    sanitized[cleanKey] = value.replace(/[\r\n]+/g, ' ').trim()
  }
  return sanitized
}

function toUploadUint8Array(raw: unknown): Uint8Array | null {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  }
  if (Buffer.isBuffer(raw)) return new Uint8Array(raw)
  return null
}

function configureIpc(): void {
  ipcMain.handle('runtime-info', async (event) => {
    if (!isTrustedSender(event.sender)) return null

    const appVersion = app.getVersion()
    const windowsAgent = await getLatestWindowsAgentSnapshot(electronDirectory)
    return {
      appName: 'Oral Exam Desktop Kiosk',
      appVersion,
      isPackaged: app.isPackaged,
      kioskMode: isWindowLockdownEnabled(),
      altTabTestMode: isAltTabTestMode(),
      platform: process.platform,
      apiBaseUrl: getApiBaseUrl(),
      deviceId: getOrCreatePersistentDeviceId(windowsAgent?.deviceFingerprint),
      kioskVersion: `desktop-kiosk-${appVersion}`,
      displayCount: getDisplayCount(),
      isFullscreen: mainWindow ? mainWindow.isFullScreen() : false,
      windowsAgentAvailable: isWindowsAgentAvailable(electronDirectory),
    }
  })

  ipcMain.handle('security-snapshot', async (event) => {
    if (!isTrustedSender(event.sender)) return null

    const windowsAgent = await getLatestWindowsAgentSnapshot(electronDirectory, 5_000)
    const displayCount = Math.max(getDisplayCount(), windowsAgent?.displayCount ?? 1)
    return {
      deviceId: getOrCreatePersistentDeviceId(windowsAgent?.deviceFingerprint, {
        allowOverwriteExisting: false,
      }),
      displayCount,
      isFullscreen: mainWindow ? mainWindow.isFullScreen() : false,
      windowsAgent,
    }
  })

  ipcMain.handle('request-exit', (event) => {
    if (!isTrustedSender(event.sender) || (isWindowLockdownEnabled() && !exitAuthorized)) return false
    app.quit()
    return true
  })

  ipcMain.handle('authorize-exit-after-submit', (event) => {
    if (!isTrustedSender(event.sender)) return false
    exitAuthorized = true
    return true
  })

  ipcMain.handle('upload-audio-to-r2', async (event, payload: R2UploadPayload) => {
    if (!isTrustedSender(event.sender)) {
      return {
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        headers: {},
        errorMessage: 'Untrusted renderer sender.',
      }
    }

    if (typeof payload?.uploadUrl !== 'string' || !payload.uploadUrl.trim()) {
      return {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        headers: {},
        errorMessage: 'Missing presigned R2 upload URL.',
      }
    }

    let parsedUrl: URL
    try {
      parsedUrl = new URL(payload.uploadUrl)
    } catch {
      return {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        headers: {},
        errorMessage: 'Invalid presigned R2 upload URL.',
      }
    }

    if (parsedUrl.username || parsedUrl.password) {
      return {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        headers: {},
        errorMessage: 'Presigned R2 upload URL must not contain embedded credentials.',
      }
    }

    const isAllowedUploadProtocol = app.isPackaged
      ? parsedUrl.protocol === 'https:'
      : parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'http:'

    if (!isAllowedUploadProtocol) {
      return {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        headers: {},
        errorMessage: app.isPackaged
          ? 'Packaged Kiosk requires HTTPS for R2 upload URL.'
          : 'Unsupported protocol for R2 upload URL.',
      }
    }

    if (app.isPackaged && parsedUrl.port !== '' && parsedUrl.port !== '443') {
      return {
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        headers: {},
        errorMessage: 'Packaged Kiosk only allows HTTPS port 443 for R2 upload URL.',
      }
    }

    if (!isAllowedR2UploadHostname(parsedUrl.hostname, app.isPackaged)) {
      return {
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        headers: {},
        errorMessage: app.isPackaged
          ? 'Packaged Kiosk only allows R2 uploads to *.r2.cloudflarestorage.com.'
          : 'Disallowed hostname for R2 upload URL.',
      }
    }

    const bodyBytes = toUploadUint8Array(payload.data)
    if (!bodyBytes) {
      return {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        headers: {},
        errorMessage: 'Missing or invalid audio binary buffer.',
      }
    }
    if (bodyBytes.byteLength === 0) {
      return {
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        headers: {},
        errorMessage: 'Audio binary buffer must not be empty.',
      }
    }
    if (bodyBytes.byteLength > MAX_R2_UPLOAD_BYTES) {
      return {
        ok: false,
        status: 413,
        statusText: 'Payload Too Large',
        headers: {},
        errorMessage: 'Audio binary buffer exceeds 26 MiB limit.',
      }
    }

    const headers = sanitizeUploadHeaders(payload.headers)
    try {
      const response = await net.fetch(parsedUrl.toString(), {
        method: 'PUT',
        headers,
        body: Buffer.from(bodyBytes),
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      })
      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value
      })
      const bodyText = await response.text().catch(() => '')
      return {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
        bodyText: bodyText ? bodyText.slice(0, 2000) : undefined,
      }
    } catch (uploadError) {
      return {
        ok: false,
        status: 0,
        statusText: 'Network Error',
        headers: {},
        errorMessage:
          uploadError instanceof Error
            ? uploadError.message
            : 'R2 upload request failed in main process.',
      }
    }
  })
}

async function createMainWindow(): Promise<void> {
  const kioskMode = isWindowLockdownEnabled()
  exitAuthorized = false
  const preloadPath = path.join(electronDirectory, 'preload.cjs')

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 720,
    show: false,
    fullscreen: kioskMode,
    kiosk: kioskMode,
    frame: !kioskMode,
    closable: !kioskMode,
    minimizable: !kioskMode,
    maximizable: !kioskMode,
    skipTaskbar: kioskMode,
    alwaysOnTop: kioskMode,
    autoHideMenuBar: true,
    backgroundColor: '#08111f',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath,
    },
  })

  configureWindowSecurity(mainWindow, electronDirectory, sendSecurityEventToRenderer)
  stopDisplayWatcher?.()
  stopDisplayWatcher = watchDisplayChanges(sendSecurityEventToRenderer)

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    if (mainWindow) enforceKioskWindow(mainWindow)
  })
  mainWindow.on('close', (event) => {
    if (!isWindowLockdownEnabled() || exitAuthorized) return
    event.preventDefault()
    if (mainWindow) enforceKioskWindow(mainWindow)
  })
  mainWindow.on('minimize', () => {
    if (mainWindow) enforceKioskWindow(mainWindow)
  })
  mainWindow.on('blur', () => {
    if (mainWindow) setTimeout(() => mainWindow && enforceKioskWindow(mainWindow), 0)
  })
  mainWindow.on('closed', () => {
    stopDisplayWatcher?.()
    stopDisplayWatcher = null
    mainWindow = null
  })

  if (!app.isPackaged && !process.argv.includes('--serve-built')) {
    await mainWindow.loadURL(getDevRendererUrl())
    return
  }

  await mainWindow.loadFile(path.join(electronDirectory, '..', 'dist', 'index.html'))
}

function configureApiCorsBridge(): void {
  const apiBaseUrl = getApiBaseUrl()
  const apiOrigin = new URL(apiBaseUrl).origin
  const devOrigin = new URL(getDevRendererUrl()).origin
  if (!app.isPackaged && apiOrigin === devOrigin) {
    return
  }

  const normalizedApiPrefix = apiBaseUrl.replace(/\/+$/, '')
  const filter = { urls: [`${normalizedApiPrefix}/*`] }

  const isMainWindowRequest = (webContentsId: number | undefined): boolean => {
    if (typeof webContentsId !== 'number' || !mainWindow || mainWindow.isDestroyed()) return true
    return webContentsId === mainWindow.webContents.id
  }

  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    if (!isMainWindowRequest(details.webContentsId)) {
      callback({ requestHeaders: details.requestHeaders })
      return
    }
    const requestHeaders = { ...details.requestHeaders }
    if (details.method.toUpperCase() === 'OPTIONS') {
      // Preserve Origin on CORS preflight so ASP.NET Core CorsMiddleware handles OPTIONS
      // and returns 204 instead of falling through to routing and returning 405.
      if (!hasHeaderIgnoreCase(requestHeaders, 'origin')) {
        requestHeaders.Origin = 'null'
      }
    } else {
      deleteHeaderIgnoreCase(requestHeaders, 'origin')
    }
    callback({ requestHeaders })
  })

  session.defaultSession.webRequest.onHeadersReceived(filter, (details, callback) => {
    if (!isMainWindowRequest(details.webContentsId)) {
      callback({ responseHeaders: details.responseHeaders })
      return
    }
    const responseHeaders: Record<string, string | string[]> = { ...(details.responseHeaders ?? {}) }
    deleteHeaderIgnoreCaseArray(responseHeaders, 'access-control-allow-origin')
    responseHeaders['Access-Control-Allow-Origin'] = ['*']
    if (!hasHeaderIgnoreCase(responseHeaders, 'access-control-allow-headers')) {
      responseHeaders['Access-Control-Allow-Headers'] = [
        'Authorization, Content-Type, Accept, X-Device-Id, X-Kiosk-Version, X-Kiosk-Session-Token',
      ]
    }
    if (!hasHeaderIgnoreCase(responseHeaders, 'access-control-allow-methods')) {
      responseHeaders['Access-Control-Allow-Methods'] = ['GET, POST, PUT, PATCH, DELETE, OPTIONS']
    }
    callback({ responseHeaders })
  })
}

function isAudioOnlyMediaPermission(details?: { mediaTypes?: ReadonlyArray<string> }): boolean {
  const mediaTypes = details?.mediaTypes
  if (!Array.isArray(mediaTypes)) return true
  return mediaTypes.length > 0 && mediaTypes.every((type) => type === 'audio')
}

app.on('certificate-error', (event, _webContents, url, _error, _certificate, callback) => {
  if (!app.isPackaged && url.startsWith('https://host.docker.internal:9000/')) {
    event.preventDefault()
    callback(true)
    return
  }
  callback(false)
})

const hasSingleInstanceLock =
  typeof app.requestSingleInstanceLock === 'function' ? app.requestSingleInstanceLock() : true

if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      enforceKioskWindow(mainWindow)
    }
  })

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    startWindowsAgentWatch(electronDirectory, 15_000)
    configureIpc()
    configureApiCorsBridge()
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const allowed =
        permission === 'media' &&
        isTrustedSender(webContents) &&
        isAudioOnlyMediaPermission(details as { mediaTypes?: ReadonlyArray<string> } | undefined)
      callback(allowed)
    })
    session.defaultSession.setPermissionCheckHandler?.((webContents, permission, _origin, details) => {
      if (!webContents || !isTrustedSender(webContents)) return false
      if (permission !== 'media') return false
      return isAudioOnlyMediaPermission(details as { mediaTypes?: ReadonlyArray<string> } | undefined)
    })
    await createMainWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createMainWindow()
    })
  })
}

app.on('before-quit', () => {
  stopWindowsAgentWatch()
})

app.on('will-quit', () => {
  stopWindowsAgentWatch()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, navigationUrl) => {
    if (!isTrustedRendererUrl(navigationUrl, electronDirectory)) event.preventDefault()
  })
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
})
