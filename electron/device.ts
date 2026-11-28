import { app, safeStorage } from 'electron/main'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const DEVICE_ID_REGEX = /^[A-Za-z0-9._:-]{16,128}$/
const ENCRYPTED_DEVICE_ID_FILENAME = 'kiosk-device-id.dat'
const LEGACY_DEVICE_ID_FILENAME = 'kiosk-device-id.txt'

let cachedDeviceId: string | null = null

export interface DeviceIdStorageAdapter {
  userDataDir: string
  platform: string
  isEncryptionAvailable: () => boolean
  encryptString: (plainText: string) => Buffer
  decryptString: (cipherText: Buffer) => string
}

export interface ResolveDeviceIdOptions {
  allowOverwriteExisting?: boolean
}

function generateDeviceId(platform: string): string {
  const platformTag = platform.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'desk'
  return `oes-${platformTag}-${randomUUID()}`
}

export function normalizeValidDeviceId(candidate: string | null | undefined): string | null {
  if (typeof candidate !== 'string') return null
  const trimmed = candidate.trim()
  return DEVICE_ID_REGEX.test(trimmed) ? trimmed : null
}

function writeFileAtomically(filePath: string, data: string | Buffer, encoding?: BufferEncoding): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  try {
    if (encoding) {
      writeFileSync(tempPath, data, { encoding })
    } else {
      writeFileSync(tempPath, data)
    }
    renameSync(tempPath, filePath)
  } catch (err) {
    if (existsSync(tempPath)) {
      rmSync(tempPath, { force: true })
    }
    throw err
  }
}

function persistDeviceId(
  deviceId: string,
  adapter: DeviceIdStorageAdapter,
  encryptedFilePath: string,
  fallbackFilePath: string,
): void {
  try {
    mkdirSync(adapter.userDataDir, { recursive: true })
    if (adapter.isEncryptionAvailable()) {
      const cipherText = adapter.encryptString(deviceId)
      writeFileAtomically(encryptedFilePath, cipherText)
      if (existsSync(fallbackFilePath)) {
        rmSync(fallbackFilePath, { force: true })
      }
      return
    }

    writeFileAtomically(fallbackFilePath, deviceId, 'utf8')
  } catch {
    // Keep in-memory device id for this session if userData is read-only.
  }
}

function readPersistedDeviceId(
  adapter: DeviceIdStorageAdapter,
  encryptedFilePath: string,
  fallbackFilePath: string,
): string | null {
  if (adapter.isEncryptionAvailable() && existsSync(encryptedFilePath)) {
    try {
      const encryptedBytes = readFileSync(encryptedFilePath)
      const decrypted = normalizeValidDeviceId(adapter.decryptString(encryptedBytes))
      if (decrypted) return decrypted
    } catch {
      // Encrypted blob unreadable or from another user profile; try legacy/regenerate below.
    }
  }

  if (existsSync(fallbackFilePath)) {
    try {
      const legacyValue = normalizeValidDeviceId(readFileSync(fallbackFilePath, 'utf8'))
      if (legacyValue) {
        if (adapter.isEncryptionAvailable()) {
          persistDeviceId(legacyValue, adapter, encryptedFilePath, fallbackFilePath)
        }
        return legacyValue
      }
    } catch {
      // Unreadable fallback file; regenerate below.
    }
  }

  return null
}

export function resolveDeviceIdWithAdapter(
  adapter: DeviceIdStorageAdapter,
  agentFingerprint?: string | null,
  options?: ResolveDeviceIdOptions,
): string {
  const encryptedFilePath = path.join(adapter.userDataDir, ENCRYPTED_DEVICE_ID_FILENAME)
  const fallbackFilePath = path.join(adapter.userDataDir, LEGACY_DEVICE_ID_FILENAME)
  const preferredFingerprint = normalizeValidDeviceId(agentFingerprint)
  const allowOverwriteExisting = options?.allowOverwriteExisting ?? true

  if (!allowOverwriteExisting) {
    const persisted = readPersistedDeviceId(adapter, encryptedFilePath, fallbackFilePath)
    if (persisted) return persisted
  }

  if (preferredFingerprint) {
    persistDeviceId(preferredFingerprint, adapter, encryptedFilePath, fallbackFilePath)
    return preferredFingerprint
  }

  const persisted = readPersistedDeviceId(adapter, encryptedFilePath, fallbackFilePath)
  if (persisted) return persisted

  const created = generateDeviceId(adapter.platform)
  persistDeviceId(created, adapter, encryptedFilePath, fallbackFilePath)
  return created
}

export function resetCachedDeviceId(): void {
  cachedDeviceId = null
}

export function getOrCreatePersistentDeviceId(
  agentFingerprint?: string | null,
  options?: ResolveDeviceIdOptions,
): string {
  const allowOverwriteExisting = options?.allowOverwriteExisting ?? false
  const preferredFingerprint = normalizeValidDeviceId(agentFingerprint)
  if (
    cachedDeviceId &&
    (!allowOverwriteExisting || !preferredFingerprint || cachedDeviceId === preferredFingerprint)
  ) {
    return cachedDeviceId
  }

  const resolved = resolveDeviceIdWithAdapter(
    {
      userDataDir: app.getPath('userData'),
      platform: process.platform,
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (plainText) => safeStorage.encryptString(plainText),
      decryptString: (cipherText) => safeStorage.decryptString(cipherText),
    },
    preferredFingerprint,
    { allowOverwriteExisting },
  )

  cachedDeviceId = resolved
  return resolved
}
