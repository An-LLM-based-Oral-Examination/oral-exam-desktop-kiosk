import { app } from 'electron/main'
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { Readable } from 'node:stream'

export interface WindowsAgentProbe {
  deviceFingerprint: string
  displayCount: number
  vmDetected: boolean
  vmIndicators: string[]
  remoteControlDetected: boolean
  remoteControlProcesses: string[]
  disallowedProcesses: string[]
  probedAtUtc: string
}

const DEFAULT_WATCH_INTERVAL_MS = 15_000
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000
const INITIAL_RESTART_BACKOFF_MS = 1_000
const MAX_RESTART_BACKOFF_MS = 30_000
const MAX_STDOUT_LINE_BUFFER_BYTES = 64 * 1024

let watchChild: ChildProcessByStdio<null, Readable, Readable> | null = null
let watchExecutablePath: string | null = null
let watchStopped = false
let watchRestartAttempts = 0
let watchRestartTimer: NodeJS.Timeout | null = null
let latestWatchSnapshot: WindowsAgentProbe | null = null
let stdoutLineBuffer = ''
const pendingFirstSnapshotWaiters = new Set<(snapshot: WindowsAgentProbe | null) => void>()

export function parseWindowsAgentProbeLine(line: string): WindowsAgentProbe | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as WindowsAgentProbe
    if (typeof parsed?.deviceFingerprint === 'string' && typeof parsed?.displayCount === 'number') {
      return parsed
    }
    return null
  } catch {
    return null
  }
}

export function computeWatchRestartBackoffMs(attempt: number): number {
  const safeAttempt = Math.max(0, attempt)
  return Math.min(MAX_RESTART_BACKOFF_MS, INITIAL_RESTART_BACKOFF_MS * Math.pow(2, safeAttempt))
}

function resolveWindowsAgentExecutable(electronDirectory: string): string | null {
  if (process.platform !== 'win32') return null

  const candidates = app.isPackaged
    ? process.resourcesPath
      ? [path.join(process.resourcesPath, 'native', 'Oes.WindowsAgent', 'Oes.WindowsAgent.exe')]
      : []
    : [
        path.resolve(electronDirectory, '..', 'native', 'dist', 'Oes.WindowsAgent', 'Oes.WindowsAgent.exe'),
        path.resolve(
          electronDirectory,
          '..',
          'native',
          'Oes.WindowsAgent',
          'bin',
          'Release',
          'net8.0',
          'Oes.WindowsAgent.exe',
        ),
        path.resolve(
          electronDirectory,
          '..',
          'native',
          'Oes.WindowsAgent',
          'bin',
          'Debug',
          'net8.0',
          'Oes.WindowsAgent.exe',
        ),
      ]

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  return null
}

function resolveSnapshotWaiters(snapshot: WindowsAgentProbe | null): void {
  if (pendingFirstSnapshotWaiters.size === 0) return
  for (const waiter of pendingFirstSnapshotWaiters) {
    waiter(snapshot)
  }
  pendingFirstSnapshotWaiters.clear()
}

function spawnWatchProcess(executablePath: string, intervalMs: number): void {
  if (watchStopped || watchChild) return

  watchExecutablePath = executablePath
  stdoutLineBuffer = ''

  let child: ChildProcessByStdio<null, Readable, Readable>
  try {
    child = spawn(executablePath, ['--watch', String(intervalMs), '--parent-pid', String(process.pid)], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    latestWatchSnapshot = null
    resolveSnapshotWaiters(null)
    scheduleWatchRestart(executablePath, intervalMs)
    return
  }

  watchChild = child

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdoutLineBuffer += chunk
    let newlineIdx = stdoutLineBuffer.indexOf('\n')
    while (newlineIdx >= 0) {
      const line = stdoutLineBuffer.slice(0, newlineIdx)
      stdoutLineBuffer = stdoutLineBuffer.slice(newlineIdx + 1)
      const parsed = parseWindowsAgentProbeLine(line)
      if (parsed) {
        latestWatchSnapshot = parsed
        watchRestartAttempts = 0
        resolveSnapshotWaiters(parsed)
      }
      newlineIdx = stdoutLineBuffer.indexOf('\n')
    }
    if (stdoutLineBuffer.length > MAX_STDOUT_LINE_BUFFER_BYTES) {
      stdoutLineBuffer = ''
    }
  })

  child.stderr.on('data', () => {
    // Drain stderr to prevent pipe backpressure.
  })

  child.on('error', () => {
    if (watchChild === child) {
      watchChild = null
      latestWatchSnapshot = null
      resolveSnapshotWaiters(null)
      scheduleWatchRestart(executablePath, intervalMs)
    }
  })

  child.on('exit', () => {
    if (watchChild === child) {
      watchChild = null
      latestWatchSnapshot = null
      resolveSnapshotWaiters(null)
      scheduleWatchRestart(executablePath, intervalMs)
    }
  })
}

function scheduleWatchRestart(executablePath: string, intervalMs: number): void {
  if (watchStopped || watchRestartTimer) return
  const delayMs = computeWatchRestartBackoffMs(watchRestartAttempts)
  watchRestartAttempts += 1
  watchRestartTimer = setTimeout(() => {
    watchRestartTimer = null
    if (!watchStopped) {
      spawnWatchProcess(executablePath, intervalMs)
    }
  }, delayMs)
}

export function startWindowsAgentWatch(
  electronDirectory: string,
  intervalMs = DEFAULT_WATCH_INTERVAL_MS,
  force = false,
): boolean {
  const executablePath = resolveWindowsAgentExecutable(electronDirectory)
  if (!executablePath) return false

  watchStopped = false
  if (watchRestartTimer) {
    if (!force && !watchChild && watchExecutablePath === executablePath) {
      return true
    }
    clearTimeout(watchRestartTimer)
    watchRestartTimer = null
  }

  if (watchChild && watchExecutablePath === executablePath) {
    return true
  }

  if (watchChild && watchExecutablePath !== executablePath) {
    stopWindowsAgentWatch()
    watchStopped = false
  }

  spawnWatchProcess(executablePath, intervalMs)
  return true
}

export function stopWindowsAgentWatch(): void {
  watchStopped = true
  if (watchRestartTimer) {
    clearTimeout(watchRestartTimer)
    watchRestartTimer = null
  }
  const activeChild = watchChild
  watchChild = null
  watchExecutablePath = null
  latestWatchSnapshot = null
  stdoutLineBuffer = ''
  resolveSnapshotWaiters(null)
  if (activeChild) {
    try {
      activeChild.kill()
    } catch {
      // Process may have already exited.
    }
  }
}

export function isWindowsAgentAvailable(electronDirectory: string): boolean {
  return resolveWindowsAgentExecutable(electronDirectory) !== null
}

export function getLatestWindowsAgentSnapshot(
  electronDirectory: string,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
): Promise<WindowsAgentProbe | null> {
  if (!startWindowsAgentWatch(electronDirectory, DEFAULT_WATCH_INTERVAL_MS)) {
    return Promise.resolve(null)
  }

  if (latestWatchSnapshot) {
    return Promise.resolve(latestWatchSnapshot)
  }

  if (!watchChild && !watchRestartTimer) {
    return Promise.resolve(null)
  }

  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      pendingFirstSnapshotWaiters.delete(onSnapshot)
      resolve(latestWatchSnapshot)
    }, startupTimeoutMs)

    const onSnapshot = (snapshot: WindowsAgentProbe | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(snapshot)
    }

    pendingFirstSnapshotWaiters.add(onSnapshot)
  })
}

export function probeWindowsAgent(
  electronDirectory: string,
  timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
): Promise<WindowsAgentProbe | null> {
  return getLatestWindowsAgentSnapshot(electronDirectory, timeoutMs)
}
