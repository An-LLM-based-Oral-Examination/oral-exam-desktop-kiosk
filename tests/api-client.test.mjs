import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ApiClient,
  ApiProblemError,
  KIOSK_DEVICE_ID_REGEX,
  KIOSK_VERSION_REGEX,
  classifyByodConflict,
  describeByodConflict,
  isTicketLockedError,
  isTicketNotInProgressError,
  isValidKioskDeviceId,
  isValidKioskVersion,
} from '../node_modules/.tmp/test-dist/services/api.js'
import { retryOnce } from '../node_modules/.tmp/test-dist/utils/crypto.js'

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('ApiClient uses /auth/kiosk/* endpoints, attaches BYOD headers on auth/exam calls, and sends finalizePerTurn: true', async () => {
  const recordedCalls = []
  const originalFetch = globalThis.fetch

  globalThis.fetch = async (url, init = {}) => {
    const urlStr = String(url)
    recordedCalls.push({ url: urlStr, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body })

    if (urlStr.endsWith('/auth/kiosk/password-login')) {
      return jsonResponse({
        accessToken: 'jwt-access-1',
        refreshToken: 'jwt-refresh-1',
        tokenType: 'Bearer',
        expiresIn: 900,
        mustChangePassword: false,
        user: { id: 'u1', email: 'sv@fpt.edu.vn', fullName: 'Nguyen Van A', role: 'student' },
      })
    }

    if (urlStr.endsWith('/auth/kiosk/change-password')) {
      return jsonResponse({
        accessToken: 'jwt-access-2',
        refreshToken: 'jwt-refresh-2',
        tokenType: 'Bearer',
        expiresIn: 900,
        mustChangePassword: false,
      })
    }

    if (urlStr.endsWith('/tickets/t1/check-in')) {
      return jsonResponse({
        id: 't1',
        shiftId: 's1',
        studentId: 'u1',
        seatNumber: 5,
        ipAddress: '127.0.0.1',
        status: 'IN_PROGRESS',
        checkedInAt: '2026-11-25T08:00:00Z',
        examSetId: 'set1',
        activeSessionToken: 'kiosk-session-secret-token',
      })
    }

    if (urlStr.endsWith('/tickets/t1/heartbeat')) {
      return jsonResponse({
        ticketId: 't1',
        shiftId: 's1',
        ticketStatus: 'IN_PROGRESS',
        shiftStatus: 'in_progress',
        serverUtcNow: '2026-11-25T08:05:00Z',
        remainingShiftSeconds: 1200,
        isLocked: false,
        deviceUnlockRequired: false,
        shouldTerminateExam: false,
        notice: null,
      })
    }

    if (urlStr.endsWith('/tickets/t1/questions/q1/audio-upload-authorizations')) {
      return jsonResponse({
        objectKey: 'official/s1/t1/q1_0.webm',
        fileName: '05_SE001_Q1.webm',
        uploadUrl: 'https://r2.example/upload',
        expiresAt: '2026-11-25T08:15:00Z',
        requiredHeaders: { 'Content-Type': 'audio/webm', 'If-None-Match': '*' },
      }, 201)
    }

    if (urlStr === 'https://r2.example/upload') {
      return new Response(null, { status: 200 })
    }

    if (urlStr.endsWith('/tickets/t1/questions/q1/answers')) {
      return jsonResponse({
        submissionId: 'sub1',
        ticketId: 't1',
        examQuestionId: 'q1',
        followUpIndex: 0,
        audioObjectKey: 'official/s1/t1/q1_0.webm',
        audioHashSha256: 'a'.repeat(64),
        status: 'RECORDED',
        canRequestFollowUp: true,
      })
    }

    if (urlStr.endsWith('/tickets/t1')) {
      return jsonResponse({
        ticketId: 't1',
        shiftId: 's1',
        status: 'IN_PROGRESS',
        isExamPublished: true,
        isKioskLocked: false,
        violationCount: 1,
        maxViolations: 3,
        lockThreshold: 4,
        remainingStrikes: 3,
        serverNowUtc: '2026-11-25T08:04:00Z',
        deviceId: 'oes-win-1234567890abcdef',
        deviceLockedAt: '2026-11-25T08:00:00Z',
        deviceUnlockCount: 0,
        followUps: [
          {
            submissionId: 'sub1',
            parentSubmissionId: null,
            examQuestionId: 'q1',
            followUpIndex: 0,
            followUpPrompt: null,
            generatedFollowUpPrompt: 'Giải thích thêm về DIP?',
            transcriptWhisper: 'raw text',
            audioObjectKey: 'official/s1/t1/q1_0.webm',
            audioHashSha256: 'a'.repeat(64),
          },
        ],
      })
    }

    if (urlStr.endsWith('/tickets/t1/submissions/sub1/next-followup')) {
      return jsonResponse({
        hasMoreFollowUp: true,
        followUpIndex: 1,
        maxFollowUpQuestions: 2,
        parentSubmissionId: 'sub1',
        questionId: 'q1',
        followUpPrompt: 'Hãy giải thích rõ hơn về nguyên lý Dependency Inversion?',
      })
    }

    if (urlStr.endsWith('/tickets/t1/submission')) {
      return jsonResponse({
        ticketId: 't1',
        status: 'AI_GRADED',
        submittedAt: '2026-11-25T08:25:00Z',
        submissionCount: 2,
        isKioskLocked: true,
      })
    }

    throw new Error(`Unexpected fetch URL: ${urlStr}`)
  }

  try {
    const deviceId = 'oes-win-1234567890abcdef'
    const kioskVersion = 'desktop-kiosk-0.1.1'
    assert.ok(KIOSK_DEVICE_ID_REGEX.test(deviceId))
    assert.ok(KIOSK_VERSION_REGEX.test(kioskVersion))

    const client = new ApiClient({
      baseUrl: 'http://127.0.0.1:5000/api/v1',
      deviceId,
      kioskVersion,
    })

    await client.login('sv001', 'Password123!')
    const loginCall = recordedCalls.find((c) => c.url.endsWith('/auth/kiosk/password-login'))
    assert.ok(loginCall, 'login must call /auth/kiosk/password-login')
    assert.equal(loginCall.headers['X-Device-Id'], deviceId)
    assert.equal(loginCall.headers['X-Kiosk-Version'], kioskVersion)
    assert.equal(loginCall.headers.Authorization, undefined)

    await client.changePassword('Password123!', 'NewPassword123!')
    const changePwCall = recordedCalls.find((c) => c.url.endsWith('/auth/kiosk/change-password'))
    assert.ok(changePwCall, 'changePassword must call /auth/kiosk/change-password')
    assert.equal(changePwCall.headers.Authorization, 'Bearer jwt-access-1')
    assert.equal(changePwCall.headers['X-Device-Id'], deviceId)
    assert.equal(changePwCall.headers['X-Kiosk-Version'], kioskVersion)

    const checkedIn = await client.checkIn('t1')
    assert.equal(checkedIn.activeSessionToken, 'kiosk-session-secret-token')
    assert.equal(client.getKioskSessionToken(), 'kiosk-session-secret-token')

    // Heartbeat must clamp audioLevelDb > 150 -> 150 and send all 3 BYOD headers
    const hb = await client.sendHeartbeat('t1', { audioLevelDb: 999, isFullscreen: true, displayCount: 1 })
    assert.equal(hb.remainingShiftSeconds, 1200)
    const hbCall = recordedCalls.find((c) => c.url.endsWith('/heartbeat'))
    assert.equal(hbCall.headers.Authorization, 'Bearer jwt-access-2')
    assert.equal(hbCall.headers['X-Device-Id'], deviceId)
    assert.equal(hbCall.headers['X-Kiosk-Version'], kioskVersion)
    assert.equal(hbCall.headers['X-Kiosk-Session-Token'], 'kiosk-session-secret-token')
    assert.equal(JSON.parse(hbCall.body).audioLevelDb, 150)

    // Per-turn upload & answer + follow-up
    const authz = await client.createQuestionAudioUploadAuthorization('t1', 'q1', 0)
    await client.uploadAudio(authz, new Blob(['webm'], { type: 'audio/webm' }))
    const answerRes = await client.submitQuestionAnswer('t1', 'q1', {
      followUpIndex: 0,
      parentSubmissionId: null,
      audioObjectKey: authz.objectKey,
      audioHashSha256: 'a'.repeat(64),
      initialVoiceTranscript: 'raw text',
      transcriptWhisper: 'raw text',
      timestampsWhisper: null,
      timeSpentSeconds: 30,
      isManuallyEdited: false,
    })
    assert.equal(answerRes.canRequestFollowUp, true)

    const followUp = await client.requestNextFollowUp('t1', answerRes.submissionId)
    assert.equal(followUp.hasMoreFollowUp, true)
    assert.equal(followUp.followUpIndex, 1)

    // Ticket state recovery matches Backend OfficialExamTicketStateResponse exact JSON keys
    const ticketState = await client.getTicketState('t1')
    assert.equal(ticketState.violationCount, 1)
    assert.equal(ticketState.serverUtcNow, '2026-11-25T08:04:00Z')
    assert.equal(ticketState.followUps.length, 1)
    assert.equal(ticketState.followUps[0].questionId, 'q1')
    assert.equal(ticketState.followUps[0].generatedFollowUpPrompt, 'Giải thích thêm về DIP?')

    // Finalize per-turn (0 answers) must send finalizePerTurn: true and accept AI_GRADED
    const finalize = await client.submitExam('t1', [])
    assert.equal(finalize.status, 'AI_GRADED')
    const submitCall = recordedCalls.find((c) => c.url.endsWith('/tickets/t1/submission'))
    assert.deepEqual(JSON.parse(submitCall.body), { answers: [], finalizePerTurn: true })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('ApiClient refresh() calls /auth/kiosk/refresh-token with BYOD headers and retries 401 requests', async () => {
  const calls = []
  const originalFetch = globalThis.fetch
  let ticketAttempts = 0

  globalThis.fetch = async (url, init = {}) => {
    const urlStr = String(url)
    calls.push({ url: urlStr, headers: init.headers ?? {}, body: init.body })

    if (urlStr.endsWith('/auth/kiosk/password-login')) {
      return jsonResponse({
        accessToken: 'expired-access',
        refreshToken: 'refresh-1',
        tokenType: 'Bearer',
        expiresIn: 900,
        mustChangePassword: false,
        user: { id: 'u1', email: 'sv@fpt.edu.vn', fullName: 'Nguyen Van A', role: 'student' },
      })
    }

    if (urlStr.endsWith('/auth/kiosk/refresh-token')) {
      return jsonResponse({
        accessToken: 'fresh-access',
        refreshToken: 'refresh-2',
        tokenType: 'Bearer',
        expiresIn: 900,
      })
    }

    if (urlStr.endsWith('/official-exams/tickets/current')) {
      ticketAttempts += 1
      if (ticketAttempts === 1) {
        return jsonResponse({ status: 401, detail: 'Token expired' }, 401)
      }
      return jsonResponse({
        id: 't1',
        shiftId: 's1',
        shiftName: 'Ca 1',
        roomLab: 'P201',
        startTime: '2026-11-25T08:00:00Z',
        endTime: '2026-11-25T09:00:00Z',
        shiftStatus: 'in_progress',
        sessionTitle: 'Thi cuoi ky',
        studentId: 'u1',
        seatNumber: 1,
        status: 'IN_PROGRESS',
        examSetId: 'set1',
        examSetCode: 'DE01',
        examInputMode: 'VoiceOnly',
        transcriptBufferSeconds: 60,
        hasFollowUp: false,
        maxFollowUpQuestions: 0,
        serverNowUtc: '2026-11-25T08:05:00Z',
        questions: [],
      })
    }

    throw new Error(`Unexpected fetch URL: ${urlStr}`)
  }

  try {
    const client = new ApiClient({
      baseUrl: 'http://127.0.0.1:5000/api/v1',
      deviceId: 'oes-win-1234567890abcdef',
      kioskVersion: 'desktop-kiosk-0.1.1',
    })
    await client.login('sv001', 'Password123!')
    const ticket = await client.getCurrentTicket()
    assert.equal(ticket.id, 't1')
    assert.equal(ticketAttempts, 2)

    const refreshCall = calls.find((c) => c.url.endsWith('/auth/kiosk/refresh-token'))
    assert.ok(refreshCall, 'refresh must call /auth/kiosk/refresh-token')
    assert.equal(refreshCall.headers['X-Device-Id'], 'oes-win-1234567890abcdef')
    assert.equal(refreshCall.headers['X-Kiosk-Version'], 'desktop-kiosk-0.1.1')
    assert.equal(refreshCall.headers.Authorization, undefined)
    assert.deepEqual(JSON.parse(refreshCall.body), { refreshToken: 'refresh-1' })

    const retryTicketCall = calls.filter((c) => c.url.endsWith('/official-exams/tickets/current'))[1]
    assert.equal(retryTicketCall.headers.Authorization, 'Bearer fresh-access')
  } finally {
    globalThis.fetch = originalFetch
  }
})

for (const scenario of [
  { status: 401, errorCode: 'INVALID_REFRESH_TOKEN', expectedReason: 'SESSION_REVOKED', detail: 'Token bị thu hồi.' },
  { status: 403, errorCode: 'ACCOUNT_LOCKED', expectedReason: 'ACCOUNT_LOCKED', detail: 'Tài khoản đã bị khóa.' },
  { status: 409, errorCode: 'REFRESH_TOKEN_CONFLICT', expectedReason: 'REFRESH_CONFLICT', detail: 'Xung đột token.' },
]) {
  test(`ApiClient refresh failure (${scenario.status}) surfaces exact error and invokes onSessionRevoked`, async () => {
    const originalFetch = globalThis.fetch
    const revokedEvents = []

    globalThis.fetch = async (url) => {
      const urlStr = String(url)
      if (urlStr.endsWith('/auth/kiosk/password-login')) {
        return jsonResponse({
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
          tokenType: 'Bearer',
          expiresIn: 900,
          mustChangePassword: false,
          user: { id: 'u1', email: 'sv@fpt.edu.vn', fullName: 'Nguyen Van A', role: 'student' },
        })
      }
      if (urlStr.endsWith('/official-exams/tickets/current')) {
        return jsonResponse({ status: 401, detail: 'Access token expired' }, 401)
      }
      if (urlStr.endsWith('/auth/kiosk/refresh-token')) {
        return jsonResponse(
          { status: scenario.status, title: 'Refresh failed', detail: scenario.detail, errorCode: scenario.errorCode },
          scenario.status,
        )
      }
      throw new Error(`Unexpected fetch URL: ${urlStr}`)
    }

    try {
      const client = new ApiClient({
        baseUrl: 'http://127.0.0.1:5000/api/v1',
        deviceId: 'oes-win-1234567890abcdef',
        kioskVersion: 'desktop-kiosk-0.1.1',
        onSessionRevoked: (event) => revokedEvents.push(event),
      })

      await client.login('sv001', 'Password123!')
      client.setKioskSessionToken('active-session-token')

      await assert.rejects(
        () => client.getCurrentTicket(),
        (err) =>
          err instanceof ApiProblemError &&
          err.status === scenario.status &&
          err.problem.errorCode === scenario.errorCode &&
          err.problem.detail === scenario.detail,
      )

      assert.equal(client.getStoredUser(), null)
      assert.equal(client.getKioskSessionToken(), null)
      assert.equal(revokedEvents.length, 1)
      assert.equal(revokedEvents[0].status, scenario.status)
      assert.equal(revokedEvents[0].reason, scenario.expectedReason)
      assert.equal(revokedEvents[0].errorCode, scenario.errorCode)
      assert.equal(revokedEvents[0].message, scenario.detail)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
}

test('ApiClient uploadAudio uses Electron Main IPC when available and surfaces 412/network errors', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const ipcCalls = []
  let fetchCalled = false

  globalThis.fetch = async () => {
    fetchCalled = true
    return new Response(null, { status: 200 })
  }

  globalThis.window = {
    kioskApi: {
      uploadAudioToR2: async (req) => {
        ipcCalls.push(req)
        if (ipcCalls.length === 1) {
          return { ok: true, status: 200, statusText: 'OK', headers: { etag: '"abc"' } }
        }
        if (ipcCalls.length === 2) {
          return {
            ok: false,
            status: 412,
            statusText: 'Precondition Failed',
            headers: {},
            bodyText: 'PreconditionFailed',
          }
        }
        return {
          ok: false,
          status: 0,
          statusText: 'Network Error',
          headers: {},
          errorMessage: 'ECONNRESET',
        }
      },
    },
  }

  try {
    const client = new ApiClient({
      baseUrl: 'http://127.0.0.1:5000/api/v1',
      deviceId: 'oes-win-1234567890abcdef',
      kioskVersion: 'desktop-kiosk-0.1.1',
    })
    const authz = {
      objectKey: 'official/s1/t1/q1_0.webm',
      fileName: '01_SE001_Q1.webm',
      uploadUrl: 'https://bucket.r2.cloudflarestorage.com/official/s1/t1/q1_0.webm?X-Amz-Signature=sig',
      expiresAt: '2026-11-25T08:15:00Z',
      requiredHeaders: { 'Content-Type': 'audio/webm', 'If-None-Match': '*' },
    }
    const audio = new Blob(['audio-bytes'], { type: 'audio/webm' })

    await client.uploadAudio(authz, audio)
    assert.equal(fetchCalled, false, 'Must use Electron Main IPC instead of renderer fetch')
    assert.equal(ipcCalls.length, 1)
    assert.equal(ipcCalls[0].uploadUrl, authz.uploadUrl)
    assert.deepEqual(ipcCalls[0].headers, { 'Content-Type': 'audio/webm', 'If-None-Match': '*' })
    assert.ok(ipcCalls[0].data instanceof ArrayBuffer)
    assert.equal(ipcCalls[0].data.byteLength, 11)

    await assert.rejects(
      () => client.uploadAudio(authz, audio),
      (err) => err instanceof ApiProblemError && err.status === 412,
    )

    await assert.rejects(
      () => client.uploadAudio(authz, audio),
      (err) => err instanceof Error && err.message.includes('ECONNRESET'),
    )
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
})

test('Device ID and Kiosk Version validators enforce backend regex constraints', () => {
  assert.equal(isValidKioskDeviceId('oes-win32-550e8400-e29b-41d4-a716-446655440000'), true)
  assert.equal(isValidKioskDeviceId('short-id'), false)
  assert.equal(isValidKioskDeviceId('invalid space character 12345'), false)

  assert.equal(isValidKioskVersion('desktop-kiosk-0.1.1'), true)
  assert.equal(isValidKioskVersion('desktop-kiosk-development'), true)
  assert.equal(isValidKioskVersion('x'), false)

  assert.throws(
    () =>
      new ApiClient({
        baseUrl: 'http://127.0.0.1:5000/api/v1',
        deviceId: 'too-short',
        kioskVersion: 'desktop-kiosk-0.1.1',
      }),
    /X-Device-Id/,
  )
  assert.throws(
    () =>
      new ApiClient({
        baseUrl: 'http://127.0.0.1:5000/api/v1',
        deviceId: 'oes-win-1234567890abcdef',
        kioskVersion: 'x',
      }),
    /X-Kiosk-Version/,
  )
})

test('classifyByodConflict detects all 3 Backend 409 BYOD conflict types', () => {
  const mismatch = new ApiProblemError(
    { status: 409, type: 'https://oralexam.fpt.edu.vn/errors/device-mismatch', detail: 'DEVICE_MISMATCH' },
    409,
  )
  assert.equal(classifyByodConflict(mismatch), 'DEVICE_MISMATCH')
  assert.match(describeByodConflict('DEVICE_MISMATCH'), /mở khóa thiết bị BYOD/)

  const sessionConflict = new ApiProblemError(
    { status: 409, type: 'https://oralexam.fpt.edu.vn/errors/active-session-conflict' },
    409,
  )
  assert.equal(classifyByodConflict(sessionConflict), 'ACTIVE_SESSION_CONFLICT')

  const otherTicket = new ApiProblemError(
    { status: 409, detail: 'DEVICE_IN_USE_OTHER_TICKET' },
    409,
  )
  assert.equal(classifyByodConflict(otherTicket), 'DEVICE_IN_USE_OTHER_TICKET')
})

test('ApiClient changePassword 401 refreshes once on success and triggers onSessionRevoked when refresh fails', async () => {
  const originalFetch = globalThis.fetch

  // Part A: changePassword 401 -> refresh succeeds -> changePassword retries with fresh token
  {
    const calls = []
    let changeAttempts = 0
    globalThis.fetch = async (url, init = {}) => {
      const urlStr = String(url)
      calls.push({ url: urlStr, headers: init.headers ?? {}, body: init.body })

      if (urlStr.endsWith('/auth/kiosk/password-login')) {
        return jsonResponse({
          accessToken: 'expired-pw-access',
          refreshToken: 'refresh-pw-1',
          tokenType: 'Bearer',
          expiresIn: 900,
          mustChangePassword: true,
          user: { id: 'u1', email: 'sv@fpt.edu.vn', fullName: 'Nguyen Van A', role: 'student' },
        })
      }
      if (urlStr.endsWith('/auth/kiosk/change-password')) {
        changeAttempts += 1
        if (changeAttempts === 1) {
          return jsonResponse({ status: 401, detail: 'Expired token' }, 401)
        }
        return jsonResponse({
          accessToken: 'fresh-pw-access',
          refreshToken: 'refresh-pw-2',
          tokenType: 'Bearer',
          expiresIn: 900,
          mustChangePassword: false,
        })
      }
      if (urlStr.endsWith('/auth/kiosk/refresh-token')) {
        return jsonResponse({
          accessToken: 'refreshed-pw-access',
          refreshToken: 'refresh-pw-2',
          tokenType: 'Bearer',
          expiresIn: 900,
        })
      }
      throw new Error(`Unexpected fetch URL: ${urlStr}`)
    }

    try {
      const revokedEvents = []
      const client = new ApiClient({
        baseUrl: 'http://127.0.0.1:5000/api/v1',
        deviceId: 'oes-win-1234567890abcdef',
        kioskVersion: 'desktop-kiosk-0.1.1',
        onSessionRevoked: (event) => revokedEvents.push(event),
      })

      const loginRes = await client.login('sv001', 'OldPass1!')
      assert.equal(loginRes.mustChangePassword, true)
      const changeRes = await client.changePassword('OldPass1!', 'NewPass123!')
      assert.equal(changeRes.mustChangePassword, false)
      assert.equal(changeAttempts, 2)
      assert.equal(revokedEvents.length, 0)
      const refreshCalls = calls.filter((c) => c.url.endsWith('/auth/kiosk/refresh-token'))
      assert.equal(refreshCalls.length, 1)
      const retryChange = calls.filter((c) => c.url.endsWith('/auth/kiosk/change-password'))[1]
      assert.equal(retryChange.headers.Authorization, 'Bearer refreshed-pw-access')
    } finally {
      globalThis.fetch = originalFetch
    }
  }

  // Part B: changePassword 401 -> refresh returns 401 -> invokes onSessionRevoked and clears session
  {
    const revokedEvents = []
    let refreshAttempts = 0
    globalThis.fetch = async (url) => {
      const urlStr = String(url)
      if (urlStr.endsWith('/auth/kiosk/password-login')) {
        return jsonResponse({
          accessToken: 'expired-pw-access',
          refreshToken: 'refresh-pw-1',
          tokenType: 'Bearer',
          expiresIn: 900,
          mustChangePassword: true,
          user: { id: 'u1', email: 'sv@fpt.edu.vn', fullName: 'Nguyen Van A', role: 'student' },
        })
      }
      if (urlStr.endsWith('/auth/kiosk/change-password')) {
        return jsonResponse({ status: 401, detail: 'Expired token' }, 401)
      }
      if (urlStr.endsWith('/auth/kiosk/refresh-token')) {
        refreshAttempts += 1
        return jsonResponse(
          { status: 401, detail: 'Refresh token revoked', errorCode: 'INVALID_REFRESH_TOKEN' },
          401,
        )
      }
      throw new Error(`Unexpected fetch URL: ${urlStr}`)
    }

    try {
      const client = new ApiClient({
        baseUrl: 'http://127.0.0.1:5000/api/v1',
        deviceId: 'oes-win-1234567890abcdef',
        kioskVersion: 'desktop-kiosk-0.1.1',
        onSessionRevoked: (event) => revokedEvents.push(event),
      })

      await client.login('sv001', 'OldPass1!')
      await assert.rejects(
        () => client.changePassword('OldPass1!', 'NewPass123!'),
        (err) => err instanceof ApiProblemError && err.status === 401,
      )
      assert.equal(refreshAttempts, 1)
      assert.equal(revokedEvents.length, 1)
      assert.equal(revokedEvents[0].reason, 'SESSION_REVOKED')
      assert.equal(client.getStoredUser(), null)
    } finally {
      globalThis.fetch = originalFetch
    }
  }
})

test('ApiClient staggered concurrent 401 requests perform only one refresh rotation', async () => {
  const originalFetch = globalThis.fetch
  let refreshCount = 0
  let releaseStaggeredHeartbeat
  const staggeredHeartbeatGate = new Promise((resolve) => {
    releaseStaggeredHeartbeat = resolve
  })
  const authHeadersSeen = []

  globalThis.fetch = async (url, init = {}) => {
    const urlStr = String(url)
    const headers = init.headers ?? {}

    if (urlStr.endsWith('/auth/kiosk/password-login')) {
      return jsonResponse({
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        tokenType: 'Bearer',
        expiresIn: 900,
        mustChangePassword: false,
        user: { id: 'u1', email: 'sv@fpt.edu.vn', fullName: 'Nguyen Van A', role: 'student' },
      })
    }

    if (urlStr.endsWith('/auth/kiosk/refresh-token')) {
      refreshCount += 1
      queueMicrotask(() => {
        setTimeout(() => releaseStaggeredHeartbeat(), 10)
      })
      return jsonResponse({
        accessToken: 'access-2',
        refreshToken: 'refresh-2',
        tokenType: 'Bearer',
        expiresIn: 900,
      })
    }

    if (urlStr.endsWith('/official-exams/tickets/current')) {
      authHeadersSeen.push({ path: 'current', auth: headers.Authorization })
      if (headers.Authorization === 'Bearer access-1') {
        return jsonResponse({ status: 401, detail: 'Expired' }, 401)
      }
      return jsonResponse({
        id: 't1',
        shiftId: 's1',
        shiftName: 'Ca 1',
        roomLab: 'P201',
        startTime: '2026-11-25T08:00:00Z',
        endTime: '2026-11-25T09:00:00Z',
        shiftStatus: 'in_progress',
        sessionTitle: 'Thi cuoi ky',
        studentId: 'u1',
        seatNumber: 1,
        status: 'IN_PROGRESS',
        examSetId: 'set1',
        examSetCode: 'DE01',
        examInputMode: 'VoiceOnly',
        transcriptBufferSeconds: 60,
        hasFollowUp: false,
        maxFollowUpQuestions: 0,
        serverNowUtc: '2026-11-25T08:05:00Z',
        questions: [],
      })
    }

    if (urlStr.endsWith('/tickets/t1/heartbeat')) {
      authHeadersSeen.push({ path: 'heartbeat', auth: headers.Authorization })
      if (headers.Authorization === 'Bearer access-1') {
        await staggeredHeartbeatGate
        return jsonResponse({ status: 401, detail: 'Expired late' }, 401)
      }
      return jsonResponse({
        ticketId: 't1',
        shiftId: 's1',
        ticketStatus: 'IN_PROGRESS',
        shiftStatus: 'in_progress',
        serverUtcNow: '2026-11-25T08:05:00Z',
        remainingShiftSeconds: 1200,
        isLocked: false,
        deviceUnlockRequired: false,
        shouldTerminateExam: false,
        notice: null,
      })
    }

    throw new Error(`Unexpected fetch URL: ${urlStr}`)
  }

  try {
    const client = new ApiClient({
      baseUrl: 'http://127.0.0.1:5000/api/v1',
      deviceId: 'oes-win-1234567890abcdef',
      kioskVersion: 'desktop-kiosk-0.1.1',
    })
    await client.login('sv001', 'Password123!')

    const [ticket, heartbeat] = await Promise.all([
      client.getCurrentTicket(),
      client.sendHeartbeat('t1', { isFullscreen: true, displayCount: 1 }),
    ])

    assert.equal(ticket.id, 't1')
    assert.equal(heartbeat.remainingShiftSeconds, 1200)
    assert.equal(refreshCount, 1, 'Staggered 401 after completed refresh must not trigger a second rotation')
    assert.deepEqual(
      authHeadersSeen.filter((entry) => entry.auth === 'Bearer access-2').map((entry) => entry.path).sort(),
      ['current', 'heartbeat'],
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('ApiClient uploadAudio merges lowercase content-type without duplicate Content-Type header', async () => {
  const originalWindow = globalThis.window
  const originalFetch = globalThis.fetch
  const ipcHeaders = []
  const fetchHeaders = []

  const authz = {
    objectKey: 'official/s1/t1/q1_0.webm',
    fileName: '01_SE001_Q1.webm',
    uploadUrl: 'https://bucket.r2.cloudflarestorage.com/official/s1/t1/q1_0.webm?X-Amz-Signature=sig',
    expiresAt: '2026-11-25T08:15:00Z',
    requiredHeaders: { 'content-type': 'audio/webm', 'If-None-Match': '*' },
  }
  const audio = new Blob(['audio-bytes'], { type: 'audio/webm' })

  try {
    globalThis.window = {
      kioskApi: {
        uploadAudioToR2: async (req) => {
          ipcHeaders.push(req.headers)
          return { ok: true, status: 200, statusText: 'OK', headers: {} }
        },
      },
    }

    const client = new ApiClient({
      baseUrl: 'http://127.0.0.1:5000/api/v1',
      deviceId: 'oes-win-1234567890abcdef',
      kioskVersion: 'desktop-kiosk-0.1.1',
    })

    await client.uploadAudio(authz, audio)
    assert.equal(ipcHeaders.length, 1)
    assert.deepEqual(Object.keys(ipcHeaders[0]), ['content-type', 'If-None-Match'])
    assert.equal(new Headers(ipcHeaders[0]).get('content-type'), 'audio/webm')

    globalThis.window = undefined
    globalThis.fetch = async (_url, init = {}) => {
      fetchHeaders.push(init.headers)
      return new Response(null, { status: 200 })
    }

    await client.uploadAudio(authz, audio)
    assert.equal(fetchHeaders.length, 1)
    assert.deepEqual(Object.keys(fetchHeaders[0]), ['content-type', 'If-None-Match'])
    assert.equal(new Headers(fetchHeaders[0]).get('content-type'), 'audio/webm')
  } finally {
    globalThis.window = originalWindow
    globalThis.fetch = originalFetch
  }
})

test('ApiClient logAntiCheat parses ExamAntiCheatLogDto, transcribe forwards timestampsJson, and normalizeTicket preserves full workstation fields', async () => {
  const originalFetch = globalThis.fetch

  globalThis.fetch = async (url) => {
    const urlStr = String(url)
    if (urlStr.endsWith('/official-exams/anti-cheat/log')) {
      return jsonResponse({
        id: 'ac-1',
        clientEventId: 'evt-1',
        ticketId: 't1',
        shiftId: 's1',
        studentId: 'u1',
        studentCode: 'SE180001',
        studentName: 'Nguyen Van A',
        eventType: 'TAB_SWITCH',
        severity: 'high',
        details: 'Blocked shortcut',
        violationCount: 1,
        isLocked: true,
        maxViolations: 3,
        lockThreshold: 4,
        remainingStrikes: 2,
        occurredAt: '2026-11-27T08:10:00Z',
      })
    }
    if (urlStr.endsWith('/speech/stt')) {
      return jsonResponse({
        text: 'hello world',
        rawText: 'hello world',
        provider: 'whisper',
        timestampsJson: '{"words":[{"word":"hello","start":0,"end":0.4}]}',
        confidenceScore: 0.94,
      })
    }
    if (urlStr.endsWith('/official-exams/tickets/current')) {
      return jsonResponse({
        id: 't1',
        shiftId: 's1',
        shiftName: 'Ca 1',
        roomLab: 'P201',
        startTime: '2026-11-27T08:00:00Z',
        endTime: '2026-11-27T09:00:00Z',
        shiftStatus: 'in_progress',
        sessionTitle: 'Thi cuoi ky',
        studentId: 'u1',
        seatNumber: 4,
        status: 'IN_PROGRESS',
        examSetId: 'set-1',
        examSetCode: 'DE01',
        examInputMode: 'VoiceWithTranscriptEdit',
        transcriptBufferSeconds: 60,
        hasFollowUp: true,
        maxFollowUpQuestions: 2,
        serverNowUtc: '2026-11-27T08:05:00Z',
        isExamPublished: false,
        isKioskLocked: true,
        deviceId: 'oes-win-1234567890abcdef',
        deviceLockedAt: '2026-11-27T08:01:00Z',
        deviceUnlockCount: 1,
        violationCount: 2,
        maxViolations: 3,
        lockThreshold: 4,
        remainingStrikes: 2,
        examAttemptType: 'RE',
        followUps: [
          {
            submissionId: 'sub-1',
            parentSubmissionId: null,
            examQuestionId: 'q1',
            followUpIndex: 0,
            followUpPrompt: null,
            generatedFollowUpPrompt: 'Deep dive?',
            transcriptWhisper: 'answer',
            audioObjectKey: 'k1',
            audioHashSha256: 'h1',
          },
        ],
        questions: [],
      })
    }
    throw new Error(`Unexpected URL: ${urlStr}`)
  }

  try {
    const client = new ApiClient({
      baseUrl: 'http://127.0.0.1:5000/api/v1',
      deviceId: 'oes-win-1234567890abcdef',
      kioskVersion: 'desktop-kiosk-0.1.1',
    })

    const acDto = await client.logAntiCheat({
      ticketId: 't1',
      shiftId: 's1',
      studentId: 'u1',
      clientEventId: 'evt-1',
      eventType: 'TAB_SWITCH',
      severity: 'HIGH',
      details: 'Blocked shortcut',
    })
    assert.equal(acDto.isLocked, true)
    assert.equal(acDto.violationCount, 1)
    assert.equal(acDto.lockThreshold, 4)
    assert.equal(acDto.remainingStrikes, 2)

    const stt = await client.transcribe(new Blob(['a'], { type: 'audio/webm' }), 'hint', '')
    assert.equal(stt.timestampsJson, '{"words":[{"word":"hello","start":0,"end":0.4}]}')
    assert.equal(stt.confidenceScore, 0.94)

    const ticket = await client.getCurrentTicket()
    assert.equal(ticket.isExamPublished, false)
    assert.equal(ticket.isKioskLocked, true)
    assert.equal(ticket.deviceId, 'oes-win-1234567890abcdef')
    assert.equal(ticket.deviceUnlockCount, 1)
    assert.equal(ticket.violationCount, 2)
    assert.equal(ticket.examAttemptType, 'RE')
    assert.equal(ticket.followUps?.length, 1)
    assert.equal(ticket.followUps?.[0].questionId, 'q1')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('isTicketLockedError, malformed JSON resilience, sessionEpoch stale-401 guard, and retryOnce non-retryable 4xx', async () => {
  const lockedErr = new ApiProblemError(
    { status: 409, type: 'https://oralexam.fpt.edu.vn/errors/ticket-locked', detail: 'TICKET_LOCKED' },
    409,
  )
  assert.equal(isTicketLockedError(lockedErr), true)
  assert.equal(
    isTicketNotInProgressError(
      new ApiProblemError({ status: 409, detail: 'Vé thi không ở trạng thái đang thi.' }, 409),
    ),
    true,
  )

  // retryOnce must NOT wait or retry permanent 4xx
  let attempts409 = 0
  await assert.rejects(
    () =>
      retryOnce(async () => {
        attempts409 += 1
        throw lockedErr
      }, 10),
    (err) => err === lockedErr,
  )
  assert.equal(attempts409, 1)

  let attempts503 = 0
  const okAfterRetry = await retryOnce(async () => {
    attempts503 += 1
    if (attempts503 === 1) {
      throw new ApiProblemError({ status: 503, detail: 'Temporary' }, 503)
    }
    return 'recovered'
  }, 5)
  assert.equal(attempts503, 2)
  assert.equal(okAfterRetry, 'recovered')

  // Malformed JSON body with 502 status preserves status in ApiProblemError
  const originalFetch = globalThis.fetch
  let releaseStaleCall
  const staleGate = new Promise((resolve) => {
    releaseStaleCall = resolve
  })

  globalThis.fetch = async (url, init = {}) => {
    const urlStr = String(url)
    if (urlStr.endsWith('/bad-gateway')) {
      return new Response('<html>502 Bad Gateway</html>', {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'content-type': 'application/json' },
      })
    }
    if (urlStr.endsWith('/auth/kiosk/password-login')) {
      return jsonResponse({
        accessToken: 'acc-fresh',
        refreshToken: 'ref-fresh',
        tokenType: 'Bearer',
        expiresIn: 900,
        mustChangePassword: false,
        user: { id: 'u1', email: 'sv@fpt.edu.vn', fullName: 'SV', role: 'student' },
      })
    }
    if (urlStr.endsWith('/stale-check')) {
      await staleGate
      return jsonResponse({ status: 401, detail: 'Old session 401' }, 401)
    }
    if (urlStr.endsWith('/auth/kiosk/refresh-token')) {
      throw new Error(`Must NOT refresh on stale session epoch (${init.body})`)
    }
    throw new Error(`Unexpected URL: ${urlStr}`)
  }

  try {
    const client = new ApiClient({
      baseUrl: 'http://127.0.0.1:5000/api/v1',
      deviceId: 'oes-win-1234567890abcdef',
      kioskVersion: 'desktop-kiosk-0.1.1',
    })

    await assert.rejects(
      () => client.getSubmissionStatus('bad-gateway').catch(async (err) => {
        throw err
      }),
    )

    // Test malformed JSON directly via login or ticket endpoint returning 502 HTML with application/json header
    const badJsonResp = new Response('<html>502</html>', {
      status: 502,
      headers: { 'content-type': 'application/json' },
    })
    assert.equal(badJsonResp.status, 502)

    // Start stale request in session 1, then clearSession + login in session 2 before stale 401 resolves
    const stalePromise = client.getTicketState('stale-check').catch((e) => e)
    // Wait a tick until stale request has captured sessionEpoch=0
    await new Promise((r) => setTimeout(r, 5))
    await client.login('sv001', 'Password123!')
    releaseStaleCall()
    const staleErr = await stalePromise
    assert.ok(staleErr instanceof ApiProblemError)
    assert.equal(staleErr.status, 401)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('ApiClient malformed JSON 502 payload yields ApiProblemError instead of SyntaxError', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response('<html>502 Bad Gateway</html>', {
      status: 502,
      statusText: 'Bad Gateway',
      headers: { 'content-type': 'application/json' },
    })

  try {
    const client = new ApiClient({
      baseUrl: 'http://127.0.0.1:5000/api/v1',
      deviceId: 'oes-win-1234567890abcdef',
      kioskVersion: 'desktop-kiosk-0.1.1',
    })
    await assert.rejects(
      () => client.getCurrentTicket(),
      (err) => err instanceof ApiProblemError && err.status === 502 && /502 Bad Gateway/.test(err.message),
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('ApiClient refresh() discards stale response if clearSession() or new login() runs mid-refresh', async () => {
  const originalFetch = globalThis.fetch
  const seenAuthHeaders = []
  const revokedEvents = []
  let refreshStartedResolve
  let releaseRefresh
  const refreshStarted = new Promise((resolve) => {
    refreshStartedResolve = resolve
  })
  const refreshGate = new Promise((resolve) => {
    releaseRefresh = resolve
  })

  globalThis.fetch = async (url, init = {}) => {
    const urlStr = String(url)
    if (urlStr.endsWith('/auth/kiosk/password-login')) {
      return jsonResponse({
        accessToken: 'acc-1',
        refreshToken: 'ref-1',
        tokenType: 'Bearer',
        expiresIn: 900,
        mustChangePassword: false,
        user: { id: 'u1', email: 'sv@fpt.edu.vn', fullName: 'SV', role: 'student' },
      })
    }
    if (urlStr.endsWith('/official-exams/tickets/current')) {
      seenAuthHeaders.push(init.headers?.Authorization ?? null)
      return jsonResponse({ status: 401, detail: 'Expired' }, 401)
    }
    if (urlStr.endsWith('/auth/kiosk/refresh-token')) {
      refreshStartedResolve()
      await refreshGate
      return jsonResponse({
        accessToken: 'acc-2-zombie',
        refreshToken: 'ref-2-zombie',
        tokenType: 'Bearer',
        expiresIn: 900,
      })
    }
    throw new Error(`Unexpected URL: ${urlStr}`)
  }

  try {
    const client = new ApiClient({
      baseUrl: 'http://127.0.0.1:5000/api/v1',
      deviceId: 'oes-win-1234567890abcdef',
      kioskVersion: 'desktop-kiosk-0.1.1',
      onSessionRevoked: (event) => revokedEvents.push(event),
    })

    await client.login('sv001', 'Password123!')
    const pendingTicketPromise = client.getCurrentTicket().catch((err) => err)
    await refreshStarted

    // Clear session while /auth/kiosk/refresh-token is still in flight
    client.clearSession()
    releaseRefresh()

    const firstResult = await pendingTicketPromise
    assert.ok(firstResult instanceof ApiProblemError)
    assert.equal(firstResult.status, 401)
    assert.equal(revokedEvents.length, 0, 'clearSession() mid-refresh must not trigger spurious sessionRevoked')

    // Subsequent request must NOT send the zombie accessToken from the discarded refresh
    await client.getCurrentTicket().catch(() => undefined)
    assert.equal(seenAuthHeaders[seenAuthHeaders.length - 1], null)
  } finally {
    globalThis.fetch = originalFetch
  }
})
