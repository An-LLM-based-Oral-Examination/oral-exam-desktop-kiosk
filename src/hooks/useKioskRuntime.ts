import { useCallback, useEffect, useState } from 'react'

const defaultRuntimeInfo: KioskRuntimeInfo = {
  appName: 'Oral Exam Desktop Kiosk',
  appVersion: 'development',
  isPackaged: false,
  isKioskMode: false,
  altTabTestMode: false,
  platform: 'renderer',
  apiBaseUrl: 'http://127.0.0.1:5000/api/v1',
  deviceId: '',
  kioskVersion: 'desktop-kiosk-development',
  displayCount: 1,
  isFullscreen: false,
  windowsAgentAvailable: false,
}

export interface UseKioskRuntimeResult {
  runtimeInfo: KioskRuntimeInfo
  runtimeReady: boolean
  runtimeError: string
  syncDeviceId: (nextDeviceId: string) => void
  retryRuntimeInit: () => void
}

export function useKioskRuntime(): UseKioskRuntimeResult {
  const hasBridge = typeof window !== 'undefined' && typeof window.kioskApi?.getRuntimeInfo === 'function'
  const [runtimeInfo, setRuntimeInfo] = useState<KioskRuntimeInfo>(defaultRuntimeInfo)
  const [runtimeReady, setRuntimeReady] = useState<boolean>(() => !hasBridge)
  const [runtimeError, setRuntimeError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const getRuntimeInfo = window.kioskApi?.getRuntimeInfo
    if (!getRuntimeInfo) {
      setRuntimeReady(true)
      setRuntimeError('')
      return
    }

    let mounted = true
    setRuntimeReady(false)
    setRuntimeError('')
    getRuntimeInfo()
      .then((info) => {
        if (!mounted) return
        if (info) {
          setRuntimeInfo(info)
          setRuntimeReady(true)
          setRuntimeError('')
        } else {
          setRuntimeReady(false)
          setRuntimeError('Không nhận được thông tin môi trường Kiosk từ tiến trình chính. Vui lòng thử lại.')
        }
      })
      .catch(() => {
        if (!mounted) return
        setRuntimeReady(false)
        setRuntimeError('Không thể khởi tạo định danh thiết bị và cấu hình Kiosk. Vui lòng thử lại.')
      })

    return () => {
      mounted = false
    }
  }, [attempt])

  const syncDeviceId = useCallback((nextDeviceId: string) => {
    const trimmed = nextDeviceId.trim()
    if (!trimmed) return
    setRuntimeInfo((current) =>
      current.deviceId === trimmed ? current : { ...current, deviceId: trimmed },
    )
  }, [])

  const retryRuntimeInit = useCallback(() => {
    setAttempt((current) => current + 1)
  }, [])

  return {
    runtimeInfo,
    runtimeReady,
    runtimeError,
    syncDeviceId,
    retryRuntimeInit,
  }
}
