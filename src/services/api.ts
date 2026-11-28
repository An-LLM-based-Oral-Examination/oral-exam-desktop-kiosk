import type {
  AntiCheatLogRequest,
  AudioSealResponse,
  AudioUploadAuthorization,
  ByodConflictCode,
  ChangePasswordResponse,
  ExamAnswer,
  ExamAntiCheatLogResponse,
  ExamTicketResponse,
  KioskHeartbeatRequest,
  KioskHeartbeatResponse,
  LoginResponse,
  OfficialExamNextFollowUpResponse,
  OfficialExamTicketStateResponse,
  ProblemDetails,
  RefreshTokenResponse,
  SessionRevocationReason,
  SessionRevokedEvent,
  SpeechTranscriptionResult,
  StudentWorkstationTicket,
  SubmissionStatus,
  SubmitQuestionAnswerRequest,
  SubmitQuestionAnswerResponse,
  SubmitResponse,
  WorkstationFollowUpItem,
} from '../types/mf04.types'

export const KIOSK_DEVICE_ID_REGEX = /^[A-Za-z0-9._:-]{16,128}$/
export const KIOSK_VERSION_REGEX = /^[A-Za-z0-9._+-]{2,64}$/

export function isValidKioskDeviceId(value: string | null | undefined): boolean {
  return typeof value === 'string' && KIOSK_DEVICE_ID_REGEX.test(value.trim())
}

export function isValidKioskVersion(value: string | null | undefined): boolean {
  return typeof value === 'string' && KIOSK_VERSION_REGEX.test(value.trim())
}

export class ApiProblemError extends Error {
  readonly status: number
  readonly problem: ProblemDetails

  constructor(problem: ProblemDetails, status: number) {
    super(problem.detail ?? problem.title ?? 'Không thể xử lý yêu cầu với máy chủ.')
    this.name = 'ApiProblemError'
    this.status = status
    this.problem = problem
  }
}

export function classifyByodConflict(error: unknown): ByodConflictCode | null {
  if (!(error instanceof ApiProblemError) || error.status !== 409) return null
  const combined = `${error.problem.type ?? ''} ${error.problem.detail ?? ''} ${error.problem.errorCode ?? ''} ${error.message}`.toUpperCase()
  if (combined.includes('DEVICE_MISMATCH') || combined.includes('DEVICE-MISMATCH')) {
    return 'DEVICE_MISMATCH'
  }
  if (combined.includes('ACTIVE_SESSION_CONFLICT') || combined.includes('ACTIVE-SESSION-CONFLICT')) {
    return 'ACTIVE_SESSION_CONFLICT'
  }
  if (combined.includes('DEVICE_IN_USE_OTHER_TICKET') || combined.includes('DEVICE-IN-USE-OTHER-TICKET')) {
    return 'DEVICE_IN_USE_OTHER_TICKET'
  }
  return null
}

export function isTicketLockedError(error: unknown): boolean {
  if (!(error instanceof ApiProblemError) || error.status !== 409) return false
  const combined = `${error.problem.type ?? ''} ${error.problem.detail ?? ''} ${error.problem.errorCode ?? ''} ${error.message}`.toUpperCase()
  return combined.includes('TICKET_LOCKED') || combined.includes('TICKET-LOCKED')
}

export function isTicketNotInProgressError(error: unknown): boolean {
  if (!(error instanceof ApiProblemError) || error.status !== 409) return false
  const combined = `${error.problem.type ?? ''} ${error.problem.detail ?? ''} ${error.problem.errorCode ?? ''} ${error.message}`.toUpperCase()
  return (
    combined.includes('TICKET_NOT_IN_PROGRESS') ||
    combined.includes('TICKET-NOT-IN-PROGRESS') ||
    combined.includes('KHÔNG Ở TRẠNG THÁI ĐANG THI')
  )
}

export function describeByodConflict(code: ByodConflictCode): string {
  switch (code) {
    case 'DEVICE_MISMATCH':
      return 'Vé thi này đã được khóa với một thiết bị khác. Nếu bạn cần đổi sang máy dự phòng, vui lòng báo Giám thị hoặc Cán bộ Khảo thí mở khóa thiết bị BYOD.'
    case 'ACTIVE_SESSION_CONFLICT':
      return 'Phiên thi trên thiết bị này đã bị thay thế bởi một phiên đăng nhập mới hơn. Vui lòng ngừng thao tác và báo Giám thị phòng thi.'
    case 'DEVICE_IN_USE_OTHER_TICKET':
      return 'Thiết bị này đang được gắn với vé thi của một thí sinh khác trong cùng ca thi. Vui lòng liên hệ Giám thị hoặc Cán bộ Khảo thí.'
  }
}

interface ApiClientOptions {
  baseUrl: string
  deviceId?: string
  kioskVersion?: string
  onSessionRevoked?: (event: SessionRevokedEvent) => void
}

interface RequestOptions {
  method?: string
  body?: unknown
  headers?: Record<string, string>
  signal?: AbortSignal
  isMultipart?: boolean
  skipAuth?: boolean
  skipRefresh?: boolean
}

interface JsonRecord {
  [key: string]: unknown
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: JsonRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return trimmed || '/api/v1'
}

function parseProblem(payload: unknown, status: number, fallback: string): ProblemDetails {
  if (!isRecord(payload)) {
    return { status, title: 'Lỗi kết nối hoặc máy chủ', detail: fallback }
  }

  const detail = readString(payload, 'detail', 'Detail', 'error', 'Error', 'message', 'Message') ?? fallback
  const title = readString(payload, 'title', 'Title') ?? (status >= 500 ? 'Lỗi máy chủ' : 'Không thể xử lý yêu cầu')
  const payloadStatus = payload.status ?? payload.Status
  return {
    type: readString(payload, 'type', 'Type'),
    title,
    detail,
    status: typeof payloadStatus === 'number' ? payloadStatus : status,
    instance: readString(payload, 'instance', 'Instance'),
    errorCode: readString(payload, 'errorCode', 'ErrorCode'),
    errors: isRecord(payload.errors) ? (payload.errors as Record<string, string[]>) : undefined,
  }
}

function unwrap<T>(payload: unknown): T {
  if (isRecord(payload) && 'value' in payload) return payload.value as T
  return payload as T
}

interface WindowWithKioskR2Bridge {
  kioskApi?: {
    uploadAudioToR2?: (request: {
      uploadUrl: string
      headers: Record<string, string>
      data: ArrayBuffer
    }) => Promise<{
      ok: boolean
      status: number
      statusText: string
      headers: Record<string, string>
      bodyText?: string
      errorMessage?: string
    }>
  }
}

export class ApiClient {
  private readonly baseUrl: string
  private deviceId: string | null
  private readonly kioskVersion: string | null
  private onSessionRevokedHandler: ((event: SessionRevokedEvent) => void) | null
  private refreshPromise: Promise<string> | null = null
  private accessToken: string | null = null
  private refreshTokenValue: string | null = null
  private kioskSessionToken: string | null = null
  private storedUser: LoginResponse['user'] | null = null
  private sessionRevoked = false
  private sessionEpoch = 0

  constructor(options: ApiClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl)
    const rawDeviceId = options.deviceId?.trim() || null
    const rawKioskVersion = options.kioskVersion?.trim() || null
    if (rawDeviceId && !KIOSK_DEVICE_ID_REGEX.test(rawDeviceId)) {
      throw new Error('Định danh thiết bị X-Device-Id không hợp lệ theo chuẩn Kiosk.')
    }
    if (rawKioskVersion && !KIOSK_VERSION_REGEX.test(rawKioskVersion)) {
      throw new Error('Phiên bản ứng dụng X-Kiosk-Version không hợp lệ theo chuẩn Kiosk.')
    }
    this.deviceId = rawDeviceId
    this.kioskVersion = rawKioskVersion
    this.onSessionRevokedHandler = options.onSessionRevoked ?? null
  }

  setOnSessionRevoked(handler: ((event: SessionRevokedEvent) => void) | null): void {
    this.onSessionRevokedHandler = handler
  }

  private notifySessionRevoked(error: unknown): void {
    if (this.sessionRevoked) return
    this.sessionRevoked = true
    this.clearSession()
    const event = buildSessionRevokedEvent(error)
    this.onSessionRevokedHandler?.(event)
  }

  getBaseUrl(): string {
    return this.baseUrl
  }

  getDeviceId(): string | null {
    return this.deviceId
  }

  setDeviceId(deviceId: string | null | undefined): void {
    const rawDeviceId = deviceId?.trim() || null
    if (rawDeviceId && !KIOSK_DEVICE_ID_REGEX.test(rawDeviceId)) {
      throw new Error('Định danh thiết bị X-Device-Id không hợp lệ theo chuẩn Kiosk.')
    }
    this.deviceId = rawDeviceId
  }

  setSession(response: LoginResponse | RefreshTokenResponse): void {
    this.sessionRevoked = false
    this.accessToken = response.accessToken
    this.refreshTokenValue = response.refreshToken
  }

  setKioskSessionToken(token: string | null): void {
    this.kioskSessionToken = token?.trim() || null
  }

  getKioskSessionToken(): string | null {
    return this.kioskSessionToken
  }

  clearSession(): void {
    this.sessionEpoch += 1
    this.refreshPromise = null
    this.accessToken = null
    this.refreshTokenValue = null
    this.kioskSessionToken = null
    this.storedUser = null
  }

  getStoredUser(): LoginResponse['user'] | null {
    return this.storedUser
  }

  setUser(user: LoginResponse['user']): void {
    this.storedUser = user
  }

  async login(username: string, password: string): Promise<LoginResponse> {
    const response = await this.request<LoginResponse>('/auth/kiosk/password-login', {
      method: 'POST',
      body: { username, password },
      skipAuth: true,
      skipRefresh: true,
    })
    this.sessionEpoch += 1
    this.setSession(response)
    this.setUser(response.user)
    return response
  }

  async refresh(): Promise<string> {
    if (this.sessionRevoked) {
      throw new ApiProblemError(
        {
          status: 401,
          title: 'Phiên đăng nhập đã bị thu hồi',
          detail: 'Phiên đăng nhập đã hết hạn hoặc bị thu hồi.',
        },
        401,
      )
    }

    const refreshToken = this.refreshTokenValue
    if (!refreshToken) {
      const missingError = new Error('Không còn refresh token để khôi phục phiên.')
      this.notifySessionRevoked(missingError)
      throw missingError
    }

    if (!this.refreshPromise) {
      const refreshEpoch = this.sessionEpoch
      const pendingRefresh = this.request<RefreshTokenResponse>('/auth/kiosk/refresh-token', {
        method: 'POST',
        body: { refreshToken },
        skipAuth: true,
        skipRefresh: true,
      })
        .then((response) => {
          if (this.sessionEpoch !== refreshEpoch) {
            throw new ApiProblemError(
              {
                status: 401,
                title: 'Phiên đăng nhập đã bị thay đổi',
                detail: 'Phiên đăng nhập đã bị xóa hoặc thay đổi trong lúc làm mới token.',
              },
              401,
            )
          }
          this.setSession(response)
          return response.accessToken
        })
        .catch((refreshError: unknown) => {
          if (
            this.sessionEpoch === refreshEpoch &&
            refreshError instanceof ApiProblemError &&
            (refreshError.status === 401 ||
              refreshError.status === 403 ||
              refreshError.status === 409 ||
              refreshError.status === 400)
          ) {
            this.notifySessionRevoked(refreshError)
          }
          throw refreshError
        })
        .finally(() => {
          if (this.refreshPromise === pendingRefresh) {
            this.refreshPromise = null
          }
        })
      this.refreshPromise = pendingRefresh
    }

    return this.refreshPromise
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<ChangePasswordResponse> {
    const response = await this.request<ChangePasswordResponse>('/auth/kiosk/change-password', {
      method: 'POST',
      body: { currentPassword, newPassword },
    })
    this.setSession(response)
    return response
  }

  async getCurrentTicket(): Promise<StudentWorkstationTicket> {
    const payload = await this.request<unknown>('/official-exams/tickets/current')
    return normalizeTicket(unwrap<unknown>(payload))
  }

  async getTicketState(ticketId: string): Promise<OfficialExamTicketStateResponse> {
    const payload = await this.request<unknown>(`/official-exams/tickets/${encodeURIComponent(ticketId)}`)
    return normalizeTicketState(unwrap<unknown>(payload))
  }

  async checkIn(ticketId: string): Promise<ExamTicketResponse> {
    const payload = await this.request<unknown>(`/official-exams/tickets/${encodeURIComponent(ticketId)}/check-in`, {
      method: 'POST',
      body: this.deviceId ? { deviceId: this.deviceId, kioskVersion: this.kioskVersion } : undefined,
    })
    const normalized = normalizeTicketResponse(unwrap<unknown>(payload))
    if (normalized.activeSessionToken) {
      this.setKioskSessionToken(normalized.activeSessionToken)
    }
    return normalized
  }

  async sendHeartbeat(
    ticketId: string,
    request: KioskHeartbeatRequest = {},
    signal?: AbortSignal,
  ): Promise<KioskHeartbeatResponse> {
    const clampedDb =
      typeof request.audioLevelDb === 'number' && Number.isFinite(request.audioLevelDb)
        ? Math.max(0, Math.min(150, Math.round(request.audioLevelDb)))
        : null

    const payload = await this.request<unknown>(
      `/official-exams/tickets/${encodeURIComponent(ticketId)}/heartbeat`,
      {
        method: 'POST',
        body: {
          audioLevelDb: clampedDb,
          isFullscreen: request.isFullscreen ?? null,
          displayCount: request.displayCount ?? null,
          deviceId: request.deviceId ?? this.deviceId,
          kioskVersion: request.kioskVersion ?? this.kioskVersion,
        },
        signal,
      },
    )
    return normalizeHeartbeatResponse(unwrap<unknown>(payload))
  }

  async logAntiCheat(request: AntiCheatLogRequest): Promise<ExamAntiCheatLogResponse> {
    const payload = await this.request<unknown>('/official-exams/anti-cheat/log', {
      method: 'POST',
      body: {
        ...request,
        severity: request.severity.toLowerCase(),
      },
    })
    return normalizeAntiCheatLogResponse(unwrap<unknown>(payload), request)
  }

  async transcribe(audio: Blob, vocabularyHint: string, clientTranscript: string): Promise<SpeechTranscriptionResult> {
    const formData = new FormData()
    formData.append('file', audio, 'speech.webm')
    formData.append('vocabularyHint', vocabularyHint)
    formData.append('clientTranscript', clientTranscript)
    const payload = await this.request<unknown>('/speech/stt', {
      method: 'POST',
      body: formData,
      isMultipart: true,
    })
    const record = unwrap<unknown>(payload)
    if (!isRecord(record)) throw new Error('Phản hồi STT không hợp lệ.')
    const text = readString(record, 'text', 'Text') ?? ''
    const rawConfidence = record.confidenceScore ?? record.ConfidenceScore
    return {
      text,
      rawText: readString(record, 'rawText', 'RawText') ?? null,
      provider: readString(record, 'provider', 'Provider') ?? null,
      timestampsJson: readString(record, 'timestampsJson', 'TimestampsJson') ?? null,
      confidenceScore: typeof rawConfidence === 'number' && Number.isFinite(rawConfidence) ? rawConfidence : null,
    }
  }

  async createAudioUploadAuthorization(ticketId: string): Promise<AudioUploadAuthorization> {
    const payload = await this.request<unknown>(
      `/official-exams/tickets/${encodeURIComponent(ticketId)}/audio-upload-authorizations`,
      { method: 'POST' },
    )
    return normalizeAudioUploadAuthorization(payload)
  }

  async createQuestionAudioUploadAuthorization(
    ticketId: string,
    questionId: string,
    followUpIndex: number,
    expectedSha256Base64?: string | null,
  ): Promise<AudioUploadAuthorization> {
    const payload = await this.request<unknown>(
      `/official-exams/tickets/${encodeURIComponent(ticketId)}/questions/${encodeURIComponent(questionId)}/audio-upload-authorizations`,
      {
        method: 'POST',
        body: {
          followUpIndex,
          ...(expectedSha256Base64 ? { expectedSha256Base64 } : {}),
        },
      },
    )
    return normalizeAudioUploadAuthorization(payload)
  }

  async uploadAudio(authorization: AudioUploadAuthorization, audio: Blob, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }

    const hasContentType = Object.keys(authorization.requiredHeaders).some(
      (key) => key.toLowerCase() === 'content-type',
    )
    const headers: Record<string, string> = {
      ...(hasContentType ? {} : { 'Content-Type': 'audio/webm' }),
      ...authorization.requiredHeaders,
    }

    const r2Uploader =
      typeof window !== 'undefined'
        ? (window as unknown as WindowWithKioskR2Bridge).kioskApi?.uploadAudioToR2
        : undefined
    if (r2Uploader) {
      const buffer = await audio.arrayBuffer()
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }

      const result = await r2Uploader({
        uploadUrl: authorization.uploadUrl,
        headers,
        data: buffer,
      })

      if (!result.ok) {
        if (result.status > 0) {
          throw new ApiProblemError(
            {
              status: result.status,
              title: 'Không tải được audio lên kho lưu trữ.',
              detail: result.bodyText
                ? `HTTP ${result.status}: ${result.bodyText}`
                : `HTTP ${result.status}`,
            },
            result.status,
          )
        }
        throw new Error(result.errorMessage || 'Không thể tải audio lên kho lưu trữ qua tiến trình chính.')
      }
      return
    }

    const response = await fetch(authorization.uploadUrl, {
      method: 'PUT',
      headers,
      body: audio,
      signal,
    })
    if (!response.ok) {
      throw new ApiProblemError(
        { status: response.status, title: 'Không tải được audio lên kho lưu trữ.', detail: `HTTP ${response.status}` },
        response.status,
      )
    }
  }

  async sealAudio(ticketId: string, objectKey: string, sha256: string): Promise<AudioSealResponse> {
    const payload = await this.request<unknown>(`/official-exams/tickets/${encodeURIComponent(ticketId)}/audio`, {
      method: 'PUT',
      body: { objectKey, sha256 },
    })
    const record = unwrapRecord(payload, 'Phản hồi niêm phong audio không hợp lệ.')
    return {
      ticketId: requiredString(record, 'ticketId', 'Phản hồi niêm phong thiếu mã vé.'),
      objectKey: requiredString(record, 'objectKey', 'Phản hồi niêm phong thiếu object key.'),
      sha256: requiredString(record, 'sha256', 'Phản hồi niêm phong thiếu SHA-256.'),
      contentLength: requiredNumber(record, 'contentLength', 'Phản hồi niêm phong thiếu dung lượng.'),
      verifiedAt: requiredString(record, 'verifiedAt', 'Phản hồi niêm phong thiếu thời điểm.'),
    }
  }

  async submitQuestionAnswer(
    ticketId: string,
    questionId: string,
    request: SubmitQuestionAnswerRequest,
  ): Promise<SubmitQuestionAnswerResponse> {
    const payload = await this.request<unknown>(
      `/official-exams/tickets/${encodeURIComponent(ticketId)}/questions/${encodeURIComponent(questionId)}/answers`,
      {
        method: 'PUT',
        body: request,
      },
    )
    const record = unwrapRecord(payload, 'Phản hồi lưu câu trả lời không hợp lệ.')
    return {
      submissionId: requiredString(record, 'submissionId', 'Phản hồi thiếu submissionId.'),
      ticketId: requiredString(record, 'ticketId', 'Phản hồi thiếu mã vé.'),
      questionId: requiredAnyString(record, ['examQuestionId', 'questionId'], 'Phản hồi thiếu mã câu hỏi.'),
      followUpIndex: requiredNumber(record, 'followUpIndex', 'Phản hồi thiếu followUpIndex.'),
      audioObjectKey: requiredString(record, 'audioObjectKey', 'Phản hồi thiếu audioObjectKey.'),
      audioHashSha256: requiredString(record, 'audioHashSha256', 'Phản hồi thiếu audioHashSha256.'),
      status: requiredString(record, 'status', 'Phản hồi thiếu trạng thái.'),
      canRequestFollowUp: record.canRequestFollowUp === true,
    }
  }

  async requestNextFollowUp(ticketId: string, submissionId: string): Promise<OfficialExamNextFollowUpResponse> {
    const payload = await this.request<unknown>(
      `/official-exams/tickets/${encodeURIComponent(ticketId)}/submissions/${encodeURIComponent(submissionId)}/next-followup`,
      { method: 'POST' },
    )
    const record = unwrapRecord(payload, 'Phản hồi câu hỏi phụ không hợp lệ.')
    return {
      hasMoreFollowUp: record.hasMoreFollowUp === true,
      followUpIndex: typeof record.followUpIndex === 'number' ? record.followUpIndex : 0,
      maxFollowUpQuestions: typeof record.maxFollowUpQuestions === 'number' ? record.maxFollowUpQuestions : 0,
      parentSubmissionId: requiredString(record, 'parentSubmissionId', 'Phản hồi thiếu parentSubmissionId.'),
      questionId: requiredString(record, 'questionId', 'Phản hồi thiếu questionId.'),
      followUpPrompt: nullableString(record, 'followUpPrompt'),
    }
  }

  async submitExam(
    ticketId: string,
    answers: ExamAnswer[] = [],
    finalizePerTurn: boolean = answers.length === 0,
  ): Promise<SubmitResponse> {
    const payload = await this.request<unknown>(`/official-exams/tickets/${encodeURIComponent(ticketId)}/submission`, {
      method: 'PUT',
      body: {
        answers,
        finalizePerTurn,
      },
    })
    const record = unwrapRecord(payload, 'Phản hồi nộp bài không hợp lệ.')
    return {
      ticketId: requiredString(record, 'ticketId', 'Phản hồi nộp bài thiếu mã vé.'),
      status: requiredString(record, 'status', 'Phản hồi nộp bài thiếu trạng thái.'),
      submittedAt: requiredString(record, 'submittedAt', 'Phản hồi nộp bài thiếu thời điểm.'),
      submissionCount: requiredNumber(record, 'submissionCount', 'Phản hồi nộp bài thiếu số lượng.'),
      isKioskLocked: record.isKioskLocked === true,
    }
  }

  async getSubmissionStatus(ticketId: string): Promise<SubmissionStatus> {
    const payload = await this.request<unknown>(`/official-exams/tickets/${encodeURIComponent(ticketId)}/submission`)
    const record = unwrapRecord(payload, 'Trạng thái nộp bài không hợp lệ.')
    return {
      ticketId: requiredString(record, 'ticketId', 'Thiếu mã vé.'),
      status: requiredString(record, 'status', 'Thiếu trạng thái.'),
      submittedAt: nullableString(record, 'submittedAt'),
      totalSubmissions: requiredNumber(record, 'totalSubmissions', 'Thiếu tổng submission.'),
      pendingSubmissions: requiredNumber(record, 'pendingSubmissions', 'Thiếu submission đang chờ.'),
      gradedSubmissions: requiredNumber(record, 'gradedSubmissions', 'Thiếu submission đã chấm.'),
      failedSubmissions: requiredNumber(record, 'failedSubmissions', 'Thiếu submission lỗi.'),
    }
  }

  private async request<T>(path: string, options: RequestOptions = {}, retried = false): Promise<T> {
    const requestHeaders: Record<string, string> = { Accept: 'application/json', ...options.headers }
    const sentSessionEpoch = this.sessionEpoch
    const sentAccessToken = this.accessToken
    if (sentAccessToken && !options.skipAuth) requestHeaders.Authorization = `Bearer ${sentAccessToken}`
    const isKioskAuthPath = path.startsWith('/auth/kiosk/')
    const isOfficialExamPath = path.startsWith('/official-exams/')
    if (isKioskAuthPath || isOfficialExamPath) {
      if (this.deviceId) requestHeaders['X-Device-Id'] = this.deviceId
      if (this.kioskVersion) requestHeaders['X-Kiosk-Version'] = this.kioskVersion
    }
    if (!options.skipAuth && isOfficialExamPath && this.kioskSessionToken) {
      requestHeaders['X-Kiosk-Session-Token'] = this.kioskSessionToken
    }

    let body: BodyInit | undefined
    if (options.body instanceof FormData || options.body instanceof Blob || typeof options.body === 'string') {
      body = options.body
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body)
      requestHeaders['Content-Type'] = 'application/json'
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      headers: requestHeaders,
      body,
      signal: options.signal,
    })

    const normalizedPath = path.split('?')[0]
    const isRefreshExcludedPath =
      normalizedPath === '/auth/kiosk/password-login' || normalizedPath === '/auth/kiosk/refresh-token'

    if (response.status === 401 && !retried && !options.skipRefresh && !isRefreshExcludedPath) {
      if (this.sessionRevoked || this.sessionEpoch !== sentSessionEpoch) {
        const revokedPayload = await readResponsePayload(response)
        throw new ApiProblemError(parseProblem(revokedPayload, response.status, response.statusText), response.status)
      }
      if (this.accessToken && this.accessToken !== sentAccessToken && !options.skipAuth) {
        return this.request<T>(path, options, true)
      }
      const refreshed = await this.refresh()
      if (refreshed) return this.request<T>(path, options, true)
    }

    const payload = await readResponsePayload(response)
    if (!response.ok) {
      throw new ApiProblemError(parseProblem(payload, response.status, response.statusText), response.status)
    }

    return payload as T
  }
}

function buildSessionRevokedEvent(error: unknown): SessionRevokedEvent {
  if (error instanceof ApiProblemError) {
    let reason: SessionRevocationReason = 'SESSION_REVOKED'
    let fallbackMessage = 'Phiên đăng nhập đã hết hạn hoặc bị thu hồi (401). Vui lòng đăng nhập lại.'
    if (error.status === 403) {
      reason = 'ACCOUNT_LOCKED'
      fallbackMessage = 'Tài khoản bị khóa hoặc không có quyền sử dụng Kiosk (403).'
    } else if (error.status === 409) {
      reason = 'REFRESH_CONFLICT'
      fallbackMessage = 'Phiên đăng nhập gặp xung đột làm mới token (409). Vui lòng đăng nhập lại.'
    }
    return {
      status: error.status,
      reason,
      errorCode: error.problem.errorCode,
      message: error.problem.detail ?? fallbackMessage,
      error,
    }
  }

  return {
    status: 401,
    reason: 'SESSION_REVOKED',
    message: error instanceof Error ? error.message : 'Phiên đăng nhập đã hết hạn hoặc bị thu hồi.',
    error,
  }
}

async function readResponsePayload(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined
  const contentType = response.headers.get('content-type') ?? ''
  const text = await response.text()
  if (!text) return undefined
  if (contentType.includes('application/json') || contentType.includes('+json')) {
    try {
      return JSON.parse(text) as unknown
    } catch {
      return { detail: text }
    }
  }
  return { detail: text }
}

function unwrapRecord(payload: unknown, message: string): JsonRecord {
  const unwrapped = unwrap<unknown>(payload)
  if (!isRecord(unwrapped)) throw new Error(message)
  return unwrapped
}

function requiredString(record: JsonRecord, key: string, message: string): string {
  const value = record[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(message)
  return value
}

function requiredAnyString(record: JsonRecord, keys: string[], message: string): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  throw new Error(message)
}

function nullableString(record: JsonRecord, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function requiredNumber(record: JsonRecord, key: string, message: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(message)
  return value
}

function normalizeAudioUploadAuthorization(payload: unknown): AudioUploadAuthorization {
  const record = unwrapRecord(payload, 'Quyền tải audio không hợp lệ.')
  const requiredHeaders = isRecord(record.requiredHeaders) ? record.requiredHeaders : {}
  const normalizedHeaders: Record<string, string> = {}
  for (const [key, value] of Object.entries(requiredHeaders)) {
    if (typeof value === 'string') normalizedHeaders[key] = value
  }
  return {
    objectKey: requiredString(record, 'objectKey', 'Quyền tải audio thiếu object key.'),
    fileName: requiredString(record, 'fileName', 'Quyền tải audio thiếu tên file.'),
    uploadUrl: requiredString(record, 'uploadUrl', 'Quyền tải audio thiếu URL.'),
    expiresAt: requiredString(record, 'expiresAt', 'Quyền tải audio thiếu hạn URL.'),
    requiredHeaders: normalizedHeaders,
  }
}

function normalizeFollowUps(rawFollowUps: unknown): WorkstationFollowUpItem[] {
  if (!Array.isArray(rawFollowUps)) return []
  return rawFollowUps
    .filter((item): item is JsonRecord => isRecord(item))
    .map((item) => ({
      submissionId: requiredString(item, 'submissionId', 'Follow-up thiếu submissionId.'),
      parentSubmissionId: nullableString(item, 'parentSubmissionId'),
      questionId: requiredAnyString(item, ['examQuestionId', 'questionId'], 'Follow-up thiếu examQuestionId.'),
      followUpIndex: typeof item.followUpIndex === 'number' ? item.followUpIndex : 0,
      followUpPrompt: nullableString(item, 'followUpPrompt'),
      generatedFollowUpPrompt: nullableString(item, 'generatedFollowUpPrompt'),
      transcriptWhisper: nullableString(item, 'transcriptWhisper'),
      audioObjectKey: nullableString(item, 'audioObjectKey'),
      audioHashSha256: nullableString(item, 'audioHashSha256'),
    }))
}

function normalizeAntiCheatLogResponse(
  payload: unknown,
  fallbackRequest: AntiCheatLogRequest,
): ExamAntiCheatLogResponse {
  if (!isRecord(payload)) {
    return {
      id: '',
      clientEventId: fallbackRequest.clientEventId,
      ticketId: fallbackRequest.ticketId,
      shiftId: fallbackRequest.shiftId,
      studentId: fallbackRequest.studentId,
      studentCode: '',
      studentName: '',
      eventType: fallbackRequest.eventType,
      severity: fallbackRequest.severity,
      details: fallbackRequest.details ?? null,
      violationCount: 0,
      isLocked: false,
      maxViolations: 3,
      lockThreshold: 4,
      remainingStrikes: 4,
      occurredAt: new Date().toISOString(),
    }
  }
  return {
    id: readString(payload, 'id', 'Id') ?? '',
    clientEventId: readString(payload, 'clientEventId', 'ClientEventId') ?? fallbackRequest.clientEventId,
    ticketId: readString(payload, 'ticketId', 'TicketId') ?? fallbackRequest.ticketId,
    shiftId: readString(payload, 'shiftId', 'ShiftId') ?? fallbackRequest.shiftId,
    studentId: readString(payload, 'studentId', 'StudentId') ?? fallbackRequest.studentId,
    studentCode: readString(payload, 'studentCode', 'StudentCode') ?? '',
    studentName: readString(payload, 'studentName', 'StudentName') ?? '',
    eventType: readString(payload, 'eventType', 'EventType') ?? fallbackRequest.eventType,
    severity: readString(payload, 'severity', 'Severity') ?? fallbackRequest.severity,
    details: nullableString(payload, 'details'),
    violationCount: typeof payload.violationCount === 'number' ? payload.violationCount : 0,
    isLocked: payload.isLocked === true,
    maxViolations: typeof payload.maxViolations === 'number' ? payload.maxViolations : 3,
    lockThreshold: typeof payload.lockThreshold === 'number' ? payload.lockThreshold : 4,
    remainingStrikes: typeof payload.remainingStrikes === 'number' ? payload.remainingStrikes : 4,
    occurredAt: readString(payload, 'occurredAt', 'OccurredAt') ?? new Date().toISOString(),
  }
}

function normalizeTicket(payload: unknown): StudentWorkstationTicket {
  const record = unwrapRecord(payload, 'Vé thi tại máy trạm không hợp lệ.')
  const questionsValue = record.questions
  const questions = Array.isArray(questionsValue)
    ? questionsValue.map((value) => {
        const question = unwrapRecord(value, 'Câu hỏi thi thật không hợp lệ.')
        return {
          questionId: requiredString(question, 'questionId', 'Câu hỏi thiếu mã.'),
          orderIndex: requiredNumber(question, 'orderIndex', 'Câu hỏi thiếu thứ tự.'),
          title: requiredString(question, 'title', 'Câu hỏi thiếu tiêu đề.'),
          content: requiredString(question, 'content', 'Câu hỏi thiếu nội dung.'),
          bloomLevel: requiredString(question, 'bloomLevel', 'Câu hỏi thiếu Bloom.'),
          difficulty: requiredString(question, 'difficulty', 'Câu hỏi thiếu độ khó.'),
          imageUrl: nullableString(question, 'imageUrl'),
          imageDescription: nullableString(question, 'imageDescription'),
        }
      })
    : []

  return {
    id: requiredString(record, 'id', 'Vé thi thiếu mã.'),
    shiftId: requiredString(record, 'shiftId', 'Vé thi thiếu ca.'),
    shiftName: requiredString(record, 'shiftName', 'Vé thi thiếu tên ca.'),
    roomLab: requiredString(record, 'roomLab', 'Vé thi thiếu phòng.'),
    startTime: requiredString(record, 'startTime', 'Vé thi thiếu giờ bắt đầu.'),
    endTime: requiredString(record, 'endTime', 'Vé thi thiếu giờ kết thúc.'),
    shiftStatus: requiredString(record, 'shiftStatus', 'Vé thi thiếu trạng thái ca.'),
    sessionTitle: requiredString(record, 'sessionTitle', 'Vé thi thiếu tên kỳ thi.'),
    studentId: requiredString(record, 'studentId', 'Vé thi thiếu mã sinh viên.'),
    seatNumber: requiredNumber(record, 'seatNumber', 'Vé thi thiếu số máy.'),
    status: requiredString(record, 'status', 'Vé thi thiếu trạng thái.'),
    examSetId: nullableString(record, 'examSetId'),
    examSetCode: nullableString(record, 'examSetCode'),
    examInputMode: nullableString(record, 'examInputMode'),
    transcriptBufferSeconds: requiredNumber(record, 'transcriptBufferSeconds', 'Vé thi thiếu buffer transcript.'),
    hasFollowUp: record.hasFollowUp === true,
    maxFollowUpQuestions: typeof record.maxFollowUpQuestions === 'number' ? record.maxFollowUpQuestions : 0,
    serverTimeUtc: requiredAnyString(
      record,
      ['serverNowUtc', 'serverTimeUtc', 'serverUtcNow'],
      'Vé thi thiếu thời gian máy chủ.',
    ),
    questions,
    isExamPublished: typeof record.isExamPublished === 'boolean' ? record.isExamPublished : undefined,
    isKioskLocked: record.isKioskLocked === true,
    deviceId: nullableString(record, 'deviceId'),
    deviceLockedAt: nullableString(record, 'deviceLockedAt'),
    deviceUnlockCount: typeof record.deviceUnlockCount === 'number' ? record.deviceUnlockCount : 0,
    violationCount: typeof record.violationCount === 'number' ? record.violationCount : 0,
    maxViolations: typeof record.maxViolations === 'number' ? record.maxViolations : 3,
    lockThreshold: typeof record.lockThreshold === 'number' ? record.lockThreshold : 4,
    remainingStrikes: typeof record.remainingStrikes === 'number' ? record.remainingStrikes : 4,
    examAttemptType: nullableString(record, 'examAttemptType'),
    followUps: normalizeFollowUps(record.followUps),
  }
}

function normalizeTicketResponse(payload: unknown): ExamTicketResponse {
  const record = unwrapRecord(payload, 'Phản hồi điểm danh không hợp lệ.')
  return {
    id: requiredString(record, 'id', 'Phản hồi điểm danh thiếu mã vé.'),
    shiftId: requiredString(record, 'shiftId', 'Phản hồi điểm danh thiếu ca.'),
    studentId: requiredString(record, 'studentId', 'Phản hồi điểm danh thiếu sinh viên.'),
    seatNumber: requiredNumber(record, 'seatNumber', 'Phản hồi điểm danh thiếu số máy.'),
    ipAddress: nullableString(record, 'ipAddress'),
    status: requiredString(record, 'status', 'Phản hồi điểm danh thiếu trạng thái.'),
    checkedInAt: requiredString(record, 'checkedInAt', 'Phản hồi điểm danh thiếu thời điểm.'),
    examSetId: nullableString(record, 'examSetId'),
    examSetCode: nullableString(record, 'examSetCode'),
    activeSessionToken: nullableString(record, 'activeSessionToken'),
    deviceId: nullableString(record, 'deviceId'),
    deviceLockedAt: nullableString(record, 'deviceLockedAt'),
    deviceUnlockCount: typeof record.deviceUnlockCount === 'number' ? record.deviceUnlockCount : 0,
  }
}

function normalizeTicketState(payload: unknown): OfficialExamTicketStateResponse {
  const record = unwrapRecord(payload, 'Trạng thái khôi phục vé thi không hợp lệ.')
  const followUps = normalizeFollowUps(record.followUps)

  return {
    ticketId: requiredString(record, 'ticketId', 'Trạng thái vé thiếu ticketId.'),
    shiftId: requiredString(record, 'shiftId', 'Trạng thái vé thiếu shiftId.'),
    status: requiredString(record, 'status', 'Trạng thái vé thiếu status.'),
    isExamPublished: record.isExamPublished === true,
    isKioskLocked: record.isKioskLocked === true,
    violationCount: typeof record.violationCount === 'number' ? record.violationCount : 0,
    maxAllowedWindowBlurs:
      typeof record.maxViolations === 'number'
        ? record.maxViolations
        : typeof record.maxAllowedWindowBlurs === 'number'
          ? record.maxAllowedWindowBlurs
          : 3,
    windowBlurLockThreshold:
      typeof record.lockThreshold === 'number'
        ? record.lockThreshold
        : typeof record.windowBlurLockThreshold === 'number'
          ? record.windowBlurLockThreshold
          : 4,
    remainingStrikes: typeof record.remainingStrikes === 'number' ? record.remainingStrikes : 4,
    serverUtcNow: requiredAnyString(
      record,
      ['serverNowUtc', 'serverUtcNow', 'serverTimeUtc'],
      'Trạng thái vé thiếu serverNowUtc.',
    ),
    deviceId: nullableString(record, 'deviceId'),
    deviceLockedAt: nullableString(record, 'deviceLockedAt'),
    deviceUnlockCount: typeof record.deviceUnlockCount === 'number' ? record.deviceUnlockCount : 0,
    followUps,
  }
}

function normalizeHeartbeatResponse(payload: unknown): KioskHeartbeatResponse {
  const record = unwrapRecord(payload, 'Phản hồi heartbeat không hợp lệ.')
  return {
    ticketId: requiredString(record, 'ticketId', 'Heartbeat thiếu ticketId.'),
    shiftId: requiredString(record, 'shiftId', 'Heartbeat thiếu shiftId.'),
    ticketStatus: requiredString(record, 'ticketStatus', 'Heartbeat thiếu ticketStatus.'),
    shiftStatus: requiredString(record, 'shiftStatus', 'Heartbeat thiếu shiftStatus.'),
    serverUtcNow: requiredString(record, 'serverUtcNow', 'Heartbeat thiếu serverUtcNow.'),
    remainingShiftSeconds: typeof record.remainingShiftSeconds === 'number' ? record.remainingShiftSeconds : 0,
    isLocked: record.isLocked === true,
    deviceUnlockRequired: record.deviceUnlockRequired === true,
    shouldTerminateExam: record.shouldTerminateExam === true,
    notice: nullableString(record, 'notice'),
  }
}
