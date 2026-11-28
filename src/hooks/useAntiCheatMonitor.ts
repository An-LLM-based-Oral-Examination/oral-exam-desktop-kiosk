import { useEffect, useRef } from 'react'
import type { AntiCheatSeverity } from '../types/mf04.types'

interface UseAntiCheatMonitorOptions {
  active: boolean
  altTabTestMode: boolean
  platform?: string
  onWindowBlur: (eventType: string) => Promise<void>
  onSecurityEvent: (eventType: string, details: string, severity?: AntiCheatSeverity) => Promise<void>
  onAgentDisconnect?: (message: string) => void
  agentPollIntervalMs?: number
}

export function useAntiCheatMonitor({
  active,
  altTabTestMode,
  platform = 'renderer',
  onWindowBlur,
  onSecurityEvent,
  onAgentDisconnect,
  agentPollIntervalMs = 60_000,
}: UseAntiCheatMonitorOptions): void {
  const callbacksRef = useRef({ onWindowBlur, onSecurityEvent, onAgentDisconnect })
  callbacksRef.current = { onWindowBlur, onSecurityEvent, onAgentDisconnect }
  const reportedSignaturesRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!active) {
      reportedSignaturesRef.current.clear()
      return
    }

    const onVisibilityChange = () => {
      if (!altTabTestMode && document.visibilityState !== 'visible') {
        void callbacksRef.current.onWindowBlur('WINDOW_BLUR')
      }
    }

    const onBlur = () => {
      if (!altTabTestMode) {
        void callbacksRef.current.onWindowBlur('WINDOW_BLUR')
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      const blocked =
        (!altTabTestMode && event.altKey && key === 'tab') ||
        (event.altKey && (key === 'f4' || key === 'arrowleft' || key === 'arrowright')) ||
        (event.metaKey && key === 'tab') ||
        (event.ctrlKey && ['tab', 'r', 'l', 'w', 'q'].includes(key)) ||
        ['f5', 'f11', 'f12', 'escape'].includes(key)

      if (blocked) {
        event.preventDefault()
        void callbacksRef.current.onSecurityEvent('TAB_SWITCH', `Phím bị chặn: ${event.key}`, 'HIGH')
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('blur', onBlur)
    window.addEventListener('keydown', onKeyDown, true)

    const unsubscribeMain = window.kioskApi?.onSecurityEvent((securityEvent) => {
      if (altTabTestMode && securityEvent.eventType === 'TAB_SWITCH') return
      const severity: AntiCheatSeverity = securityEvent.eventType === 'MULTI_MONITOR' ? 'HIGH' : 'HIGH'
      void callbacksRef.current.onSecurityEvent(securityEvent.eventType, securityEvent.details, severity)
    })

    const scanNativeEnvironment = async () => {
      const snapshot = await window.kioskApi?.getSecuritySnapshot().catch(() => null)
      const reportOnce = (signature: string, eventType: string, details: string, severity: AntiCheatSeverity) => {
        if (reportedSignaturesRef.current.has(signature)) return
        reportedSignaturesRef.current.add(signature)
        void callbacksRef.current.onSecurityEvent(eventType, details, severity)
      }

      if (!snapshot) {
        if (platform === 'win32') {
          const message = 'Mất kết nối tác nhân giám sát Windows (Oes.WindowsAgent) trong giờ thi.'
          reportOnce('WINDOWS_AGENT_DISCONNECTED', 'DEVICE_DISCONNECTION', message, 'CRITICAL')
          callbacksRef.current.onAgentDisconnect?.(message)
        }
        return
      }

      if (snapshot.displayCount > 1) {
        reportOnce(
          `MULTI_MONITOR:${snapshot.displayCount}`,
          'MULTI_MONITOR',
          `Phát hiện ${snapshot.displayCount} màn hình đang kết nối trong giờ thi.`,
          'HIGH',
        )
      }

      const agent = snapshot.windowsAgent
      if (!agent) {
        if (platform === 'win32') {
          const message = 'Mất kết nối tác nhân giám sát Windows (Oes.WindowsAgent) trong giờ thi.'
          reportOnce('WINDOWS_AGENT_DISCONNECTED', 'DEVICE_DISCONNECTION', message, 'CRITICAL')
          callbacksRef.current.onAgentDisconnect?.(message)
        }
        return
      }

      reportedSignaturesRef.current.delete('WINDOWS_AGENT_DISCONNECTED')

      if (agent.vmDetected && agent.vmIndicators.length > 0) {
        const list = agent.vmIndicators.join(', ')
        reportOnce(`VM:${list}`, 'VM_DETECTED', `Phát hiện tiến trình máy ảo: ${list}`, 'CRITICAL')
      }

      if (agent.remoteControlDetected && agent.remoteControlProcesses.length > 0) {
        const list = agent.remoteControlProcesses.join(', ')
        reportOnce(
          `REMOTE:${list}`,
          'REMOTE_CONTROL',
          `Phát hiện phần mềm điều khiển từ xa: ${list}`,
          'CRITICAL',
        )
      }

      if (agent.disallowedProcesses.length > 0) {
        const list = agent.disallowedProcesses.join(', ')
        reportOnce(
          `DISALLOWED:${list}`,
          'DISALLOWED_PROCESS',
          `Phát hiện tiến trình không được phép: ${list}`,
          'HIGH',
        )
      }
    }

    void scanNativeEnvironment()
    const pollTimer = window.setInterval(() => {
      void scanNativeEnvironment()
    }, agentPollIntervalMs)

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('keydown', onKeyDown, true)
      unsubscribeMain?.()
      window.clearInterval(pollTimer)
    }
  }, [active, agentPollIntervalMs, altTabTestMode, platform])
}
