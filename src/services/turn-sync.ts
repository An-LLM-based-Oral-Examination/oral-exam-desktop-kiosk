import {
  ApiClient,
  ApiProblemError,
  classifyByodConflict,
  isTicketLockedError,
} from './api'
import {
  buildTurnDraftKey,
  deletePendingAntiCheatLog,
  deleteTurnDraft,
  loadPendingAntiCheatLogs,
  loadTicketTurnDrafts,
  saveTurnDraft,
} from './offline-draft'
import type {
  AudioUploadAuthorization,
  ByodConflictCode,
  ExamAntiCheatLogResponse,
  StudentWorkstationTicket,
  SubmitQuestionAnswerResponse,
  TurnDraft,
  TurnDraftMetadata,
  TurnDraftStage,
} from '../types/mf04.types'
import { retryOnce, sha256HexAndBase64 } from '../utils/crypto'

export interface ExecuteTurnUploadAndSubmitParams {
  apiClient: Pick<
    ApiClient,
    'createQuestionAudioUploadAuthorization' | 'uploadAudio' | 'submitQuestionAnswer'
  >
  ticket: StudentWorkstationTicket
  questionId: string
  followUpIndex: number
  parentSubmissionId: string | null
  followUpPrompt: string | null
  audio: Blob
  rawVoiceTranscript: string | null
  finalTranscript: string
  timestampsWhisper?: string | null
  isManuallyEdited: boolean
  timeSpentSeconds: number
  nowMs?: number
  resume?: Partial<
    Pick<
      TurnDraftMetadata,
      | 'stage'
      | 'objectKey'
      | 'sha256'
      | 'sha256Base64'
      | 'uploadAuthorization'
      | 'createdAt'
      | 'timestampsWhisper'
    >
  >
}

export interface FlushPendingTurnDraftsParams {
  apiClient: Pick<
    ApiClient,
    | 'createQuestionAudioUploadAuthorization'
    | 'uploadAudio'
    | 'submitQuestionAnswer'
    | 'requestNextFollowUp'
  >
  ticket: StudentWorkstationTicket
  requestFollowUp: boolean
  nowMs?: number
  onDraftsCountChange?: (count: number) => void
  onByodConflict?: (code: ByodConflictCode, error: unknown) => void
  onTicketLocked?: (error: unknown) => void
}

export interface FlushPendingAntiCheatLogsParams {
  apiClient: Pick<ApiClient, 'logAntiCheat'>
  ticketId: string
  onByodConflict?: (code: ByodConflictCode, error: unknown) => void
  onTicketLocked?: (response: ExamAntiCheatLogResponse | null, error?: unknown) => void
  onBlurCountSync?: (blurCount: number) => void
}

function isUploadAuthorizationValid(
  authorization: AudioUploadAuthorization | null | undefined,
  nowMs: number,
): authorization is AudioUploadAuthorization {
  if (!authorization || !authorization.uploadUrl || !authorization.objectKey) {
    return false
  }
  const expiresAtMs = Date.parse(authorization.expiresAt)
  return Number.isFinite(expiresAtMs) && expiresAtMs - nowMs > 15_000
}

function isTransientError(error: unknown): boolean {
  if (!(error instanceof ApiProblemError)) return true
  return error.status === 0 || error.status === 408 || error.status === 429 || error.status >= 500
}

async function uploadWithIdempotent412Handling(
  apiClient: Pick<ApiClient, 'createQuestionAudioUploadAuthorization' | 'uploadAudio'>,
  ticketId: string,
  questionId: string,
  followUpIndex: number,
  sha256Base64: string,
  authorization: AudioUploadAuthorization,
  audio: Blob,
  usedCachedAuthorization: boolean,
  onAuthorizationRefreshed: (fresh: AudioUploadAuthorization) => Promise<void>,
): Promise<AudioUploadAuthorization> {
  const tryPutOnce = async (authz: AudioUploadAuthorization): Promise<boolean> => {
    try {
      await apiClient.uploadAudio(authz, audio)
      return true
    } catch (uploadError) {
      if (uploadError instanceof ApiProblemError && uploadError.status === 412) {
        // Object was already uploaded to R2 (e.g. previous PUT succeeded before client lost response).
        // Treat 412 idempotently and let Backend HeadObject + VerifySha256Async confirm integrity.
        return false
      }
      throw uploadError
    }
  }

  try {
    await tryPutOnce(authorization)
    return authorization
  } catch (firstError) {
    if (
      usedCachedAuthorization &&
      firstError instanceof ApiProblemError &&
      firstError.status === 403
    ) {
      const freshAuthorization = await retryOnce(() =>
        apiClient.createQuestionAudioUploadAuthorization(
          ticketId,
          questionId,
          followUpIndex,
          sha256Base64,
        ),
      )
      await onAuthorizationRefreshed(freshAuthorization)
      await tryPutOnce(freshAuthorization)
      return freshAuthorization
    }

    if (!isTransientError(firstError)) {
      throw firstError
    }

    await new Promise((resolve) => globalThis.setTimeout(resolve, 600))
    try {
      await tryPutOnce(authorization)
      return authorization
    } catch {
      throw firstError
    }
  }
}

export async function executeTurnUploadAndSubmit({
  apiClient,
  ticket,
  questionId,
  followUpIndex,
  parentSubmissionId,
  followUpPrompt,
  audio,
  rawVoiceTranscript,
  finalTranscript,
  timestampsWhisper,
  isManuallyEdited,
  timeSpentSeconds,
  nowMs = Date.now(),
  resume,
}: ExecuteTurnUploadAndSubmitParams): Promise<SubmitQuestionAnswerResponse> {
  const draftKey = buildTurnDraftKey(ticket.id, questionId, followUpIndex)
  const createdAt = resume?.createdAt ?? new Date(nowMs).toISOString()
  const effectiveTimestampsWhisper = timestampsWhisper ?? resume?.timestampsWhisper ?? null

  let stage: TurnDraftStage = resume?.stage ?? 'RECORDED'
  let objectKey: string | null = resume?.objectKey ?? null
  let sha256: string | null = resume?.sha256 ?? null
  let sha256Base64: string | null = resume?.sha256Base64 ?? null
  let uploadAuthorization: AudioUploadAuthorization | null = resume?.uploadAuthorization ?? null

  if (!sha256 || !sha256Base64) {
    const digestPair = await sha256HexAndBase64(audio)
    sha256 = sha256 ?? digestPair.hex
    sha256Base64 = sha256Base64 ?? digestPair.base64
  }

  const saveStage = async () => {
    const nowIso = new Date(Date.now()).toISOString()
    await saveTurnDraft({
      metadata: {
        draftKey,
        ticketId: ticket.id,
        shiftId: ticket.shiftId,
        studentId: ticket.studentId,
        questionId,
        followUpIndex,
        parentSubmissionId,
        followUpPrompt,
        initialVoiceTranscript: rawVoiceTranscript,
        transcriptWhisper: finalTranscript,
        timestampsWhisper: effectiveTimestampsWhisper,
        timeSpentSeconds,
        isManuallyEdited,
        objectKey,
        sha256,
        sha256Base64,
        uploadAuthorization,
        stage,
        createdAt,
        updatedAt: nowIso,
      },
      audio,
    })
  }

  if (stage === 'RECORDED') {
    await saveStage()
  }

  try {
    if (stage !== 'AUDIO_UPLOADED' || !objectKey) {
      let usedCachedAuthorization = false
      if (stage === 'UPLOAD_AUTHORIZED' && isUploadAuthorizationValid(uploadAuthorization, nowMs)) {
        usedCachedAuthorization = true
      } else {
        uploadAuthorization = await retryOnce(() =>
          apiClient.createQuestionAudioUploadAuthorization(
            ticket.id,
            questionId,
            followUpIndex,
            sha256Base64,
          ),
        )
        stage = 'UPLOAD_AUTHORIZED'
        objectKey = uploadAuthorization.objectKey
        await saveStage()
      }

      uploadAuthorization = await uploadWithIdempotent412Handling(
        apiClient,
        ticket.id,
        questionId,
        followUpIndex,
        sha256Base64,
        uploadAuthorization,
        audio,
        usedCachedAuthorization,
        async (freshAuthorization) => {
          uploadAuthorization = freshAuthorization
          objectKey = freshAuthorization.objectKey
          stage = 'UPLOAD_AUTHORIZED'
          await saveStage()
        },
      )

      stage = 'AUDIO_UPLOADED'
      objectKey = uploadAuthorization.objectKey
      uploadAuthorization = null
      await saveStage()
    }

    const response = await retryOnce(() =>
      apiClient.submitQuestionAnswer(ticket.id, questionId, {
        followUpIndex,
        parentSubmissionId,
        audioObjectKey: objectKey!,
        audioHashSha256: sha256!,
        initialVoiceTranscript: rawVoiceTranscript,
        transcriptWhisper: finalTranscript,
        timestampsWhisper: effectiveTimestampsWhisper,
        timeSpentSeconds,
        isManuallyEdited,
      }),
    )

    stage = 'ANSWER_SUBMITTED'
    await deleteTurnDraft(draftKey)
    return response
  } catch (turnError) {
    if (turnError instanceof ApiProblemError && turnError.status === 404 && stage === 'AUDIO_UPLOADED') {
      stage = 'RECORDED'
      uploadAuthorization = null
    }
    await saveStage().catch(() => undefined)
    throw turnError
  }
}

export async function flushPendingTurnDraftsQueue({
  apiClient,
  ticket,
  requestFollowUp,
  nowMs = Date.now(),
  onDraftsCountChange,
  onByodConflict,
  onTicketLocked,
}: FlushPendingTurnDraftsParams): Promise<void> {
  const drafts: TurnDraft[] = await loadTicketTurnDrafts(ticket.id)
  onDraftsCountChange?.(drafts.length)
  if (drafts.length === 0) return

  for (const draft of drafts) {
    const { metadata, audio } = draft
    if (audio.size === 0) {
      await deleteTurnDraft(metadata.draftKey)
      continue
    }

    let answerResult: SubmitQuestionAnswerResponse
    try {
      answerResult = await executeTurnUploadAndSubmit({
        apiClient,
        ticket,
        questionId: metadata.questionId,
        followUpIndex: metadata.followUpIndex,
        parentSubmissionId: metadata.parentSubmissionId,
        followUpPrompt: metadata.followUpPrompt,
        audio,
        rawVoiceTranscript: metadata.initialVoiceTranscript,
        finalTranscript: metadata.transcriptWhisper,
        timestampsWhisper: metadata.timestampsWhisper,
        isManuallyEdited: metadata.isManuallyEdited,
        timeSpentSeconds: metadata.timeSpentSeconds,
        nowMs,
        resume: {
          stage: metadata.stage,
          objectKey: metadata.objectKey,
          sha256: metadata.sha256,
          sha256Base64: metadata.sha256Base64 ?? null,
          uploadAuthorization: metadata.uploadAuthorization ?? null,
          createdAt: metadata.createdAt,
          timestampsWhisper: metadata.timestampsWhisper ?? null,
        },
      })
    } catch (turnError) {
      if (isTicketLockedError(turnError)) {
        onTicketLocked?.(turnError)
      }
      throw turnError
    }

    const hasSubsequentFollowUpDraft = drafts.some(
      (candidate) =>
        candidate.metadata.questionId === metadata.questionId &&
        candidate.metadata.followUpIndex === metadata.followUpIndex + 1,
    )

    if (
      requestFollowUp &&
      ticket.hasFollowUp &&
      answerResult.canRequestFollowUp &&
      !hasSubsequentFollowUpDraft
    ) {
      try {
        await apiClient.requestNextFollowUp(ticket.id, answerResult.submissionId)
      } catch (followUpError) {
        const conflict = classifyByodConflict(followUpError)
        if (conflict) {
          onByodConflict?.(conflict, followUpError)
          throw followUpError
        }
        if (isTicketLockedError(followUpError)) {
          onTicketLocked?.(followUpError)
          throw followUpError
        }
      }
    }
  }

  const remaining = await loadTicketTurnDrafts(ticket.id)
  onDraftsCountChange?.(remaining.length)
}

function extractServerBlurCount(response: ExamAntiCheatLogResponse): number | null {
  if (typeof response.lockThreshold === 'number' && typeof response.remainingStrikes === 'number') {
    return Math.max(0, response.lockThreshold - response.remainingStrikes)
  }
  if (response.eventType === 'WINDOW_BLUR' && typeof response.violationCount === 'number') {
    return Math.max(0, response.violationCount)
  }
  return null
}

export async function flushPendingAntiCheatLogsQueue({
  apiClient,
  ticketId,
  onByodConflict,
  onTicketLocked,
  onBlurCountSync,
}: FlushPendingAntiCheatLogsParams): Promise<number> {
  const pendingLogs = await loadPendingAntiCheatLogs(ticketId)
  let flushedCount = 0

  for (const record of pendingLogs) {
    try {
      const response = await apiClient.logAntiCheat(record.request)
      await deletePendingAntiCheatLog(record.clientEventId)
      flushedCount += 1
      if (response) {
        const serverBlurCount = extractServerBlurCount(response)
        if (serverBlurCount !== null) {
          onBlurCountSync?.(serverBlurCount)
        }
        if (response.isLocked) {
          onTicketLocked?.(response)
          break
        }
      }
    } catch (logError) {
      const conflict = classifyByodConflict(logError)
      if (conflict) {
        onByodConflict?.(conflict, logError)
        throw logError
      }
      if (isTicketLockedError(logError)) {
        await deletePendingAntiCheatLog(record.clientEventId)
        onTicketLocked?.(null, logError)
        throw logError
      }
      if (logError instanceof ApiProblemError && logError.status === 401) {
        break
      }
      if (
        logError instanceof ApiProblemError &&
        logError.status >= 400 &&
        logError.status < 500 &&
        logError.status !== 408 &&
        logError.status !== 429
      ) {
        await deletePendingAntiCheatLog(record.clientEventId)
        continue
      }
      break
    }
  }

  return flushedCount
}
