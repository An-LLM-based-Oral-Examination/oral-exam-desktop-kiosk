import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { useAntiCheatMonitor } from './hooks/useAntiCheatMonitor'
import { useKioskHeartbeat } from './hooks/useKioskHeartbeat'
import { useKioskRuntime } from './hooks/useKioskRuntime'
import { BlockedScreen } from './screens/BlockedScreen'
import { ExamScreen } from './screens/ExamScreen'
import { LobbyScreen } from './screens/LobbyScreen'
import { PreCheckScreen } from './screens/PreCheckScreen'
import { SignInScreen } from './screens/SignInScreen'
import { SubmittedScreen } from './screens/SubmittedScreen'
import { WaitingTicketScreen } from './screens/WaitingTicketScreen'
import {
  ApiClient,
  ApiProblemError,
  classifyByodConflict,
  describeByodConflict,
  isTicketLockedError,
  isTicketNotInProgressError,
  isValidKioskDeviceId,
} from './services/api'
import {
  buildTurnDraftKey,
  clearTicketAntiCheatLogs,
  clearTicketDrafts,
  loadTicketTurnDrafts,
  savePendingAntiCheatLog,
  saveTurnDraft,
} from './services/offline-draft'
import {
  executeTurnUploadAndSubmit,
  flushPendingAntiCheatLogsQueue,
  flushPendingTurnDraftsQueue,
} from './services/turn-sync'
import type {
  ActiveFollowUpState,
  AntiCheatSeverity,
  BlockReason,
  ByodConflictCode,
  KioskHeartbeatResponse,
  OfficialExamTicketStateResponse,
  ScreenId,
  SessionRevokedEvent,
  StudentWorkstationTicket,
} from './types/mf04.types'
import { retryOnce, sha256HexAndBase64 } from './utils/crypto'
import { errorMessage, isStudentRole } from './utils/formatters'
import { evaluateTranscriptEdit } from './utils/transcript-diff'

const stepperSteps: Array<{ id: ScreenId; label: string }> = [
  { id: 'sign-in', label: 'Đăng nhập' },
  { id: 'pre-check', label: 'Thiết bị' },
  { id: 'lobby', label: 'Phòng chờ' },
  { id: 'exam', label: 'Làm bài' },
]

const submittedStatuses = new Set(['SUBMITTED', 'AI_GRADED', 'AUDITED', 'PUBLISHED', 'LOCKED'])
const LIVE_MIC_WINDOW_MS = 4_000

function hasLiveAudioTrack(stream: MediaStream | null | undefined): stream is MediaStream {
  return Boolean(
    stream &&
      stream
        .getAudioTracks()
        .some((track) => track.readyState === 'live' || track.readyState === undefined),
  )
}

const MIC_LOW_SENTENCE_REGEX =
  /Tín hiệu micro quá nhỏ hoặc đang bị tắt tiếng \(MICROPHONE_LOW_SIGNAL\)\. Vui lòng kiểm tra lại thiết bị thu âm\./gi

function isMicLowNotice(message: string): boolean {
  const upper = message.toUpperCase()
  const lower = message.toLowerCase()
  return (
    upper.includes('MICROPHONE_LOW_SIGNAL') ||
    lower.includes('tín hiệu micro') ||
    lower.includes('micro yếu') ||
    lower.includes('âm lượng micro')
  )
}

function splitHeartbeatNotice(message: string): {
  hasMicLow: boolean
  nonMicNotice: string
} {
  const trimmed = message.trim()
  const hasMicLow = isMicLowNotice(trimmed)
  if (!hasMicLow) {
    return { hasMicLow: false, nonMicNotice: trimmed }
  }
  const stripped = trimmed.replace(MIC_LOW_SENTENCE_REGEX, '').replace(/\s{2,}/g, ' ').trim()
  if (stripped !== trimmed) {
    return { hasMicLow: true, nonMicNotice: stripped }
  }
  const hasNonMicWarning = /\b(MULTI_MONITOR|FULLSCREEN_EXIT)\b/i.test(trimmed)
  return {
    hasMicLow: true,
    nonMicNotice: hasNonMicWarning ? trimmed : '',
  }
}

function getStepIndex(screen: ScreenId): number {
  if (screen === 'waiting-ticket') return 0
  if (screen === 'submitted') return stepperSteps.length
  const found = stepperSteps.findIndex((step) => step.id === screen)
  return found < 0 ? 0 : found
}

function resolvePendingFollowUpFromState(
  state: OfficialExamTicketStateResponse,
  maxFollowUpQuestions: number,
): ActiveFollowUpState | null {
  if (maxFollowUpQuestions <= 0 || state.followUps.length === 0) return null

  const byQuestion = new Map<string, typeof state.followUps>()
  for (const item of state.followUps) {
    const list = byQuestion.get(item.questionId) ?? []
    list.push(item)
    byQuestion.set(item.questionId, list)
  }

  for (const [questionId, items] of byQuestion.entries()) {
    const sorted = [...items].sort((a, b) => a.followUpIndex - b.followUpIndex)
    const latest = sorted[sorted.length - 1]
    if (
      latest &&
      latest.generatedFollowUpPrompt &&
      latest.followUpIndex < maxFollowUpQuestions
    ) {
      return {
        questionId,
        parentSubmissionId: latest.submissionId,
        followUpIndex: latest.followUpIndex + 1,
        maxFollowUpQuestions,
        prompt: latest.generatedFollowUpPrompt,
      }
    }
  }

  return null
}

function App() {
  const { runtimeInfo, runtimeReady, runtimeError, syncDeviceId, retryRuntimeInit } = useKioskRuntime()
  const apiClient = useMemo(
    () =>
      new ApiClient({
        baseUrl: runtimeInfo.apiBaseUrl,
        kioskVersion: runtimeInfo.kioskVersion,
      }),
    [runtimeInfo.apiBaseUrl, runtimeInfo.kioskVersion],
  )

  const syncClientDeviceId = useCallback(
    (candidateDeviceId: string | null | undefined) => {
      if (!candidateDeviceId || !isValidKioskDeviceId(candidateDeviceId)) return
      if (apiClient.getKioskSessionToken()) return
      if (apiClient.getDeviceId() !== candidateDeviceId) {
        apiClient.setDeviceId(candidateDeviceId)
      }
      syncDeviceId(candidateDeviceId)
    },
    [apiClient, syncDeviceId],
  )

  useEffect(() => {
    if (runtimeInfo.deviceId && isValidKioskDeviceId(runtimeInfo.deviceId) && !apiClient.getKioskSessionToken()) {
      apiClient.setDeviceId(runtimeInfo.deviceId)
    }
  }, [apiClient, runtimeInfo.deviceId])

  const [screen, setScreen] = useState<ScreenId>('sign-in')
  const [ticket, setTicket] = useState<StudentWorkstationTicket | null>(null)
  const [completedMainIds, setCompletedMainIds] = useState<string[]>([])
  const [questionIndex, setQuestionIndex] = useState(0)
  const [activeFollowUp, setActiveFollowUp] = useState<ActiveFollowUpState | null>(null)
  const [generatingFollowUp, setGeneratingFollowUp] = useState(false)
  const [initialTranscript, setInitialTranscript] = useState('')
  const [transcriptDraft, setTranscriptDraft] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [mustChangePassword, setMustChangePassword] = useState(false)
  const [studentName, setStudentName] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [microphoneReady, setMicrophoneReady] = useState(false)
  const [micTestSeconds, setMicTestSeconds] = useState(0)
  const [micLevel, setMicLevel] = useState(0)
  const [securitySnapshot, setSecuritySnapshot] = useState<KioskSecuritySnapshot | null>(null)
  const [scanningEnvironment, setScanningEnvironment] = useState(false)
  const [blurCount, setBlurCount] = useState(0)
  const [blockReason, setBlockReason] = useState<BlockReason>('ANTI_CHEAT')
  const [blockDetail, setBlockDetail] = useState('')
  const [checkingBlockStatus, setCheckingBlockStatus] = useState(false)
  const [clockNow, setClockNow] = useState(() => Date.now())
  const [questionStartedAt, setQuestionStartedAt] = useState<number | null>(null)
  const [recording, setRecording] = useState(false)
  const [recordingElapsedSeconds, setRecordingElapsedSeconds] = useState(0)
  const [transcribing, setTranscribing] = useState(false)
  const [transcriptReviewPending, setTranscriptReviewPending] = useState(false)
  const [transcriptBufferRemaining, setTranscriptBufferRemaining] = useState(0)
  const [pendingTurnDraftsCount, setPendingTurnDraftsCount] = useState(0)
  const [refreshingLobbyTicket, setRefreshingLobbyTicket] = useState(false)
  const [isExitPending, setIsExitPending] = useState(false)

  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const currentChunksRef = useRef<Blob[]>([])
  const analyserFrameRef = useRef<number | null>(null)
  const liveAudioContextRef = useRef<AudioContext | null>(null)
  const liveAudioLevelRef = useRef<number | null>(null)
  const liveAudioSamplesRef = useRef<Array<{ ts: number; db: number }>>([])
  const lowMicStreakRef = useRef(0)
  const micLowNoticeActiveRef = useRef(false)
  const noticeRef = useRef('')
  const refreshingLobbyRef = useRef(false)
  const blurCountRef = useRef(0)
  const lastBlurAtRef = useRef(0)
  const ticketRef = useRef<StudentWorkstationTicket | null>(null)
  const serverClockOffsetRef = useRef(0)
  const submitInFlightRef = useRef(false)
  const autoSubmitTriggeredRef = useRef(false)
  const lastAutoSubmitAttemptRef = useRef(0)
  const submitExamRef = useRef<(allowIncomplete?: boolean) => Promise<void>>(async () => undefined)
  const pendingTranscriptAudioRef = useRef<Blob | null>(null)
  const pendingTimestampsRef = useRef<string | null>(null)
  const initialTranscriptRef = useRef('')
  const transcriptDraftRef = useRef('')
  const lastValidTranscriptRef = useRef('')
  const completedMainIdsRef = useRef<string[]>([])
  const busyRef = useRef(false)
  const sessionRevokedRef = useRef(false)
  const recordingRef = useRef(false)
  const completeQuestionPromiseRef = useRef<Promise<{
    questionId: string
    followUpIndex: number
    rawVoiceTranscript: string
    finalTranscript: string
  } | null> | null>(null)
  const byodConflictRef = useRef(false)
  const screenRef = useRef<ScreenId>('sign-in')
  const examTerminatedRef = useRef(false)

  useEffect(() => {
    ticketRef.current = ticket
  }, [ticket])
  useEffect(() => {
    completedMainIdsRef.current = completedMainIds
  }, [completedMainIds])
  useEffect(() => {
    busyRef.current = busy
  }, [busy])
  useEffect(() => {
    noticeRef.current = notice
  }, [notice])

  useEffect(() => {
    if (!recording) {
      setRecordingElapsedSeconds(0)
      return
    }
    const started = Date.now()
    const timer = window.setInterval(() => {
      setRecordingElapsedSeconds(Math.floor((Date.now() - started) / 1000))
    }, 500)
    return () => window.clearInterval(timer)
  }, [recording])

  function serverNow(): number {
    return Date.now() + serverClockOffsetRef.current
  }

  const stopLiveLevelMonitor = useCallback(() => {
    if (analyserFrameRef.current !== null) {
      cancelAnimationFrame(analyserFrameRef.current)
      analyserFrameRef.current = null
    }
    if (liveAudioContextRef.current) {
      void liveAudioContextRef.current.close().catch(() => undefined)
      liveAudioContextRef.current = null
    }
    liveAudioSamplesRef.current = []
    liveAudioLevelRef.current = null
  }, [])

  const stopMicrophone = useCallback(() => {
    stopLiveLevelMonitor()
    streamRef.current?.getTracks().forEach((track) => {
      track.onended = null
      track.stop()
    })
    streamRef.current = null
    recorderRef.current = null
    recordingRef.current = false
    setRecording(false)
  }, [stopLiveLevelMonitor])

  const startLiveLevelMonitor = useCallback(
    (stream: MediaStream) => {
      stopLiveLevelMonitor()
      try {
        const audioContext = new AudioContext()
        const analyser = audioContext.createAnalyser()
        analyser.fftSize = 1024
        audioContext.createMediaStreamSource(stream).connect(analyser)
        liveAudioContextRef.current = audioContext
        const samples = new Uint8Array(analyser.fftSize)
        const measure = () => {
          analyser.getByteTimeDomainData(samples)
          let sum = 0
          for (const sample of samples) {
            const normalized = (sample - 128) / 128
            sum += normalized * normalized
          }
          const rms = Math.sqrt(sum / samples.length)
          const db = rms > 0 ? Math.max(0, Math.min(100, Math.round(20 * Math.log10(rms) + 100))) : 0
          const now = Date.now()
          const cutoff = now - LIVE_MIC_WINDOW_MS
          const nextSamples = liveAudioSamplesRef.current.filter((entry) => entry.ts >= cutoff)
          nextSamples.push({ ts: now, db })
          liveAudioSamplesRef.current = nextSamples
          let peakDb = db
          for (const entry of nextSamples) {
            if (entry.db > peakDb) peakDb = entry.db
          }
          liveAudioLevelRef.current = peakDb
          analyserFrameRef.current = requestAnimationFrame(measure)
        }
        measure()
      } catch {
        liveAudioLevelRef.current = null
      }
    },
    [stopLiveLevelMonitor],
  )

  const handleSessionRevoked = useCallback(
    (event: SessionRevokedEvent) => {
      sessionRevokedRef.current = true
      examTerminatedRef.current = true
      stopMicrophone()
      apiClient.clearSession()
      setTicket(null)
      setCompletedMainIds([])
      setQuestionIndex(0)
      setActiveFollowUp(null)
      setGeneratingFollowUp(false)
      setInitialTranscript('')
      initialTranscriptRef.current = ''
      setTranscriptDraft('')
      transcriptDraftRef.current = ''
      setTranscriptReviewPending(false)
      setTranscriptBufferRemaining(0)
      pendingTranscriptAudioRef.current = null
      pendingTimestampsRef.current = null
      autoSubmitTriggeredRef.current = false
      lastAutoSubmitAttemptRef.current = 0
      submitInFlightRef.current = false
      setMustChangePassword(false)
      setStudentName('')
      setPassword('')
      setNewPassword('')
      setNotice('')

      const reasonPrefix =
        event.reason === 'ACCOUNT_LOCKED'
          ? `Tài khoản bị khóa hoặc không hợp lệ (${event.status})`
          : event.reason === 'REFRESH_CONFLICT'
            ? `Xung đột làm mới phiên đăng nhập (${event.status})`
            : `Phiên đăng nhập đã hết hạn hoặc bị thu hồi (${event.status})`
      setError(`${reasonPrefix}: ${event.message} Bản nháp cục bộ vẫn được giữ nguyên; vui lòng đăng nhập lại.`)
      screenRef.current = 'sign-in'
      setScreen('sign-in')
    },
    [apiClient, stopMicrophone],
  )

  useEffect(() => {
    apiClient.setOnSessionRevoked(handleSessionRevoked)
    return () => {
      apiClient.setOnSessionRevoked(null)
    }
  }, [apiClient, handleSessionRevoked])

  const lockWithReason = useCallback(
    (reason: BlockReason, message: string) => {
      examTerminatedRef.current = true
      stopMicrophone()
      setBlockReason(reason)
      setBlockDetail(message)
      screenRef.current = 'blocked'
      setScreen('blocked')
      setNotice('')
      setError(message)
    },
    [stopMicrophone],
  )

  const transitionToSubmitted = useCallback(
    async (
      ticketId: string,
      noticeText = 'Bài làm đã được xác nhận lưu an toàn trên máy chủ. Không hiển thị điểm tại kiosk.',
    ) => {
      examTerminatedRef.current = true
      screenRef.current = 'submitted'
      setScreen('submitted')
      stopMicrophone()
      pendingTranscriptAudioRef.current = null
      pendingTimestampsRef.current = null
      setTranscriptReviewPending(false)
      setTranscriptBufferRemaining(0)
      await clearTicketDrafts(ticketId).catch(() => undefined)
      await clearTicketAntiCheatLogs(ticketId).catch(() => undefined)
      setPendingTurnDraftsCount(0)
      await window.kioskApi?.authorizeExitAfterSubmit().catch(() => undefined)
      apiClient.clearSession()
      setError('')
      setNotice(noticeText)
    },
    [apiClient, stopMicrophone],
  )

  const handleByodConflict = useCallback(
    (_code: ByodConflictCode, message: string) => {
      byodConflictRef.current = true
      lockWithReason('BYOD_CONFLICT', message)
    },
    [lockWithReason],
  )

  const flushPendingAntiCheatLogs = useCallback(
    async (ticketId: string) => {
      if (sessionRevokedRef.current || !apiClient.getKioskSessionToken()) return
      await flushPendingAntiCheatLogsQueue({
        apiClient,
        ticketId,
        onByodConflict: (conflict) => handleByodConflict(conflict, describeByodConflict(conflict)),
        onTicketLocked: (dto, lockErr) => {
          lockWithReason(
            'SERVER_LOCKED',
            dto?.details ||
              (lockErr ? errorMessage(lockErr) : null) ||
              'Phiên thi đã bị khóa từ máy chủ do vi phạm quy chế thi.',
          )
        },
        onBlurCountSync: (serverBlurCount) => {
          if (serverBlurCount > blurCountRef.current) {
            blurCountRef.current = serverBlurCount
            setBlurCount(serverBlurCount)
          }
        },
      })
    },
    [apiClient, handleByodConflict, lockWithReason],
  )

  const appendAntiCheatLog = useCallback(
    async (eventType: string, details: string, severity: AntiCheatSeverity = 'HIGH') => {
      const currentTicket = ticketRef.current
      const storedUser = apiClient.getStoredUser()
      if (!currentTicket || !storedUser) return
      if (submittedStatuses.has(currentTicket.status)) return
      const payload = {
        ticketId: currentTicket.id,
        shiftId: currentTicket.shiftId,
        studentId: storedUser.id,
        clientEventId: crypto.randomUUID(),
        eventType,
        severity,
        details: details.slice(0, 1900),
      } as const
      try {
        const dto = await retryOnce(() => apiClient.logAntiCheat(payload))
        if (dto) {
          const serverBlurCount =
            typeof dto.lockThreshold === 'number' && typeof dto.remainingStrikes === 'number'
              ? Math.max(0, dto.lockThreshold - dto.remainingStrikes)
              : dto.eventType === 'WINDOW_BLUR' && typeof dto.violationCount === 'number'
                ? Math.max(0, dto.violationCount)
                : null
          if (serverBlurCount !== null && serverBlurCount > blurCountRef.current) {
            blurCountRef.current = serverBlurCount
            setBlurCount(serverBlurCount)
          }
          if (dto.isLocked) {
            lockWithReason(
              'SERVER_LOCKED',
              dto.details || 'Phiên thi đã bị khóa từ máy chủ do vi phạm quy chế thi.',
            )
            return
          }
        }
      } catch (logError) {
        if (sessionRevokedRef.current) return
        const conflict = classifyByodConflict(logError)
        if (conflict) {
          handleByodConflict(conflict, describeByodConflict(conflict))
          return
        }
        if (isTicketLockedError(logError)) {
          lockWithReason('SERVER_LOCKED', errorMessage(logError))
          return
        }
        const isPermanentClientRejection =
          logError instanceof ApiProblemError && [400, 403, 404, 409, 422].includes(logError.status)
        if (!isPermanentClientRejection) {
          await savePendingAntiCheatLog(payload).catch(() => undefined)
          setNotice('Mất kết nối tạm thời; sự kiện giám sát đã được lưu cục bộ để tự động đồng bộ.')
        }
      }
    },
    [apiClient, handleByodConflict, lockWithReason],
  )

  useEffect(() => {
    const onOnline = () => {
      const currentTicket = ticketRef.current
      if (currentTicket && !submittedStatuses.has(currentTicket.status)) {
        void flushPendingAntiCheatLogs(currentTicket.id).catch(() => undefined)
      }
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [flushPendingAntiCheatLogs])

  const registerBlur = useCallback(
    async (eventType: string): Promise<void> => {
      const now = serverNow()
      if (now - lastBlurAtRef.current < 750) return
      lastBlurAtRef.current = now
      blurCountRef.current += 1
      const nextCount = blurCountRef.current
      setBlurCount(nextCount)
      await appendAntiCheatLog(eventType, `Mất tiêu điểm lần ${nextCount}`, 'HIGH')
      if (nextCount > 3) {
        lockWithReason(
          'ANTI_CHEAT',
          'Trạm thi đã bị đình chỉ do vượt quá 3 lần mất tiêu điểm. Không thể tiếp tục hoặc tự ý nộp bài từ màn hình này.',
        )
      }
    },
    [appendAntiCheatLog, lockWithReason],
  )

  useAntiCheatMonitor({
    active: screen === 'exam',
    altTabTestMode: runtimeInfo.altTabTestMode,
    platform: runtimeInfo.platform,
    onWindowBlur: registerBlur,
    onSecurityEvent: appendAntiCheatLog,
    onAgentDisconnect: (message) => {
      setNotice(message)
    },
  })

  useKioskHeartbeat({
    apiClient,
    ticketId: ticket?.id ?? null,
    enabled: (screen === 'lobby' || screen === 'exam') && ticket?.status === 'IN_PROGRESS',
    getAudioLevelDb: () => (recording ? liveAudioLevelRef.current : null),
    onServerSync: (response: KioskHeartbeatResponse) => {
      const serverTime = Date.parse(response.serverUtcNow)
      if (Number.isFinite(serverTime)) {
        serverClockOffsetRef.current = serverTime - Date.now()
        setClockNow(serverTime)
      }
      if (response.notice && !response.shouldTerminateExam && !response.isLocked) {
        const { hasMicLow, nonMicNotice } = splitHeartbeatNotice(response.notice)
        if (hasMicLow && !nonMicNotice) {
          lowMicStreakRef.current += 1
          if (lowMicStreakRef.current >= 2 && (!noticeRef.current || micLowNoticeActiveRef.current)) {
            micLowNoticeActiveRef.current = true
            setNotice(response.notice)
          }
        } else if (hasMicLow && nonMicNotice) {
          lowMicStreakRef.current += 1
          micLowNoticeActiveRef.current = false
          setNotice(lowMicStreakRef.current >= 2 ? response.notice : nonMicNotice)
        } else {
          lowMicStreakRef.current = 0
          micLowNoticeActiveRef.current = false
          setNotice(nonMicNotice)
        }
      } else {
        lowMicStreakRef.current = 0
        if (micLowNoticeActiveRef.current) {
          micLowNoticeActiveRef.current = false
          setNotice('')
        }
      }
      if (!response.isLocked && !submittedStatuses.has(response.ticketStatus)) {
        void flushPendingAntiCheatLogs(response.ticketId).catch(() => undefined)
      }
    },
    onTerminate: (response: KioskHeartbeatResponse) => {
      if (submittedStatuses.has(response.ticketStatus) && response.ticketStatus !== 'LOCKED') {
        void transitionToSubmitted(response.ticketId)
        return
      }
      if (response.deviceUnlockRequired) {
        stopMicrophone()
        lockWithReason(
          'BYOD_CONFLICT',
          response.notice ?? 'Thiết bị cần được Cán bộ Khảo thí mở khóa trước khi tiếp tục.',
        )
        return
      }
      if (response.remainingShiftSeconds === 0 && !response.isLocked) {
        const shiftStatusLower = response.shiftStatus.toLowerCase()
        if (shiftStatusLower !== 'completed' && shiftStatusLower !== 'cancelled') {
          if (!submitInFlightRef.current) {
            autoSubmitTriggeredRef.current = true
            lastAutoSubmitAttemptRef.current = serverNow()
            void submitExamRef.current(true)
          }
          return
        }
      }
      stopMicrophone()
      const lockDetailMessage =
        response.notice ??
        (!response.isLocked && response.shouldTerminateExam
          ? 'Ca thi đã kết thúc hoặc bị đóng sớm từ Cán bộ Khảo thí. Vui lòng liên hệ Giám thị phòng thi.'
          : 'Phiên thi đã được khóa hoặc ca thi đã kết thúc từ máy chủ.')
      lockWithReason('SERVER_LOCKED', lockDetailMessage)
    },
    onByodConflict: handleByodConflict,
  })

  const refreshSecuritySnapshot = useCallback(async () => {
    setScanningEnvironment(true)
    try {
      const snapshot = await window.kioskApi?.getSecuritySnapshot()
      if (snapshot) {
        setSecuritySnapshot(snapshot)
        syncClientDeviceId(snapshot.deviceId)
      }
    } finally {
      setScanningEnvironment(false)
    }
  }, [syncClientDeviceId])

  useEffect(() => {
    if (screen === 'pre-check') {
      void refreshSecuritySnapshot()
    }
  }, [refreshSecuritySnapshot, screen])

  useEffect(() => {
    if (screen !== 'exam') return
    const intervalId = window.setInterval(() => setClockNow(serverNow()), 250)
    return () => window.clearInterval(intervalId)
  }, [screen])

  useEffect(() => {
    if (screen !== 'exam' || !ticket || !transcriptReviewPending) return
    const intervalId = window.setInterval(() => {
      setTranscriptBufferRemaining((current) => Math.max(0, current - 1))
    }, 1000)
    return () => window.clearInterval(intervalId)
  }, [screen, ticket, transcriptReviewPending])

  useEffect(() => {
    if (screen !== 'exam' || !ticket || !transcriptReviewPending || transcriptBufferRemaining > 0) return
    if (submitInFlightRef.current || completeQuestionPromiseRef.current) return
    if (pendingTranscriptAudioRef.current) {
      const editCheck = evaluateTranscriptEdit(
        initialTranscriptRef.current,
        transcriptDraftRef.current,
      )
      if (editCheck.isExceeded) {
        const reverted = lastValidTranscriptRef.current || initialTranscriptRef.current
        transcriptDraftRef.current = reverted
        setTranscriptDraft(reverted)
      }
      void completeQuestion(true)
    }
  }, [screen, ticket, transcriptReviewPending, transcriptBufferRemaining])

  useEffect(() => () => stopMicrophone(), [stopMicrophone])

  useEffect(() => {
    submitExamRef.current = submitExam
  })

  useEffect(() => {
    if (screen !== 'exam' || !ticket) return
    const deadline = Date.parse(ticket.endTime)
    if (!Number.isFinite(deadline)) return
    const intervalId = window.setInterval(() => {
      const now = serverNow()
      setClockNow(now)
      if (
        now >= deadline &&
        !autoSubmitTriggeredRef.current &&
        !busyRef.current &&
        !submitInFlightRef.current &&
        !completeQuestionPromiseRef.current &&
        now - lastAutoSubmitAttemptRef.current >= 2000
      ) {
        autoSubmitTriggeredRef.current = true
        lastAutoSubmitAttemptRef.current = now
        void submitExamRef.current(true)
      }
    }, 250)
    return () => window.clearInterval(intervalId)
  }, [screen, ticket])

  async function uploadAndSubmitTurn(
    currentTicket: StudentWorkstationTicket,
    questionId: string,
    followUpIndex: number,
    parentSubmissionId: string | null,
    followUpPrompt: string | null,
    audio: Blob,
    rawVoiceTranscript: string | null,
    finalTranscript: string,
    isManuallyEdited: boolean,
    timeSpentSeconds: number,
    timestampsWhisper: string | null = null,
  ) {
    try {
      const existingDrafts = await loadTicketTurnDrafts(currentTicket.id)
      const draftKey = buildTurnDraftKey(currentTicket.id, questionId, followUpIndex)
      const existingDraft = existingDrafts.find((item) => item.metadata.draftKey === draftKey)
      const response = await executeTurnUploadAndSubmit({
        apiClient,
        ticket: currentTicket,
        questionId,
        followUpIndex,
        parentSubmissionId,
        followUpPrompt,
        audio,
        rawVoiceTranscript,
        finalTranscript,
        timestampsWhisper: timestampsWhisper ?? existingDraft?.metadata.timestampsWhisper ?? null,
        isManuallyEdited,
        timeSpentSeconds,
        nowMs: serverNow(),
        resume: existingDraft
          ? {
              stage: existingDraft.metadata.stage,
              objectKey: existingDraft.metadata.objectKey,
              sha256: existingDraft.metadata.sha256,
              sha256Base64: existingDraft.metadata.sha256Base64 ?? null,
              uploadAuthorization: existingDraft.metadata.uploadAuthorization ?? null,
              createdAt: existingDraft.metadata.createdAt,
              timestampsWhisper: existingDraft.metadata.timestampsWhisper ?? null,
            }
          : undefined,
      })
      const remainingDrafts = await loadTicketTurnDrafts(currentTicket.id)
      setPendingTurnDraftsCount(remainingDrafts.length)
      return response
    } catch (turnError) {
      const remainingDrafts = await loadTicketTurnDrafts(currentTicket.id)
      setPendingTurnDraftsCount(remainingDrafts.length)
      throw turnError
    }
  }

  async function flushPendingTurnDrafts(
    currentTicket: StudentWorkstationTicket,
    requestFollowUp = false,
  ): Promise<void> {
    await flushPendingTurnDraftsQueue({
      apiClient,
      ticket: currentTicket,
      requestFollowUp,
      nowMs: serverNow(),
      onDraftsCountChange: setPendingTurnDraftsCount,
      onByodConflict: (conflict) => handleByodConflict(conflict, describeByodConflict(conflict)),
      onTicketLocked: (lockError) => lockWithReason('SERVER_LOCKED', errorMessage(lockError)),
    })
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (!runtimeReady) {
      setError('Hệ thống Kiosk đang khởi tạo định danh thiết bị. Vui lòng chờ trong giây lát.')
      return
    }
    if (!username.trim() || !password) {
      setError('Vui lòng nhập tên đăng nhập và mật khẩu.')
      return
    }
    if (runtimeInfo.deviceId && isValidKioskDeviceId(runtimeInfo.deviceId)) {
      apiClient.setDeviceId(runtimeInfo.deviceId)
    }
    sessionRevokedRef.current = false
    byodConflictRef.current = false
    examTerminatedRef.current = false
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const response = await apiClient.login(username.trim(), password)
      if (!isStudentRole(response.user.role)) {
        apiClient.clearSession()
        throw new Error('Tài khoản này không có vai trò sinh viên cho kiosk phòng thi.')
      }
      setStudentName(response.user.fullName)
      setMustChangePassword(response.mustChangePassword)
      if (response.mustChangePassword) {
        screenRef.current = 'sign-in'
        setScreen('sign-in')
        setNotice('Tài khoản cần đổi mật khẩu trước khi vào phòng thi.')
        return
      }
      setPassword('')
      setNewPassword('')
      await continueAfterAuthentication()
    } catch (loginError) {
      if (sessionRevokedRef.current) return
      const conflict = classifyByodConflict(loginError)
      if (conflict) {
        handleByodConflict(conflict, describeByodConflict(conflict))
        return
      }
      setError(errorMessage(loginError))
    } finally {
      setBusy(false)
    }
  }

  async function handleChangePassword(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (newPassword.length < 8) {
      setError('Mật khẩu mới phải có ít nhất 8 ký tự.')
      return
    }
    sessionRevokedRef.current = false
    byodConflictRef.current = false
    examTerminatedRef.current = false
    setBusy(true)
    setError('')
    try {
      const response = await apiClient.changePassword(password, newPassword)
      setMustChangePassword(response.mustChangePassword)
      setPassword('')
      setNewPassword('')
      await continueAfterAuthentication()
    } catch (passwordError) {
      if (sessionRevokedRef.current) return
      setError(errorMessage(passwordError))
    } finally {
      setBusy(false)
    }
  }

  function handleCancelChangePassword(): void {
    sessionRevokedRef.current = false
    byodConflictRef.current = false
    examTerminatedRef.current = false
    apiClient.clearSession()
    setMustChangePassword(false)
    setStudentName('')
    setPassword('')
    setNewPassword('')
    setError('')
    setNotice('')
    screenRef.current = 'sign-in'
    setScreen('sign-in')
  }

  async function continueAfterAuthentication(): Promise<void> {
    try {
      const nextScreen = await loadTicket()
      screenRef.current = nextScreen
      setScreen(nextScreen)
    } catch (ticketError) {
      const conflict = classifyByodConflict(ticketError)
      if (conflict) {
        handleByodConflict(conflict, describeByodConflict(conflict))
        return
      }
      if (ticketError instanceof ApiProblemError && ticketError.status === 404) {
        setNotice('Đăng nhập thành công. Tài khoản chưa được cấp vé thi cho ca hiện tại; hãy thử lại sau khi Khảo thí phân bổ vé.')
        screenRef.current = 'waiting-ticket'
        setScreen('waiting-ticket')
        return
      }
      throw ticketError
    }
  }

  async function retryTicketLoad(): Promise<void> {
    sessionRevokedRef.current = false
    byodConflictRef.current = false
    examTerminatedRef.current = false
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await continueAfterAuthentication()
    } catch (ticketError) {
      if (sessionRevokedRef.current) return
      setError(errorMessage(ticketError))
    } finally {
      setBusy(false)
    }
  }

  async function loadTicket(): Promise<'pre-check' | 'submitted' | 'blocked'> {
    const loadedTicket = await apiClient.getCurrentTicket()
    setTicket(loadedTicket)
    const serverTime = Date.parse(loadedTicket.serverTimeUtc)
    if (!Number.isFinite(serverTime)) throw new Error('Thời gian máy chủ trong vé thi không hợp lệ.')
    serverClockOffsetRef.current = serverTime - Date.now()
    setClockNow(serverTime)
    setCompletedMainIds([])
    completedMainIdsRef.current = []
    setQuestionIndex(0)
    setActiveFollowUp(null)
    setGeneratingFollowUp(false)
    setInitialTranscript('')
    initialTranscriptRef.current = ''
    setTranscriptDraft('')
    transcriptDraftRef.current = ''
    setTranscriptReviewPending(false)
    setTranscriptBufferRemaining(0)
    pendingTranscriptAudioRef.current = null
    pendingTimestampsRef.current = null
    autoSubmitTriggeredRef.current = false
    lastAutoSubmitAttemptRef.current = 0

    const initialBlurCount = typeof loadedTicket.violationCount === 'number' ? loadedTicket.violationCount : 0
    blurCountRef.current = initialBlurCount
    setBlurCount(initialBlurCount)

    const localDrafts = await loadTicketTurnDrafts(loadedTicket.id)
    setPendingTurnDraftsCount(localDrafts.length)

    if (
      loadedTicket.status === 'LOCKED' ||
      (loadedTicket.isKioskLocked === true && !submittedStatuses.has(loadedTicket.status))
    ) {
      lockWithReason('SERVER_LOCKED', 'Vé thi đã bị khóa từ hệ thống. Vui lòng liên hệ Giám thị hoặc Cán bộ Khảo thí.')
      return 'blocked'
    }

    if (submittedStatuses.has(loadedTicket.status)) {
      examTerminatedRef.current = true
      try {
        await apiClient.getSubmissionStatus(loadedTicket.id)
        await clearTicketDrafts(loadedTicket.id)
        setPendingTurnDraftsCount(0)
      } catch {
        setNotice('Vé đã ghi nhận trạng thái nộp trên máy chủ.')
      }
      await window.kioskApi?.authorizeExitAfterSubmit()
      apiClient.clearSession()
      return 'submitted'
    }

    examTerminatedRef.current = false
    if (localDrafts.length > 0) {
      setNotice(`Phát hiện ${localDrafts.length} lượt trả lời đã mã hóa cục bộ. Hệ thống sẽ tự động đồng bộ sau khi điểm danh.`)
    }

    return 'pre-check'
  }

  async function syncTicketStateFromServer(currentTicket: StudentWorkstationTicket): Promise<'lobby' | 'submitted' | 'blocked'> {
    const state = await apiClient.getTicketState(currentTicket.id)
    const serverTime = Date.parse(state.serverUtcNow)
    if (Number.isFinite(serverTime)) {
      serverClockOffsetRef.current = serverTime - Date.now()
      setClockNow(serverTime)
    }

    blurCountRef.current = state.violationCount
    setBlurCount(state.violationCount)

    if (state.isKioskLocked) {
      if (submittedStatuses.has(state.status) && state.status !== 'LOCKED') {
        examTerminatedRef.current = true
        await clearTicketDrafts(currentTicket.id)
        setPendingTurnDraftsCount(0)
        await window.kioskApi?.authorizeExitAfterSubmit()
        apiClient.clearSession()
        return 'submitted'
      }
      lockWithReason(
        'SERVER_LOCKED',
        'Vé thi đã bị khóa trên máy chủ. Không thể tiếp tục hoặc tự ý nộp bài từ màn hình này.',
      )
      return 'blocked'
    }

    examTerminatedRef.current = false

    const doneMainIds = Array.from(
      new Set(state.followUps.filter((item) => item.followUpIndex === 0).map((item) => item.questionId)),
    )
    completedMainIdsRef.current = doneMainIds
    setCompletedMainIds(doneMainIds)

    const pendingFollowUp = resolvePendingFollowUpFromState(
      state,
      currentTicket.hasFollowUp ? currentTicket.maxFollowUpQuestions : 0,
    )
    if (pendingFollowUp) {
      const qIdx = currentTicket.questions.findIndex((q) => q.questionId === pendingFollowUp.questionId)
      setQuestionIndex(qIdx >= 0 ? qIdx : 0)
      setActiveFollowUp(pendingFollowUp)
      setNotice('Đã khôi phục câu hỏi phụ đang dang dở từ máy chủ. Bạn có thể tiếp tục trả lời.')
    } else {
      setActiveFollowUp(null)
      const nextIdx = currentTicket.questions.findIndex((q) => !doneMainIds.includes(q.questionId))
      setQuestionIndex(nextIdx < 0 ? Math.max(0, currentTicket.questions.length - 1) : nextIdx)
      if (doneMainIds.length > 0) {
        setNotice(`Đã khôi phục tiến độ ${doneMainIds.length}/${currentTicket.questions.length} câu hỏi từ máy chủ.`)
      }
    }

    return 'lobby'
  }

  async function startMicrophoneTest(): Promise<void> {
    stopLiveLevelMonitor()
    setBusy(true)
    setError('')
    setMicTestSeconds(0)
    setMicLevel(0)
    let acquiredStream: MediaStream | null = null
    try {
      acquiredStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current?.getTracks().forEach((track) => {
        track.onended = null
        track.stop()
      })
      streamRef.current = acquiredStream

      const audioContext = new AudioContext()
      liveAudioContextRef.current = audioContext
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 2048
      audioContext.createMediaStreamSource(acquiredStream).connect(analyser)
      const samples = new Uint8Array(analyser.fftSize)
      const startedAt = performance.now()
      const decibelSamples: number[] = []
      const testStream = acquiredStream
      const tick = () => {
        if (!hasLiveAudioTrack(testStream)) {
          analyserFrameRef.current = null
          if (liveAudioContextRef.current === audioContext) {
            liveAudioContextRef.current = null
          }
          void audioContext.close().catch(() => undefined)
          if (streamRef.current === testStream) {
            streamRef.current = null
          }
          setMicrophoneReady(false)
          setBusy(false)
          setError('Microphone bị ngắt kết nối trong quá trình kiểm tra.')
          return
        }
        const elapsed = Math.min(30, Math.floor((performance.now() - startedAt) / 1000))
        analyser.getByteTimeDomainData(samples)
        let sum = 0
        for (const sample of samples) {
          const normalized = (sample - 128) / 128
          sum += normalized * normalized
        }
        const rms = Math.sqrt(sum / samples.length)
        const decibel = rms > 0 ? Math.max(0, Math.min(100, Math.round(20 * Math.log10(rms) + 100))) : 0
        decibelSamples.push(decibel)
        setMicTestSeconds(elapsed)
        setMicLevel(decibel)
        if (elapsed < 30) {
          analyserFrameRef.current = requestAnimationFrame(tick)
        } else {
          analyserFrameRef.current = null
          const averageDecibel =
            decibelSamples.length === 0
              ? 0
              : decibelSamples.reduce((acc, value) => acc + value, 0) / decibelSamples.length
          const passingSamples = decibelSamples.filter((value) => value >= 60).length
          const passingRatio = decibelSamples.length === 0 ? 0 : passingSamples / decibelSamples.length
          const isReady = averageDecibel >= 60 && passingRatio >= 0.6
          setMicrophoneReady(isReady)
          setBusy(false)
          if (!isReady) {
            setError(`Mức micro trung bình ${Math.round(averageDecibel)} dB hoặc độ ổn định chưa đạt yêu cầu 60 dB.`)
          } else {
            setNotice(`Micro đạt trung bình ${Math.round(averageDecibel)} dB và ổn định trong 30 giây.`)
          }
          if (liveAudioContextRef.current === audioContext) {
            liveAudioContextRef.current = null
          }
          void audioContext.close().catch(() => undefined)
        }
      }
      if (analyserFrameRef.current !== null) {
        cancelAnimationFrame(analyserFrameRef.current)
        analyserFrameRef.current = null
      }
      tick()
    } catch (microphoneError) {
      if (liveAudioContextRef.current) {
        void liveAudioContextRef.current.close().catch(() => undefined)
        liveAudioContextRef.current = null
      }
      if (acquiredStream) {
        acquiredStream.getTracks().forEach((track) => {
          track.onended = null
          track.stop()
        })
        if (streamRef.current === acquiredStream) {
          streamRef.current = null
        }
      }
      setBusy(false)
      setError(errorMessage(microphoneError))
    }
  }

  async function handleCheckIn(): Promise<void> {
    if (!ticket || !microphoneReady) {
      setError('Cần hoàn tất kiểm tra micro trước khi điểm danh.')
      return
    }
    byodConflictRef.current = false
    setBusy(true)
    setError('')
    try {
      const latestSnapshot = securitySnapshot ?? (await window.kioskApi?.getSecuritySnapshot().catch(() => null))
      if (latestSnapshot) {
        setSecuritySnapshot(latestSnapshot)
        syncClientDeviceId(latestSnapshot.deviceId)
      } else {
        syncClientDeviceId(runtimeInfo.deviceId)
      }

      const checkedIn = await apiClient.checkIn(ticket.id)
      const refreshedTicket = await apiClient.getCurrentTicket()
      const updatedTicket: StudentWorkstationTicket = {
        ...refreshedTicket,
        status: checkedIn.status,
        examSetId: checkedIn.examSetId ?? refreshedTicket.examSetId,
      }
      setTicket(updatedTicket)

      await flushPendingAntiCheatLogs(updatedTicket.id).catch(() => undefined)
      if (byodConflictRef.current || sessionRevokedRef.current) return

      let flushByodConflict = false
      if (updatedTicket.questions.length > 0) {
        // Replay any pending encrypted turn drafts from previous offline session first (recovering follow-ups too).
        await flushPendingTurnDrafts(updatedTicket, true).catch((flushError: unknown) => {
          const conflict = classifyByodConflict(flushError)
          if (conflict) {
            flushByodConflict = true
            handleByodConflict(conflict, describeByodConflict(conflict))
            return
          }
          setNotice('Còn bản nháp cục bộ chưa đồng bộ hết; hệ thống sẽ thử lại khi nộp bài.')
        })
      }
      if (flushByodConflict || byodConflictRef.current || sessionRevokedRef.current) return

      const targetScreen = await syncTicketStateFromServer(updatedTicket)
      if (byodConflictRef.current || sessionRevokedRef.current) return
      if (
        targetScreen === 'lobby' &&
        (updatedTicket.questions.length === 0 ||
          updatedTicket.shiftStatus.toLowerCase() !== 'in_progress' ||
          updatedTicket.isExamPublished === false)
      ) {
        setNotice('Đã điểm danh thành công. Ca thi đang chờ mở hoặc chưa công bố bộ câu hỏi.')
      }
      screenRef.current = targetScreen
      setScreen(targetScreen)
    } catch (checkInError) {
      if (sessionRevokedRef.current) return
      const conflict = classifyByodConflict(checkInError)
      if (conflict) {
        handleByodConflict(conflict, describeByodConflict(conflict))
        return
      }
      setError(errorMessage(checkInError))
    } finally {
      setBusy(false)
    }
  }

  const refreshLobbyTicket = useCallback(async () => {
    const currentTicket = ticketRef.current
    if (!currentTicket || refreshingLobbyRef.current) return
    refreshingLobbyRef.current = true
    setRefreshingLobbyTicket(true)
    try {
      const refreshedTicket = await apiClient.getCurrentTicket()
      setTicket(refreshedTicket)
      if (
        refreshedTicket.questions.length > 0 &&
        refreshedTicket.shiftStatus.toLowerCase() === 'in_progress' &&
        refreshedTicket.isExamPublished !== false
      ) {
        let flushByodConflict = false
        await flushPendingTurnDrafts(refreshedTicket, true).catch((flushError: unknown) => {
          const conflict = classifyByodConflict(flushError)
          if (conflict) {
            flushByodConflict = true
            handleByodConflict(conflict, describeByodConflict(conflict))
            return
          }
          setNotice('Còn bản nháp cục bộ chưa đồng bộ hết; hệ thống sẽ thử lại khi nộp bài.')
        })
        if (flushByodConflict || byodConflictRef.current || sessionRevokedRef.current) return
        const targetScreen = await syncTicketStateFromServer(refreshedTicket)
        if (byodConflictRef.current || sessionRevokedRef.current) return
        if (targetScreen !== 'lobby') {
          screenRef.current = targetScreen
          setScreen(targetScreen)
        } else {
          setNotice('Bộ câu hỏi đã sẵn sàng. Bạn có thể bắt đầu làm bài.')
        }
      }
    } catch (refreshError) {
      if (sessionRevokedRef.current) return
      const conflict = classifyByodConflict(refreshError)
      if (conflict) {
        handleByodConflict(conflict, describeByodConflict(conflict))
      }
    } finally {
      refreshingLobbyRef.current = false
      setRefreshingLobbyTicket(false)
    }
  }, [apiClient, handleByodConflict])

  useEffect(() => {
    if (
      screen !== 'lobby' ||
      !ticket ||
      (ticket.questions.length > 0 &&
        ticket.shiftStatus.toLowerCase() === 'in_progress' &&
        ticket.isExamPublished !== false)
    ) {
      return
    }
    const timerId = window.setInterval(() => {
      void refreshLobbyTicket()
    }, 5_000)
    return () => window.clearInterval(timerId)
  }, [refreshLobbyTicket, screen, ticket])

  function attachTrackDisconnectWatcher(stream: MediaStream): void {
    stream.getAudioTracks().forEach((track) => {
      track.onended = () => {
        if (streamRef.current === stream) {
          streamRef.current = null
        }
        stopLiveLevelMonitor()
        const activeRecorder = recorderRef.current
        if (activeRecorder && activeRecorder.state === 'recording') {
          if (!activeRecorder.onstop) {
            activeRecorder.ondataavailable = null
            activeRecorder.onstop = () => {
              currentChunksRef.current = []
            }
          }
          try {
            activeRecorder.stop()
          } catch {
            // Ignore recorder stop errors on disconnected hardware.
          }
        }
        recorderRef.current = null
        recordingRef.current = false
        setRecording(false)
        if (ticketRef.current && !submittedStatuses.has(ticketRef.current.status)) {
          setError('Microphone bị ngắt kết nối đột ngột! Vui lòng kiểm tra lại thiết bị thu âm.')
          void appendAntiCheatLog('DEVICE_DISCONNECTION', 'Microphone bị ngắt kết nối trong giờ thi.', 'HIGH')
        }
      }
    })
  }

  async function beginQuestionRecording(): Promise<void> {
    let stream = streamRef.current
    if (!hasLiveAudioTrack(stream)) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        streamRef.current = stream
      } catch (micError) {
        setError(errorMessage(micError))
        return
      }
    }
    try {
      attachTrackDisconnectWatcher(stream)
      const recorderOptions =
        typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported('audio/webm')
          ? { mimeType: 'audio/webm' }
          : undefined
      const recorder = recorderOptions ? new MediaRecorder(stream, recorderOptions) : new MediaRecorder(stream)
      currentChunksRef.current = []
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) currentChunksRef.current.push(event.data)
      }
      recorderRef.current = recorder
      recorder.start(250)
      startLiveLevelMonitor(stream)
      recordingRef.current = true
      setRecording(true)
      setQuestionStartedAt(serverNow())
    } catch (recordError) {
      recorderRef.current = null
      recordingRef.current = false
      setRecording(false)
      stopLiveLevelMonitor()
      setError(errorMessage(recordError))
    }
  }

  function stopQuestionRecording(): Promise<Blob> {
    stopLiveLevelMonitor()
    const recorder = recorderRef.current
    if (!recorder || recorder.state === 'inactive') {
      const blob = new Blob(currentChunksRef.current, { type: 'audio/webm' })
      currentChunksRef.current = []
      recorderRef.current = null
      recordingRef.current = false
      setRecording(false)
      return Promise.resolve(blob)
    }
    return new Promise((resolve) => {
      let settled = false
      let fallbackTimer: number | undefined
      const finalize = () => {
        if (settled) return
        settled = true
        if (fallbackTimer !== undefined) {
          window.clearTimeout(fallbackTimer)
        }
        const blob = new Blob(currentChunksRef.current, { type: 'audio/webm' })
        currentChunksRef.current = []
        recorderRef.current = null
        recordingRef.current = false
        setRecording(false)
        resolve(blob)
      }
      recorder.onstop = finalize
      recorder.onerror = finalize
      fallbackTimer = window.setTimeout(finalize, 2_000)
      try {
        recorder.stop()
      } catch {
        finalize()
      }
    })
  }

  async function startExam(): Promise<void> {
    if (!ticket || !microphoneReady) return
    if (
      ticket.questions.length === 0 ||
      ticket.shiftStatus.toLowerCase() !== 'in_progress' ||
      ticket.isExamPublished === false
    ) {
      setError('Ca thi chưa mở hoặc chưa công bố bộ câu hỏi.')
      return
    }
    const startAt = Date.parse(ticket.startTime)
    const endAt = Date.parse(ticket.endTime)
    const now = serverNow()
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || now < startAt) {
      setError('Ca thi chưa mở theo thời gian do máy chủ cung cấp.')
      return
    }
    if (now >= endAt) {
      setError('Ca thi đã hết thời gian theo máy chủ.')
      return
    }
    setError('')
    setNotice('')
    if (!hasLiveAudioTrack(streamRef.current)) {
      try {
        streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch (streamError) {
        setError(errorMessage(streamError))
        return
      }
    }
    examTerminatedRef.current = false
    autoSubmitTriggeredRef.current = false
    submitInFlightRef.current = false
    setClockNow(now)
    screenRef.current = 'exam'
    setScreen('exam')
  }

  function handleToggleRecording(): void {
    if (
      busy ||
      transcribing ||
      generatingFollowUp ||
      transcriptReviewPending ||
      submitInFlightRef.current ||
      completeQuestionPromiseRef.current
    ) {
      return
    }
    if (recording) {
      void completeQuestion(false)
    } else {
      setError('')
      setNotice('')
      void beginQuestionRecording().catch((recordError) => {
        setError(errorMessage(recordError))
      })
    }
  }

  function handleTranscriptChange(nextValue: string): void {
    transcriptDraftRef.current = nextValue
    setTranscriptDraft(nextValue)
    if (transcriptReviewPending) {
      const evaluation = evaluateTranscriptEdit(initialTranscriptRef.current, nextValue)
      if (!evaluation.isExceeded) {
        lastValidTranscriptRef.current = nextValue
      }
    }
  }

  function handleRestoreOriginalTranscript(): void {
    const original = initialTranscriptRef.current
    transcriptDraftRef.current = original
    setTranscriptDraft(original)
    lastValidTranscriptRef.current = original
  }

  async function completeQuestion(isAutoBufferFinalize = false): Promise<{
    questionId: string
    followUpIndex: number
    rawVoiceTranscript: string
    finalTranscript: string
  } | null> {
    if (completeQuestionPromiseRef.current) {
      return completeQuestionPromiseRef.current
    }
    if (!ticket) return null
    const question = ticket.questions[questionIndex]
    if (!question) return null
    if (transcriptReviewPending && !pendingTranscriptAudioRef.current) {
      setTranscriptReviewPending(false)
      setTranscriptBufferRemaining(0)
      return null
    }

    const run = (async () => {
      setBusy(true)
      setError('')
      try {
        let audio = pendingTranscriptAudioRef.current
        let rawVoiceTranscript = initialTranscriptRef.current
        let finalTranscript = transcriptDraftRef.current.trim()
        let timestampsWhisper = pendingTimestampsRef.current
        const isVoiceOnly = ticket.examInputMode === 'VoiceOnly'
        const elapsed = questionStartedAt ? Math.max(1, Math.round((serverNow() - questionStartedAt) / 1000)) : 1
        const currentFollowUpIndex = activeFollowUp ? activeFollowUp.followUpIndex : 0
        const currentParentId = activeFollowUp ? activeFollowUp.parentSubmissionId : null
        const currentPrompt = activeFollowUp ? activeFollowUp.prompt : null

        if (!audio) {
          audio = await stopQuestionRecording()
          if (audio.size === 0) {
            if (submitInFlightRef.current) return null
            throw new Error('Không thu được dữ liệu âm thanh cho lượt trả lời này. Vui lòng kiểm tra micro.')
          }

          // Persist encrypted RECORDED draft BEFORE STT so network failures never lose recorded audio.
          const draftKey = buildTurnDraftKey(ticket.id, question.questionId, currentFollowUpIndex)
          const digestPair = await sha256HexAndBase64(audio)
          const nowIso = new Date(serverNow()).toISOString()
          try {
            await saveTurnDraft({
              metadata: {
                draftKey,
                ticketId: ticket.id,
                shiftId: ticket.shiftId,
                studentId: ticket.studentId,
                questionId: question.questionId,
                followUpIndex: currentFollowUpIndex,
                parentSubmissionId: currentParentId,
                followUpPrompt: currentPrompt,
                initialVoiceTranscript: null,
                transcriptWhisper: '',
                timestampsWhisper: null,
                timeSpentSeconds: elapsed,
                isManuallyEdited: false,
                objectKey: null,
                sha256: digestPair.hex,
                sha256Base64: digestPair.base64,
                uploadAuthorization: null,
                stage: 'RECORDED',
                createdAt: nowIso,
                updatedAt: nowIso,
              },
              audio,
            })
            const savedDrafts = await loadTicketTurnDrafts(ticket.id)
            setPendingTurnDraftsCount(savedDrafts.length)
          } catch {
            setNotice('Không thể lưu bản nháp cục bộ trước khi nhận diện; hệ thống vẫn tiếp tục xử lý trực tiếp.')
          }

          if (!isVoiceOnly) {
            setTranscribing(true)
            try {
              const hint = activeFollowUp
                ? `${question.title} ${activeFollowUp.prompt}`
                : `${question.title} ${question.content}`
              const transcription = await apiClient.transcribe(audio, hint, '')
              rawVoiceTranscript = transcription.text.trim()
              finalTranscript = rawVoiceTranscript
              timestampsWhisper = transcription.timestampsJson ?? null
              pendingTimestampsRef.current = timestampsWhisper
            } finally {
              setTranscribing(false)
            }

            await saveTurnDraft({
              metadata: {
                draftKey,
                ticketId: ticket.id,
                shiftId: ticket.shiftId,
                studentId: ticket.studentId,
                questionId: question.questionId,
                followUpIndex: currentFollowUpIndex,
                parentSubmissionId: currentParentId,
                followUpPrompt: currentPrompt,
                initialVoiceTranscript: rawVoiceTranscript,
                transcriptWhisper: finalTranscript,
                timestampsWhisper,
                timeSpentSeconds: elapsed,
                isManuallyEdited: false,
                objectKey: null,
                sha256: digestPair.hex,
                sha256Base64: digestPair.base64,
                uploadAuthorization: null,
                stage: 'RECORDED',
                createdAt: nowIso,
                updatedAt: new Date(serverNow()).toISOString(),
              },
              audio,
            }).catch(() => undefined)
          } else {
            rawVoiceTranscript = ''
            finalTranscript = ''
            timestampsWhisper = null
            pendingTimestampsRef.current = null
          }

          if (ticket.examInputMode === 'VoiceWithTranscriptEdit' && !submitInFlightRef.current) {
            pendingTranscriptAudioRef.current = audio
            const bufferSeconds = Math.max(10, Math.min(300, ticket.transcriptBufferSeconds))
            initialTranscriptRef.current = rawVoiceTranscript
            transcriptDraftRef.current = finalTranscript
            setInitialTranscript(rawVoiceTranscript)
            setTranscriptDraft(finalTranscript)
            lastValidTranscriptRef.current = finalTranscript
            setTranscriptReviewPending(true)
            setTranscriptBufferRemaining(bufferSeconds)
            setNotice(`Transcript đã sẵn sàng. Bạn có ${bufferSeconds} giây để rà soát thuật ngữ (tối đa 35%).`)
            return null
          }
        }

        let isManuallyEdited = false
        if (isVoiceOnly) {
          finalTranscript = rawVoiceTranscript
          isManuallyEdited = false
        } else {
          const editEval = evaluateTranscriptEdit(rawVoiceTranscript, finalTranscript)
          if (editEval.isExceeded) {
            if (isAutoBufferFinalize || submitInFlightRef.current) {
              finalTranscript = (lastValidTranscriptRef.current || rawVoiceTranscript).trim()
              isManuallyEdited = evaluateTranscriptEdit(rawVoiceTranscript, finalTranscript).isManuallyEdited
            } else {
              throw new Error(
                `Mức độ chỉnh sửa (${editEval.percent.toFixed(1)}%) vượt quá giới hạn tối đa 35.0%. Vui lòng giảm chỉnh sửa hoặc khôi phục bản gốc.`,
              )
            }
          } else {
            isManuallyEdited = editEval.isManuallyEdited
          }
        }

        if (audio.size === 0) {
          if (submitInFlightRef.current) return null
          throw new Error('Không thu được dữ liệu âm thanh cho lượt trả lời này. Vui lòng kiểm tra micro.')
        }

        setNotice('Đang tải audio lên kho lưu trữ và niêm phong SHA-256…')
        const answerResult = await uploadAndSubmitTurn(
          ticket,
          question.questionId,
          currentFollowUpIndex,
          currentParentId,
          currentPrompt,
          audio,
          rawVoiceTranscript,
          finalTranscript,
          isManuallyEdited,
          elapsed,
          timestampsWhisper,
        )

        pendingTranscriptAudioRef.current = null
        pendingTimestampsRef.current = null
        setTranscriptReviewPending(false)
        setTranscriptBufferRemaining(0)

        const updatedCompletedMainIds =
          currentFollowUpIndex === 0 && !completedMainIdsRef.current.includes(question.questionId)
            ? [...completedMainIdsRef.current, question.questionId]
            : completedMainIdsRef.current
        if (updatedCompletedMainIds !== completedMainIdsRef.current) {
          completedMainIdsRef.current = updatedCompletedMainIds
          setCompletedMainIds(updatedCompletedMainIds)
        }

        if (submitInFlightRef.current) {
          return {
            questionId: question.questionId,
            followUpIndex: currentFollowUpIndex,
            rawVoiceTranscript,
            finalTranscript,
          }
        }

        // Check AI Follow-Up if enabled and allowed
        if (answerResult.canRequestFollowUp && ticket.hasFollowUp) {
          setGeneratingFollowUp(true)
          setNotice('Đang tạo câu hỏi phụ từ AI…')
          try {
            const followUpResponse = await apiClient.requestNextFollowUp(ticket.id, answerResult.submissionId)
            if (submitInFlightRef.current) {
              return {
                questionId: question.questionId,
                followUpIndex: currentFollowUpIndex,
                rawVoiceTranscript,
                finalTranscript,
              }
            }
            if (followUpResponse.hasMoreFollowUp && followUpResponse.followUpPrompt) {
              setActiveFollowUp({
                questionId: question.questionId,
                parentSubmissionId: followUpResponse.parentSubmissionId,
                followUpIndex: followUpResponse.followUpIndex,
                maxFollowUpQuestions: followUpResponse.maxFollowUpQuestions,
                prompt: followUpResponse.followUpPrompt,
              })
              initialTranscriptRef.current = ''
              transcriptDraftRef.current = ''
              setInitialTranscript('')
              setTranscriptDraft('')
              lastValidTranscriptRef.current = ''
              setNotice(`Đã nhận câu hỏi phụ ${followUpResponse.followUpIndex}/${followUpResponse.maxFollowUpQuestions}. Nhấn nút Ghi âm hoặc phím Space khi bạn sẵn sàng trả lời.`)
              return {
                questionId: question.questionId,
                followUpIndex: currentFollowUpIndex,
                rawVoiceTranscript,
                finalTranscript,
              }
            }
          } catch (followUpError) {
            const conflict = classifyByodConflict(followUpError)
            if (conflict) {
              handleByodConflict(conflict, describeByodConflict(conflict))
              return null
            }
            if (isTicketLockedError(followUpError)) {
              lockWithReason('SERVER_LOCKED', errorMessage(followUpError))
              return null
            }
            // Graceful degradation: proceed to next main question if follow-up service degraded.
          } finally {
            setGeneratingFollowUp(false)
          }
        }

        setActiveFollowUp(null)
        const nextUnansweredIndex = ticket.questions.findIndex(
          (q) => !updatedCompletedMainIds.includes(q.questionId),
        )
        if (nextUnansweredIndex < 0) {
          initialTranscriptRef.current = ''
          transcriptDraftRef.current = ''
          setInitialTranscript('')
          setTranscriptDraft('')
          setNotice('Đã hoàn thành toàn bộ câu hỏi. Nhấn "Nộp bài và khóa kiosk" để kết thúc.')
          return {
            questionId: question.questionId,
            followUpIndex: currentFollowUpIndex,
            rawVoiceTranscript,
            finalTranscript,
          }
        }

        setQuestionIndex(nextUnansweredIndex)
        initialTranscriptRef.current = ''
        transcriptDraftRef.current = ''
        setInitialTranscript('')
        setTranscriptDraft('')
        lastValidTranscriptRef.current = ''
        setNotice('')
        return {
          questionId: question.questionId,
          followUpIndex: currentFollowUpIndex,
          rawVoiceTranscript,
          finalTranscript,
        }
      } catch (questionError) {
        if (sessionRevokedRef.current) return null
        const conflict = classifyByodConflict(questionError)
        if (conflict) {
          handleByodConflict(conflict, describeByodConflict(conflict))
          return null
        }
        if (isTicketLockedError(questionError)) {
          lockWithReason('SERVER_LOCKED', errorMessage(questionError))
          return null
        }
        if (isTicketNotInProgressError(questionError)) {
          try {
            const latestState = await apiClient.getTicketState(ticket.id)
            if (submittedStatuses.has(latestState.status) && latestState.status !== 'LOCKED') {
              await transitionToSubmitted(ticket.id)
              return null
            }
            if (latestState.isKioskLocked || latestState.status === 'LOCKED') {
              lockWithReason('SERVER_LOCKED', errorMessage(questionError))
              return null
            }
          } catch {
            // Fall through to surface original error message
          }
        }
        if (!submitInFlightRef.current) {
          setError(errorMessage(questionError))
        }
        return null
      } finally {
        if (!submitInFlightRef.current) {
          setBusy(false)
        }
      }
    })()

    completeQuestionPromiseRef.current = run
    try {
      return await run
    } finally {
      if (completeQuestionPromiseRef.current === run) {
        completeQuestionPromiseRef.current = null
      }
    }
  }

  async function submitExam(allowIncomplete = false): Promise<void> {
    if (
      !ticket ||
      submitInFlightRef.current ||
      examTerminatedRef.current ||
      screenRef.current === 'blocked' ||
      screenRef.current === 'submitted'
    ) {
      return
    }
    const isExamTerminated = () =>
      examTerminatedRef.current ||
      byodConflictRef.current ||
      sessionRevokedRef.current ||
      screenRef.current === 'blocked' ||
      screenRef.current === 'submitted'

    submitInFlightRef.current = true
    setBusy(true)
    setError('')
    setNotice('Đang hoàn tất đồng bộ và nộp bài thi…')

    try {
      if (completeQuestionPromiseRef.current) {
        await completeQuestionPromiseRef.current
      }
      if (isExamTerminated()) {
        return
      }
      if (recordingRef.current || pendingTranscriptAudioRef.current) {
        await completeQuestion(true)
      }
      if (isExamTerminated()) {
        return
      }

      await flushPendingTurnDrafts(ticket, false)
      if (isExamTerminated()) {
        return
      }

      if (!allowIncomplete && completedMainIdsRef.current.length < ticket.questions.length) {
        const refreshedState = await apiClient.getTicketState(ticket.id)
        const serverMainCount = new Set(
          refreshedState.followUps.filter((item) => item.followUpIndex === 0).map((item) => item.questionId),
        ).size
        if (serverMainCount < ticket.questions.length) {
          throw new Error('Chưa hoàn thành đủ toàn bộ câu hỏi chính.')
        }
      }

      await flushPendingAntiCheatLogs(ticket.id).catch(() => undefined)
      if (isExamTerminated()) {
        return
      }

      const response = await retryOnce(() => apiClient.submitExam(ticket.id, [], true))
      if (!submittedStatuses.has(response.status)) {
        throw new Error('Máy chủ chưa xác nhận trạng thái SUBMITTED.')
      }

      await clearTicketDrafts(ticket.id)
      await transitionToSubmitted(
        ticket.id,
        'Máy chủ đã xác nhận lưu bài an toàn. Không hiển thị điểm tại kiosk.',
      )
    } catch (submitError) {
      if (sessionRevokedRef.current) return
      const conflict = classifyByodConflict(submitError)
      if (conflict) {
        handleByodConflict(conflict, describeByodConflict(conflict))
        return
      }
      if (isTicketLockedError(submitError)) {
        lockWithReason('SERVER_LOCKED', errorMessage(submitError))
        return
      }
      if (isTicketNotInProgressError(submitError)) {
        try {
          const latestState = await apiClient.getTicketState(ticket.id)
          if (submittedStatuses.has(latestState.status) && latestState.status !== 'LOCKED') {
            await transitionToSubmitted(ticket.id)
            return
          }
          if (latestState.isKioskLocked || latestState.status === 'LOCKED') {
            lockWithReason('SERVER_LOCKED', errorMessage(submitError))
            return
          }
        } catch {
          // Fall through to surface original error message
        }
      }
      if (allowIncomplete) {
        autoSubmitTriggeredRef.current = false
      }
      setError(errorMessage(submitError))
    } finally {
      submitInFlightRef.current = false
      setBusy(false)
    }
  }

  function handleReturnToSignInFromBlocked(): void {
    sessionRevokedRef.current = false
    byodConflictRef.current = false
    examTerminatedRef.current = false
    blurCountRef.current = 0
    setBlurCount(0)
    stopMicrophone()
    apiClient.clearSession()
    setTicket(null)
    setCompletedMainIds([])
    completedMainIdsRef.current = []
    setQuestionIndex(0)
    setActiveFollowUp(null)
    setGeneratingFollowUp(false)
    setInitialTranscript('')
    initialTranscriptRef.current = ''
    setTranscriptDraft('')
    transcriptDraftRef.current = ''
    setTranscriptReviewPending(false)
    setTranscriptBufferRemaining(0)
    pendingTranscriptAudioRef.current = null
    pendingTimestampsRef.current = null
    autoSubmitTriggeredRef.current = false
    lastAutoSubmitAttemptRef.current = 0
    submitInFlightRef.current = false
    setMustChangePassword(false)
    setStudentName('')
    setPassword('')
    setNewPassword('')
    setBlockDetail('')
    setError('')
    setNotice('Đã quay về màn hình đăng nhập. Bản nháp cục bộ (nếu có) vẫn được giữ nguyên.')
    screenRef.current = 'sign-in'
    setScreen('sign-in')
  }

  async function handleCheckBlockedStatus(): Promise<void> {
    setCheckingBlockStatus(true)
    setError('')
    try {
      if (!ticket) {
        if (!apiClient.getStoredUser()) {
          setNotice('Phiên đăng nhập chưa có vé thi. Vui lòng quay về đăng nhập lại.')
          return
        }
        byodConflictRef.current = false
        await continueAfterAuthentication()
        return
      }

      const state = await apiClient.getTicketState(ticket.id)
      if (submittedStatuses.has(state.status) && state.status !== 'LOCKED') {
        await transitionToSubmitted(ticket.id, 'Bài thi đã được xác nhận lưu trên máy chủ.')
        return
      }
      if (!state.isKioskLocked && state.status !== 'LOCKED') {
        const refreshedTicket = await apiClient.getCurrentTicket()
        if (refreshedTicket.status === 'LOCKED') {
          setNotice('Vé thi vẫn đang bị khóa trên máy chủ. Vui lòng tiếp tục liên hệ Giám thị hoặc Cán bộ Khảo thí.')
          return
        }
        byodConflictRef.current = false
        examTerminatedRef.current = false
        blurCountRef.current = state.violationCount
        setBlurCount(state.violationCount)
        apiClient.setKioskSessionToken(null)
        setTicket(refreshedTicket)
        setBlockDetail('')
        setError('')
        setNotice('Vé thi đã được mở khóa từ máy chủ. Vui lòng kiểm tra thiết bị và điểm danh lại để tiếp tục.')
        screenRef.current = 'pre-check'
        setScreen('pre-check')
        return
      }
      setNotice('Vé thi vẫn đang bị khóa trên máy chủ. Vui lòng tiếp tục liên hệ Giám thị hoặc Cán bộ Khảo thí.')
    } catch (checkError) {
      if (sessionRevokedRef.current) return
      const conflict = classifyByodConflict(checkError)
      if (conflict) {
        handleByodConflict(conflict, describeByodConflict(conflict))
        return
      }
      setError(errorMessage(checkError))
    } finally {
      setCheckingBlockStatus(false)
    }
  }

  async function handleExit(): Promise<void> {
    if (!window.kioskApi || isExitPending || screen !== 'submitted') return
    setIsExitPending(true)
    try {
      await window.kioskApi.requestExit()
    } finally {
      setIsExitPending(false)
    }
  }

  const currentQuestion = ticket?.questions[questionIndex] ?? null
  const activeStepIndex = getStepIndex(screen)
  const showStepper = screen === 'pre-check' || screen === 'lobby'
  const isCenteredStage =
    screen === 'sign-in' || screen === 'waiting-ticket' || screen === 'submitted' || screen === 'blocked'
  const containerWidthClass =
    screen === 'sign-in'
      ? 'is-narrow'
      : screen === 'waiting-ticket' || screen === 'submitted' || screen === 'blocked'
        ? 'is-medium'
        : screen === 'exam'
          ? 'is-wide'
          : ''

  return (
    <div className="kiosk-app">
      <header className="topbar">
        <div className="brand-lockup" aria-label="Oral Exam Desktop Kiosk">
          <span className="brand-mark" aria-hidden="true">
            OE
          </span>
          <span className="brand-text">
            <strong>Oral Exam</strong>
            <small>Phòng thi vấn đáp</small>
          </span>
        </div>

        <div>
          {showStepper ? (
            <nav className="stepper" aria-label="Tiến trình vào thi">
              {stepperSteps.map((step, index) => {
                const isDone = index < activeStepIndex
                const isActive = index === activeStepIndex
                return (
                  <Fragment key={step.id}>
                    {index > 0 ? <span className="stepper-sep" aria-hidden="true" /> : null}
                    <span className={`stepper-item ${isActive ? 'is-active' : ''} ${isDone ? 'is-done' : ''}`}>
                      <span className="stepper-dot" aria-hidden="true">
                        {isDone ? '✓' : index + 1}
                      </span>
                      <span>{step.label}</span>
                    </span>
                  </Fragment>
                )
              })}
            </nav>
          ) : null}
        </div>

        <div className="topbar-right">
          {studentName && screen !== 'sign-in' ? <span className="student-chip">{studentName}</span> : null}
          <span className="status-pill" role="status">
            <span className={`status-dot ${runtimeInfo.altTabTestMode ? 'is-test' : ''}`} aria-hidden="true" />
            {runtimeInfo.altTabTestMode
              ? 'Chế độ thử nghiệm'
              : runtimeInfo.isKioskMode
                ? 'Kiosk an toàn'
                : 'Cửa sổ dev'}
          </span>
          {screen === 'submitted' ? (
            <button className="btn btn-ghost" type="button" onClick={handleExit} disabled={isExitPending}>
              {isExitPending ? 'Đang đóng…' : 'Thoát'}
            </button>
          ) : null}
        </div>
      </header>

      <main className={`main-stage ${isCenteredStage ? 'is-centered' : ''}`}>
        <div className={`stage-container ${containerWidthClass}`}>
          {notice || error ? (
            <div className="banner-stack">
              {notice ? (
                <div className="banner banner-info" role="status">
                  <span className="banner-badge" aria-hidden="true">
                    i
                  </span>
                  <span>{notice}</span>
                </div>
              ) : null}
              {error ? (
                <div className="banner banner-error" role="alert">
                  <span className="banner-badge" aria-hidden="true">
                    !
                  </span>
                  <span>{error}</span>
                </div>
              ) : null}
            </div>
          ) : null}

          {screen === 'sign-in' ? (
            <SignInScreen
              username={username}
              password={password}
              newPassword={newPassword}
              mustChangePassword={mustChangePassword}
              busy={busy}
              runtimeReady={runtimeReady}
              runtimeError={runtimeError}
              appVersion={runtimeInfo.appVersion}
              isKioskMode={runtimeInfo.isKioskMode}
              onUsername={setUsername}
              onPassword={setPassword}
              onNewPassword={setNewPassword}
              onLogin={handleLogin}
              onChangePassword={handleChangePassword}
              onCancelChangePassword={handleCancelChangePassword}
              onRetryRuntime={retryRuntimeInit}
            />
          ) : null}

          {screen === 'waiting-ticket' ? (
            <WaitingTicketScreen
              studentName={studentName}
              busy={busy}
              onRetry={retryTicketLoad}
              onReturnToSignIn={handleReturnToSignInFromBlocked}
            />
          ) : null}

          {screen === 'pre-check' ? (
            <PreCheckScreen
              microphoneReady={microphoneReady}
              micTestSeconds={micTestSeconds}
              micLevel={micLevel}
              displayCount={runtimeInfo.displayCount}
              isKioskMode={runtimeInfo.isKioskMode}
              altTabTestMode={runtimeInfo.altTabTestMode}
              platform={runtimeInfo.platform}
              securitySnapshot={securitySnapshot}
              scanningEnvironment={scanningEnvironment}
              busy={busy}
              onTest={startMicrophoneTest}
              onRescanEnvironment={refreshSecuritySnapshot}
              onCheckIn={handleCheckIn}
            />
          ) : null}

          {screen === 'lobby' && ticket ? (
            <LobbyScreen
              ticket={ticket}
              offlineDraftAvailable={pendingTurnDraftsCount > 0 || completedMainIds.length > 0}
              hasCompleteDraft={
                ticket.questions.length > 0 &&
                completedMainIds.length >= ticket.questions.length &&
                !activeFollowUp &&
                pendingTurnDraftsCount === 0
              }
              refreshingTicket={refreshingLobbyTicket}
              onStart={startExam}
              onResumeSubmit={() => submitExam(false)}
              onRefreshTicket={refreshLobbyTicket}
            />
          ) : null}

          {screen === 'exam' && ticket && currentQuestion ? (
            <ExamScreen
              ticket={ticket}
              apiBaseUrl={runtimeInfo.apiBaseUrl}
              question={currentQuestion}
              questionIndex={questionIndex}
              completedMainCount={completedMainIds.length}
              activeFollowUp={activeFollowUp}
              generatingFollowUp={generatingFollowUp}
              initialTranscript={initialTranscript}
              transcript={transcriptDraft}
              recording={recording}
              recordingElapsedSeconds={recordingElapsedSeconds}
              transcribing={transcribing}
              busy={busy}
              blurCount={blurCount}
              remainingSeconds={Math.max(0, Math.ceil((Date.parse(ticket.endTime) - clockNow) / 1000))}
              transcriptReviewPending={transcriptReviewPending}
              transcriptBufferRemaining={transcriptBufferRemaining}
              onToggleRecording={handleToggleRecording}
              onTranscript={handleTranscriptChange}
              onRestoreOriginalTranscript={handleRestoreOriginalTranscript}
              onComplete={async () => {
                await completeQuestion(false)
              }}
              onSubmit={submitExam}
            />
          ) : null}

          {screen === 'submitted' ? (
            <SubmittedScreen isExitPending={isExitPending} onExit={handleExit} />
          ) : null}

          {screen === 'blocked' ? (
            <BlockedScreen
              blurCount={blurCount}
              reason={blockReason}
              detailMessage={blockDetail}
              checkingStatus={checkingBlockStatus}
              onCheckStatus={handleCheckBlockedStatus}
              onReturnToSignIn={handleReturnToSignInFromBlocked}
            />
          ) : null}
        </div>
      </main>
    </div>
  )
}

export default App
