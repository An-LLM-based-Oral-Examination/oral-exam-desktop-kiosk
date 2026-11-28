import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApiClient, ApiProblemError } from '../node_modules/.tmp/test-dist/services/api.js'
import {
  buildTurnDraftKey,
  clearTicketDrafts,
  loadPendingAntiCheatLogs,
  loadTicketTurnDrafts,
  savePendingAntiCheatLog,
  saveTurnDraft,
} from '../node_modules/.tmp/test-dist/services/offline-draft.js'
import {
  executeTurnUploadAndSubmit,
  flushPendingAntiCheatLogsQueue,
  flushPendingTurnDraftsQueue,
} from '../node_modules/.tmp/test-dist/services/turn-sync.js'
import { sha256HexAndBase64 } from '../node_modules/.tmp/test-dist/utils/crypto.js'
import { resolveQuestionImageUrl } from '../node_modules/.tmp/test-dist/utils/question-image.js'
import { PreCheckScreen } from '../node_modules/.tmp/test-dist/screens/PreCheckScreen.js'
import { LobbyScreen } from '../node_modules/.tmp/test-dist/screens/LobbyScreen.js'
import { ExamScreen } from '../node_modules/.tmp/test-dist/screens/ExamScreen.js'
import { WaitingTicketScreen } from '../node_modules/.tmp/test-dist/screens/WaitingTicketScreen.js'
import { BlockedScreen } from '../node_modules/.tmp/test-dist/screens/BlockedScreen.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => readFileSync(path.join(root, relativePath), 'utf8')
const require = createRequire(import.meta.url)

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function createFakeIndexedDb() {
  const databases = new Map()

  function createObjectStoreWrapper(storeDef) {
    return {
      keyPath: storeDef.keyPath,
      indexNames: {
        contains: (name) => storeDef.indexes.has(name),
      },
      createIndex(name, keyPath) {
        storeDef.indexes.set(name, keyPath)
        return { name, keyPath }
      },
      put(value) {
        const req = { result: undefined, error: null, onsuccess: null, onerror: null }
        queueMicrotask(() => {
          const key = value[storeDef.keyPath]
          storeDef.records.set(key, value)
          req.result = key
          req.onsuccess?.({ target: req })
        })
        return req
      },
      get(key) {
        const req = { result: undefined, error: null, onsuccess: null, onerror: null }
        queueMicrotask(() => {
          req.result = storeDef.records.get(key)
          req.onsuccess?.({ target: req })
        })
        return req
      },
      delete(key) {
        const req = { result: undefined, error: null, onsuccess: null, onerror: null }
        queueMicrotask(() => {
          storeDef.records.delete(key)
          req.onsuccess?.({ target: req })
        })
        return req
      },
      index(name) {
        const indexKeyPath = storeDef.indexes.get(name)
        return {
          getAll(filterValue) {
            const req = { result: [], error: null, onsuccess: null, onerror: null }
            queueMicrotask(() => {
              req.result = Array.from(storeDef.records.values()).filter(
                (item) => item[indexKeyPath] === filterValue,
              )
              req.onsuccess?.({ target: req })
            })
            return req
          },
        }
      },
    }
  }

  return {
    open(name, version) {
      const req = { result: null, error: null, onupgradeneeded: null, onsuccess: null, onerror: null }
      queueMicrotask(() => {
        let dbState = databases.get(name)
        const isUpgrade = !dbState || dbState.version < version
        if (!dbState) {
          dbState = { version, stores: new Map() }
          databases.set(name, dbState)
        }

        const dbWrapper = {
          version,
          objectStoreNames: {
            contains: (storeName) => dbState.stores.has(storeName),
          },
          createObjectStore(storeName, opts) {
            const storeDef = {
              keyPath: opts.keyPath,
              indexes: new Map(),
              records: new Map(),
            }
            dbState.stores.set(storeName, storeDef)
            return createObjectStoreWrapper(storeDef)
          },
          transaction(storeName) {
            return {
              objectStore(targetName) {
                const storeDef = dbState.stores.get(targetName ?? storeName)
                if (!storeDef) throw new Error(`Missing store: ${targetName ?? storeName}`)
                return createObjectStoreWrapper(storeDef)
              },
            }
          },
          close() {},
        }

        req.result = dbWrapper
        if (isUpgrade) {
          dbState.version = version
          req.onupgradeneeded?.({ target: req })
        }
        req.onsuccess?.({ target: req })
      })
      return req
    },
  }
}

function makeTicket(overrides = {}) {
  return {
    id: 'ticket-1',
    shiftId: 'shift-1',
    shiftName: 'Ca 1',
    roomLab: 'P201',
    startTime: '2026-11-27T08:00:00Z',
    endTime: '2026-11-27T09:00:00Z',
    shiftStatus: 'in_progress',
    sessionTitle: 'Thi cuoi ky SE',
    studentId: 'student-1',
    seatNumber: 5,
    status: 'IN_PROGRESS',
    examSetId: 'set-1',
    examSetCode: 'DE01',
    examInputMode: 'VoiceWithTranscriptEdit',
    transcriptBufferSeconds: 60,
    hasFollowUp: true,
    maxFollowUpQuestions: 2,
    serverTimeUtc: '2026-11-27T08:05:00Z',
    questions: [
      {
        questionId: 'q1',
        orderIndex: 1,
        title: 'SOLID Principles',
        content: 'Trinh bay nguyen ly DIP',
        bloomLevel: 'Understand',
        difficulty: 'medium',
        imageUrl: '/uploads/questions/202611/diagram.png',
        imageDescription: 'So do DIP',
      },
    ],
    ...overrides,
  }
}

test('M4: sha256HexAndBase64 computes matching hex and Base64 digests', async () => {
  const payload = Buffer.from('oral-exam-audio-sample')
  const expectedHex = createHash('sha256').update(payload).digest('hex')
  const expectedBase64 = createHash('sha256').update(payload).digest('base64')
  const blob = new Blob([payload], { type: 'audio/webm' })

  const result = await sha256HexAndBase64(blob)
  assert.equal(result.hex, expectedHex)
  assert.equal(result.base64, expectedBase64)
})

test('M4: saveTurnDraft happens before STT and VoiceOnly skips STT in App.tsx', () => {
  const appSource = read('src/App.tsx')
  const stopIdx = appSource.indexOf('audio = await stopQuestionRecording()')
  const saveDraftIdx = appSource.indexOf('await saveTurnDraft(', stopIdx)
  const transcribeIdx = appSource.indexOf('await apiClient.transcribe(', stopIdx)

  assert.ok(stopIdx > 0)
  assert.ok(saveDraftIdx > stopIdx, 'saveTurnDraft must run after stopQuestionRecording')
  assert.ok(transcribeIdx > saveDraftIdx, 'saveTurnDraft must run BEFORE apiClient.transcribe')
  assert.match(appSource, /const isVoiceOnly = ticket\.examInputMode === 'VoiceOnly'/)
  assert.match(appSource, /if\s*\(!isVoiceOnly\)\s*\{[\s\S]*apiClient\.transcribe/)
})

test('M4: executeTurnUploadAndSubmit sends pre-auth sha256Base64, resumes stages, treats 412 idempotently, and cleans draft', async () => {
  const originalIndexedDb = globalThis.indexedDB
  globalThis.indexedDB = createFakeIndexedDb()

  try {
    const ticket = makeTicket()
    const audio = new Blob(['test-webm-binary-content'], { type: 'audio/webm' })
    const { hex: expectedHex, base64: expectedBase64 } = await sha256HexAndBase64(audio)

    // Case 1: Fresh RECORDED -> sends expectedSha256Base64, handles 412 idempotently -> submits & deletes draft
    {
      const calls = []
      const mockApi = {
        async createQuestionAudioUploadAuthorization(ticketId, questionId, followUpIndex, sha256Base64) {
          calls.push({ step: 'auth', ticketId, questionId, followUpIndex, sha256Base64 })
          return {
            objectKey: 'official/s1/t1/q1_0.webm',
            fileName: '05_SE001_Q1.webm',
            uploadUrl: 'https://r2.example/put',
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            requiredHeaders: { 'Content-Type': 'audio/webm', 'If-None-Match': '*' },
          }
        },
        async uploadAudio() {
          calls.push({ step: 'put' })
          throw new ApiProblemError({ status: 412, detail: 'Precondition Failed' }, 412)
        },
        async submitQuestionAnswer(ticketId, questionId, req) {
          calls.push({ step: 'submit', ticketId, questionId, req })
          return {
            submissionId: 'sub-1',
            ticketId,
            questionId,
            followUpIndex: req.followUpIndex,
            audioObjectKey: req.audioObjectKey,
            audioHashSha256: req.audioHashSha256,
            status: 'RECORDED',
            canRequestFollowUp: true,
          }
        },
      }

      const res = await executeTurnUploadAndSubmit({
        apiClient: mockApi,
        ticket,
        questionId: 'q1',
        followUpIndex: 0,
        parentSubmissionId: null,
        followUpPrompt: null,
        audio,
        rawVoiceTranscript: 'dip answer',
        finalTranscript: 'dip answer',
        isManuallyEdited: false,
        timeSpentSeconds: 12,
      })

      assert.equal(res.submissionId, 'sub-1')
      assert.equal(calls.length, 3)
      assert.equal(calls[0].sha256Base64, expectedBase64)
      assert.equal(calls[2].req.audioHashSha256, expectedHex)
      assert.equal((await loadTicketTurnDrafts(ticket.id)).length, 0)
    }

    // Case 2: Resume from UPLOAD_AUTHORIZED (valid cached authz) -> skips upload-url auth request
    {
      const calls = []
      const draftKey = buildTurnDraftKey(ticket.id, 'q1', 0)
      await saveTurnDraft({
        metadata: {
          draftKey,
          ticketId: ticket.id,
          shiftId: ticket.shiftId,
          studentId: ticket.studentId,
          questionId: 'q1',
          followUpIndex: 0,
          parentSubmissionId: null,
          followUpPrompt: null,
          initialVoiceTranscript: 'cached',
          transcriptWhisper: 'cached',
          timestampsWhisper: null,
          timeSpentSeconds: 10,
          isManuallyEdited: false,
          objectKey: 'official/s1/t1/q1_cached.webm',
          sha256: expectedHex,
          sha256Base64: expectedBase64,
          uploadAuthorization: {
            objectKey: 'official/s1/t1/q1_cached.webm',
            fileName: 'q1.webm',
            uploadUrl: 'https://r2.example/cached-put',
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            requiredHeaders: { 'Content-Type': 'audio/webm', 'If-None-Match': '*' },
          },
          stage: 'UPLOAD_AUTHORIZED',
          createdAt: '2026-11-27T08:05:00Z',
          updatedAt: '2026-11-27T08:05:00Z',
        },
        audio,
      })

      const mockApi = {
        async createQuestionAudioUploadAuthorization() {
          calls.push('auth')
          throw new Error('Should not re-request upload-url for valid UPLOAD_AUTHORIZED draft')
        },
        async uploadAudio(authz) {
          calls.push(`put:${authz.uploadUrl}`)
        },
        async submitQuestionAnswer(_t, _q, req) {
          calls.push(`submit:${req.audioObjectKey}`)
          return {
            submissionId: 'sub-2',
            ticketId: ticket.id,
            questionId: 'q1',
            followUpIndex: 0,
            audioObjectKey: req.audioObjectKey,
            audioHashSha256: req.audioHashSha256,
            status: 'RECORDED',
            canRequestFollowUp: false,
          }
        },
        async requestNextFollowUp() {
          calls.push('followup')
          return {
            hasMoreFollowUp: false,
            followUpIndex: 0,
            maxFollowUpQuestions: 2,
            parentSubmissionId: 'sub-2',
            questionId: 'q1',
            followUpPrompt: null,
          }
        },
      }

      await flushPendingTurnDraftsQueue({ apiClient: mockApi, ticket, requestFollowUp: true })
      assert.deepEqual(calls, [
        'put:https://r2.example/cached-put',
        'submit:official/s1/t1/q1_cached.webm',
      ])
      assert.equal((await loadTicketTurnDrafts(ticket.id)).length, 0)
    }

    // Case 3: Resume from AUDIO_UPLOADED -> skips both upload-url and R2 PUT, and triggers next-followup on recovery
    {
      const calls = []
      const draftKey = buildTurnDraftKey(ticket.id, 'q1', 0)
      await saveTurnDraft({
        metadata: {
          draftKey,
          ticketId: ticket.id,
          shiftId: ticket.shiftId,
          studentId: ticket.studentId,
          questionId: 'q1',
          followUpIndex: 0,
          parentSubmissionId: null,
          followUpPrompt: null,
          initialVoiceTranscript: 'uploaded',
          transcriptWhisper: 'uploaded',
          timestampsWhisper: null,
          timeSpentSeconds: 15,
          isManuallyEdited: false,
          objectKey: 'official/s1/t1/q1_already_uploaded.webm',
          sha256: expectedHex,
          sha256Base64: expectedBase64,
          uploadAuthorization: null,
          stage: 'AUDIO_UPLOADED',
          createdAt: '2026-11-27T08:06:00Z',
          updatedAt: '2026-11-27T08:06:00Z',
        },
        audio,
      })

      const mockApi = {
        async createQuestionAudioUploadAuthorization() {
          calls.push('auth')
          throw new Error('Should not call auth for AUDIO_UPLOADED')
        },
        async uploadAudio() {
          calls.push('put')
          throw new Error('Should not re-upload R2 for AUDIO_UPLOADED')
        },
        async submitQuestionAnswer(_t, _q, req) {
          calls.push(`submit:${req.audioObjectKey}`)
          return {
            submissionId: 'sub-3',
            ticketId: ticket.id,
            questionId: 'q1',
            followUpIndex: 0,
            audioObjectKey: req.audioObjectKey,
            audioHashSha256: req.audioHashSha256,
            status: 'RECORDED',
            canRequestFollowUp: true,
          }
        },
        async requestNextFollowUp(ticketId, submissionId) {
          calls.push(`followup:${ticketId}:${submissionId}`)
          return {
            hasMoreFollowUp: true,
            followUpIndex: 1,
            maxFollowUpQuestions: 2,
            parentSubmissionId: submissionId,
            questionId: 'q1',
            followUpPrompt: 'Deepen DIP?',
          }
        },
      }

      await flushPendingTurnDraftsQueue({ apiClient: mockApi, ticket, requestFollowUp: true })
      assert.deepEqual(calls, [
        'submit:official/s1/t1/q1_already_uploaded.webm',
        'followup:ticket-1:sub-3',
      ])
    }
  } finally {
    globalThis.indexedDB = originalIndexedDb
  }
})

test('M4: submitExam uses single completeQuestion flow, resets autoSubmitTriggeredRef on error, and heartbeat auto-submits at time-up', () => {
  const appSource = read('src/App.tsx')

  const completeCallsInSubmit = appSource.match(/await completeQuestion\(true\)/g) ?? []
  assert.equal(completeCallsInSubmit.length, 1, 'submitExam must invoke completeQuestion(true) only once')

  assert.match(appSource, /if\s*\(allowIncomplete\)\s*\{\s*autoSubmitTriggeredRef\.current\s*=\s*false/)
  assert.match(
    appSource,
    /if\s*\(response\.remainingShiftSeconds === 0 && !response\.isLocked\)\s*\{[\s\S]*submitExamRef\.current\(true\)/,
  )
  assert.match(appSource, /completedMainIdsRef\.current\.length < ticket\.questions\.length/)
})

test('M4: scheduled check-in transitions cleanly to LobbyScreen with polling and disabled start until published', () => {
  const appSource = read('src/App.tsx')
  assert.doesNotMatch(appSource, /Ca thi chưa được mở \(trạng thái chưa ở "Đang diễn ra"\)/)
  assert.match(appSource, /refreshLobbyTicket/)

  const scheduledTicket = makeTicket({ shiftStatus: 'scheduled', questions: [] })
  const scheduledHtml = renderToStaticMarkup(
    React.createElement(LobbyScreen, {
      ticket: scheduledTicket,
      offlineDraftAvailable: false,
      hasCompleteDraft: false,
      onStart: async () => {},
      onResumeSubmit: async () => {},
      onRefreshTicket: async () => {},
    }),
  )
  assert.match(scheduledHtml, /Đang chờ phát đề/)
  assert.match(scheduledHtml, /Làm mới trạng thái đề/)
  assert.match(scheduledHtml, /disabled=""[^>]*>Đang chờ mở ca &amp; phát đề…/)

  const publishedTicket = makeTicket({ shiftStatus: 'in_progress' })
  const readyHtml = renderToStaticMarkup(
    React.createElement(LobbyScreen, {
      ticket: publishedTicket,
      offlineDraftAvailable: false,
      hasCompleteDraft: false,
      onStart: async () => {},
      onResumeSubmit: async () => {},
      onRefreshTicket: async () => {},
    }),
  )
  assert.match(readyHtml, /1 câu hỏi/)
  assert.match(readyHtml, /Bắt đầu làm bài →/)
})

test('M4: offline anti-cheat queue persists ClientEventId in IndexedDB v3 and drains idempotently', async () => {
  const originalIndexedDb = globalThis.indexedDB
  globalThis.indexedDB = createFakeIndexedDb()

  try {
    const req1 = {
      ticketId: 't-ac-1',
      shiftId: 's1',
      studentId: 'u1',
      clientEventId: 'evt-uuid-1111',
      eventType: 'WINDOW_BLUR',
      severity: 'HIGH',
      details: 'Blur 1',
    }
    const req2 = {
      ticketId: 't-ac-1',
      shiftId: 's1',
      studentId: 'u1',
      clientEventId: 'evt-uuid-2222',
      eventType: 'MULTI_MONITOR',
      severity: 'HIGH',
      details: '2 displays',
    }

    await savePendingAntiCheatLog(req1)
    await savePendingAntiCheatLog(req2)

    const loaded = await loadPendingAntiCheatLogs('t-ac-1')
    assert.equal(loaded.length, 2)
    assert.deepEqual(
      loaded.map((item) => item.clientEventId),
      ['evt-uuid-1111', 'evt-uuid-2222'],
    )

    // First flush: evt-1 succeeds, evt-2 fails transiently (503) -> only evt-2 remains
    let attempt = 0
    const flushed1 = await flushPendingAntiCheatLogsQueue({
      apiClient: {
        async logAntiCheat(req) {
          attempt += 1
          if (req.clientEventId === 'evt-uuid-2222' && attempt === 2) {
            throw new ApiProblemError({ status: 503, detail: 'Temporary unavailable' }, 503)
          }
        },
      },
      ticketId: 't-ac-1',
    })
    assert.equal(flushed1, 1)
    const afterPartial = await loadPendingAntiCheatLogs('t-ac-1')
    assert.deepEqual(
      afterPartial.map((item) => item.clientEventId),
      ['evt-uuid-2222'],
    )

    // Second flush: evt-2 succeeds with same clientEventId -> queue empty
    const sentIds = []
    const flushed2 = await flushPendingAntiCheatLogsQueue({
      apiClient: {
        async logAntiCheat(req) {
          sentIds.push(req.clientEventId)
        },
      },
      ticketId: 't-ac-1',
    })
    assert.equal(flushed2, 1)
    assert.deepEqual(sentIds, ['evt-uuid-2222'])
    assert.equal((await loadPendingAntiCheatLogs('t-ac-1')).length, 0)

    // clearTicketDrafts also clears anti-cheat queue for that ticket
    await savePendingAntiCheatLog(req1)
    await clearTicketDrafts('t-ac-1')
    assert.equal((await loadPendingAntiCheatLogs('t-ac-1')).length, 0)
  } finally {
    globalThis.indexedDB = originalIndexedDb
  }
})

for (const failStatus of [403, 409]) {
  test(`M4: staggered 401 after failed ${failStatus} refresh does not fire redundant second onSessionRevoked`, async () => {
    const originalFetch = globalThis.fetch
    const revokedEvents = []
    let releaseHeartbeat
    const heartbeatGate = new Promise((resolve) => {
      releaseHeartbeat = resolve
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
        return jsonResponse({ status: 401, detail: 'Expired' }, 401)
      }
      if (urlStr.endsWith('/auth/kiosk/refresh-token')) {
        setTimeout(() => releaseHeartbeat(), 20)
        return jsonResponse(
          {
            status: failStatus,
            detail: failStatus === 403 ? 'Locked' : 'Refresh conflict',
            errorCode: failStatus === 403 ? 'ACCOUNT_LOCKED' : 'REFRESH_TOKEN_CONFLICT',
          },
          failStatus,
        )
      }
      if (urlStr.endsWith('/tickets/t1/heartbeat')) {
        assert.equal(init.headers.Authorization, 'Bearer acc-1')
        await heartbeatGate
        return jsonResponse({ status: 401, detail: 'Staggered 401' }, 401)
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
      await Promise.allSettled([client.getCurrentTicket(), client.sendHeartbeat('t1')])

      assert.equal(revokedEvents.length, 1, 'onSessionRevoked must fire only once')
      assert.equal(revokedEvents[0].status, failStatus)
      assert.equal(
        revokedEvents[0].reason,
        failStatus === 403 ? 'ACCOUNT_LOCKED' : 'REFRESH_CONFLICT',
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })
}

test('M4: PreCheckScreen is fail-closed on Windows when windowsAgent is null, and passes when clean', () => {
  const missingAgentHtml = renderToStaticMarkup(
    React.createElement(PreCheckScreen, {
      microphoneReady: true,
      micTestSeconds: 30,
      micLevel: 72,
      displayCount: 1,
      isKioskMode: true,
      altTabTestMode: false,
      platform: 'win32',
      securitySnapshot: {
        deviceId: 'oes-win-1234567890abcdef',
        displayCount: 1,
        isFullscreen: true,
        windowsAgent: null,
      },
      scanningEnvironment: false,
      busy: false,
      onTest: async () => {},
      onRescanEnvironment: async () => {},
      onCheckIn: async () => {},
    }),
  )
  assert.match(missingAgentHtml, /Oes\.WindowsAgent/)
  assert.match(missingAgentHtml, /Mất kết nối Oes\.WindowsAgent/)
  assert.match(missingAgentHtml, /disabled=""[^>]*>Điểm danh và vào phòng chờ/)

  const cleanAgentHtml = renderToStaticMarkup(
    React.createElement(PreCheckScreen, {
      microphoneReady: true,
      micTestSeconds: 30,
      micLevel: 72,
      displayCount: 1,
      isKioskMode: true,
      altTabTestMode: false,
      platform: 'win32',
      securitySnapshot: {
        deviceId: 'oes-win-1234567890abcdef',
        displayCount: 1,
        isFullscreen: true,
        windowsAgent: {
          deviceFingerprint: 'oes-win-1234567890abcdef1234567890ab',
          displayCount: 1,
          vmDetected: false,
          vmIndicators: [],
          remoteControlDetected: false,
          remoteControlProcesses: [],
          disallowedProcesses: [],
          probedAtUtc: '2026-11-27T08:00:00Z',
        },
      },
      scanningEnvironment: false,
      busy: false,
      onTest: async () => {},
      onRescanEnvironment: async () => {},
      onCheckIn: async () => {},
    }),
  )
  assert.match(cleanAgentHtml, /Môi trường Windows sạch/)
  assert.doesNotMatch(cleanAgentHtml, /disabled=""[^>]*>Điểm danh và vào phòng chờ/)
})

test('M4: ExamScreen resolves relative imageUrl against apiOrigin and CSP img-src allows local API', () => {
  assert.equal(
    resolveQuestionImageUrl('/uploads/questions/202611/a.png', 'http://127.0.0.1:5000/api/v1'),
    'http://127.0.0.1:5000/uploads/questions/202611/a.png',
  )
  assert.equal(
    resolveQuestionImageUrl('https://cdn.example.com/q.png', 'http://127.0.0.1:5000/api/v1'),
    'https://cdn.example.com/q.png',
  )
  assert.equal(
    resolveQuestionImageUrl('data:image/png;base64,AAA', 'http://127.0.0.1:5000/api/v1'),
    'data:image/png;base64,AAA',
  )

  const examHtml = renderToStaticMarkup(
    React.createElement(ExamScreen, {
      ticket: makeTicket(),
      apiBaseUrl: 'http://127.0.0.1:5000/api/v1',
      question: makeTicket().questions[0],
      questionIndex: 0,
      completedMainCount: 0,
      activeFollowUp: null,
      generatingFollowUp: false,
      initialTranscript: '',
      transcript: '',
      recording: false,
      recordingElapsedSeconds: 0,
      transcribing: false,
      busy: false,
      blurCount: 0,
      remainingSeconds: 1800,
      transcriptReviewPending: false,
      transcriptBufferRemaining: 0,
      onToggleRecording: () => {},
      onTranscript: () => {},
      onRestoreOriginalTranscript: () => {},
      onComplete: async () => {},
      onSubmit: async () => {},
    }),
  )
  assert.match(examHtml, /src="http:\/\/127\.0\.0\.1:5000\/uploads\/questions\/202611\/diagram\.png"/)

  const indexHtml = read('index.html')
  assert.match(indexHtml, /img-src[^;]*http:\/\/127\.0\.0\.1:5000/)
  assert.match(indexHtml, /img-src[^;]*http:\/\/localhost:5000/)
})

test('M4: Electron shell uses --watch 15000, safeStorage + deviceFingerprint, and agent disconnect signal', async () => {
  const watchSource = read('electron/windows-agent.ts')
  const deviceSource = read('electron/device.ts')
  const mainSource = read('electron/main.ts')
  const monitorSource = read('src/hooks/useAntiCheatMonitor.ts')

  assert.match(watchSource, /--watch/)
  assert.match(watchSource, /15_000/)
  assert.match(watchSource, /parseWindowsAgentProbeLine/)
  assert.match(watchSource, /computeWatchRestartBackoffMs/)
  assert.match(deviceSource, /safeStorage/)
  assert.match(deviceSource, /kiosk-device-id\.dat/)
  assert.match(mainSource, /startWindowsAgentWatch/)
  assert.match(mainSource, /stopWindowsAgentWatch/)
  assert.match(mainSource, /before-quit/)
  assert.match(mainSource, /will-quit/)
  assert.match(monitorSource, /WINDOWS_AGENT_DISCONNECTED/)
  assert.match(monitorSource, /DEVICE_DISCONNECTION/)

  // Execute built dist-electron/main.cjs handlers and compiled electron/device.ts + electron/windows-agent.ts
  const tmpBase = path.join(root, 'node_modules', '.tmp')
  mkdirSync(tmpBase, { recursive: true })
  const tempUserData = mkdtempSync(path.join(tmpBase, 'oes-kiosk-device-'))
  const Module = require('node:module')
  const originalLoad = Module._load
  const ipcHandlers = new Map()
  const appListeners = new Map()
  const fakeWindow = {
    isDestroyed: () => false,
    isFullScreen: () => true,
    webContents: {
      send: () => {},
      setWindowOpenHandler: () => {},
      on: () => {},
    },
    once: () => {},
    on: () => {},
    loadURL: async () => {},
    loadFile: async () => {},
  }

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron/main') {
      return {
        app: {
          isPackaged: false,
          getVersion: () => '0.1.1',
          getPath: () => tempUserData,
          quit: () => {},
          whenReady: () => new Promise(() => {}),
          on: (evt, fn) => {
            appListeners.set(evt, fn)
          },
        },
        BrowserWindow: Object.assign(function FakeBrowserWindow() {
          return fakeWindow
        }, { getAllWindows: () => [fakeWindow] }),
        ipcMain: {
          handle: (channel, fn) => {
            ipcHandlers.set(channel, fn)
          },
        },
        Menu: { setApplicationMenu: () => {} },
        net: { fetch: async () => new Response(null, { status: 200 }) },
        safeStorage: {
          isEncryptionAvailable: () => true,
          encryptString: (str) => Buffer.from(`dpapi:${str}`, 'utf8'),
          decryptString: (buf) => {
            const text = buf.toString('utf8')
            if (!text.startsWith('dpapi:')) throw new Error('Invalid cipher')
            return text.slice('dpapi:'.length)
          },
        },
        screen: {
          getAllDisplays: () => [{ id: 1 }],
          on: () => {},
          removeListener: () => {},
        },
        session: {
          defaultSession: {
            webRequest: { onBeforeSendHeaders: () => {}, onHeadersReceived: () => {} },
            setPermissionRequestHandler: () => {},
          },
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }

  try {
    const mainBundlePath = path.join(root, 'dist-electron', 'main.cjs')
    if (existsSync(mainBundlePath)) {
      delete require.cache[mainBundlePath]
      require(mainBundlePath)
      assert.ok(appListeners.has('before-quit'))
      assert.ok(appListeners.has('will-quit'))
    }

    const deviceMod = require(path.join(root, 'node_modules', '.tmp', 'test-dist-electron', 'device.js'))
    const agentMod = require(path.join(root, 'node_modules', '.tmp', 'test-dist-electron', 'windows-agent.js'))

    // 1) Test NDJSON line parsing & bounded restart backoff
    const validLine = JSON.stringify({
      deviceFingerprint: 'oes-win-abcdef1234567890abcdef1234567890',
      displayCount: 1,
      vmDetected: false,
      vmIndicators: [],
      remoteControlDetected: false,
      remoteControlProcesses: [],
      disallowedProcesses: [],
      probedAtUtc: '2026-11-27T08:00:00Z',
    })
    assert.equal(agentMod.parseWindowsAgentProbeLine(validLine)?.displayCount, 1)
    assert.equal(agentMod.parseWindowsAgentProbeLine('{bad-json'), null)
    assert.equal(agentMod.computeWatchRestartBackoffMs(0), 1000)
    assert.equal(agentMod.computeWatchRestartBackoffMs(2), 4000)
    assert.equal(agentMod.computeWatchRestartBackoffMs(10), 30000)

    // 2) Test safeStorage encrypted binding with agentFingerprint & legacy migration
    const encryptedAdapter = {
      userDataDir: tempUserData,
      platform: 'win32',
      isEncryptionAvailable: () => true,
      encryptString: (str) => Buffer.from(`dpapi:${str}`, 'utf8'),
      decryptString: (buf) => buf.toString('utf8').replace(/^dpapi:/, ''),
    }

    // Legacy txt gets migrated to encrypted .dat when no agentFingerprint is given
    writeFileSync(path.join(tempUserData, 'kiosk-device-id.txt'), 'oes-win-legacy1234567890abcd', 'utf8')
    const migratedId = deviceMod.resolveDeviceIdWithAdapter(encryptedAdapter, null)
    assert.equal(migratedId, 'oes-win-legacy1234567890abcd')
    assert.equal(existsSync(path.join(tempUserData, 'kiosk-device-id.dat')), true)
    assert.equal(existsSync(path.join(tempUserData, 'kiosk-device-id.txt')), false)

    // Hardware agentFingerprint overrides and persists encrypted
    const hwFingerprint = 'oes-win-99887766554433221100aabbccddeeff'
    const boundId = deviceMod.resolveDeviceIdWithAdapter(encryptedAdapter, hwFingerprint)
    assert.equal(boundId, hwFingerprint)
    assert.match(boundId, /^[A-Za-z0-9._:-]{16,128}$/)
    assert.equal(
      readFileSync(path.join(tempUserData, 'kiosk-device-id.dat'), 'utf8'),
      `dpapi:${hwFingerprint}`,
    )

    // Fallback when safeStorage is unavailable
    const fallbackDir = path.join(tempUserData, 'fallback')
    const fallbackId = deviceMod.resolveDeviceIdWithAdapter(
      {
        userDataDir: fallbackDir,
        platform: 'linux',
        isEncryptionAvailable: () => false,
        encryptString: () => Buffer.alloc(0),
        decryptString: () => '',
      },
      null,
    )
    assert.match(fallbackId, /^[A-Za-z0-9._:-]{16,128}$/)
    assert.equal(readFileSync(path.join(fallbackDir, 'kiosk-device-id.txt'), 'utf8'), fallbackId)
  } finally {
    Module._load = originalLoad
    rmSync(tempUserData, { recursive: true, force: true })
  }
})

test('M4: Oes.WindowsAgent reads MachineGuid in EnvironmentProbeService.cs and --probe succeeds', () => {
  const probeCs = read('native/Oes.WindowsAgent/Services/EnvironmentProbeService.cs')
  assert.match(probeCs, /SOFTWARE\\\\Microsoft\\\\Cryptography|SOFTWARE\\Microsoft\\Cryptography/)
  assert.match(probeCs, /MachineGuid/)

  const exeCandidates = [
    path.join(root, 'native', 'dist', 'Oes.WindowsAgent', 'Oes.WindowsAgent.exe'),
    path.join(root, 'native', 'Oes.WindowsAgent', 'bin', 'Release', 'net8.0', 'Oes.WindowsAgent.exe'),
  ]
  const existingExe = exeCandidates.find((candidate) => existsSync(candidate))
  if (existingExe) {
    const probeRun = spawnSync(existingExe, ['--probe'], { encoding: 'utf8', windowsHide: true })
    assert.equal(probeRun.status, 0, `Oes.WindowsAgent --probe exited with ${probeRun.status}: ${probeRun.stderr}`)
    const parsed = JSON.parse(probeRun.stdout.trim())
    assert.match(parsed.deviceFingerprint, /^[A-Za-z0-9._:-]{16,128}$/)
    assert.equal(typeof parsed.displayCount, 'number')
  }
})

for (const failStatus of [403, 409]) {
  test(`M4 Iter2: staggered 401 when onSessionRevoked calls client.clearSession() fires once with ${failStatus} and resets on login()`, async () => {
    const originalFetch = globalThis.fetch
    const revokedEvents = []
    let releaseHeartbeat
    const heartbeatGate = new Promise((resolve) => {
      releaseHeartbeat = resolve
    })
    let phase = 'first-session'
    let ticketAttempt = 0
    let refreshAttempt = 0

    globalThis.fetch = async (url, init = {}) => {
      const urlStr = String(url)
      if (urlStr.endsWith('/auth/kiosk/password-login')) {
        const suffix = phase === 'first-session' ? '1' : '2'
        return jsonResponse({
          accessToken: `acc-${suffix}`,
          refreshToken: `ref-${suffix}`,
          tokenType: 'Bearer',
          expiresIn: 900,
          mustChangePassword: false,
          user: { id: 'u1', email: 'sv@fpt.edu.vn', fullName: 'SV', role: 'student' },
        })
      }
      if (urlStr.endsWith('/official-exams/tickets/current')) {
        ticketAttempt += 1
        if (phase === 'first-session') {
          return jsonResponse({ status: 401, detail: 'Expired 1' }, 401)
        }
        if (init.headers?.Authorization === 'Bearer acc-2') {
          return jsonResponse({ status: 401, detail: 'Expired 2' }, 401)
        }
        assert.equal(init.headers?.Authorization, 'Bearer acc-3')
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
          seatNumber: 1,
          status: 'IN_PROGRESS',
          examSetId: 'set1',
          examSetCode: 'DE01',
          examInputMode: 'VoiceOnly',
          transcriptBufferSeconds: 60,
          hasFollowUp: false,
          maxFollowUpQuestions: 0,
          serverNowUtc: '2026-11-27T08:05:00Z',
          questions: [],
        })
      }
      if (urlStr.endsWith('/auth/kiosk/refresh-token')) {
        refreshAttempt += 1
        if (phase === 'first-session') {
          setTimeout(() => releaseHeartbeat(), 20)
          return jsonResponse(
            {
              status: failStatus,
              detail: failStatus === 403 ? 'Locked' : 'Refresh conflict',
              errorCode: failStatus === 403 ? 'ACCOUNT_LOCKED' : 'REFRESH_TOKEN_CONFLICT',
            },
            failStatus,
          )
        }
        return jsonResponse({
          accessToken: 'acc-3',
          refreshToken: 'ref-3',
          tokenType: 'Bearer',
          expiresIn: 900,
        })
      }
      if (urlStr.endsWith('/tickets/t1/heartbeat')) {
        assert.equal(init.headers?.Authorization, 'Bearer acc-1')
        await heartbeatGate
        return jsonResponse({ status: 401, detail: 'Staggered 401' }, 401)
      }
      throw new Error(`Unexpected URL: ${urlStr}`)
    }

    try {
      let client
      client = new ApiClient({
        baseUrl: 'http://127.0.0.1:5000/api/v1',
        deviceId: 'oes-win-1234567890abcdef',
        kioskVersion: 'desktop-kiosk-0.1.1',
        onSessionRevoked: (event) => {
          revokedEvents.push(event)
          // Exact App.tsx handleSessionRevoked behavior: clears session inside callback.
          client.clearSession()
        },
      })

      await client.login('sv001', 'Password123!')
      await Promise.allSettled([client.getCurrentTicket(), client.sendHeartbeat('t1')])

      assert.equal(revokedEvents.length, 1, 'onSessionRevoked must fire only once even when clearSession() is called')
      assert.equal(revokedEvents[0].status, failStatus)
      assert.equal(
        revokedEvents[0].reason,
        failStatus === 403 ? 'ACCOUNT_LOCKED' : 'REFRESH_CONFLICT',
      )

      // Fresh login resets sessionRevoked so subsequent 401 refreshes normally.
      phase = 'second-session'
      await client.login('sv001', 'Password123!')
      const recoveredTicket = await client.getCurrentTicket()
      assert.equal(recoveredTicket.id, 't1')
      assert.equal(refreshAttempt, 2)
      assert.equal(ticketAttempt, 3)
      assert.equal(revokedEvents.length, 1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
}

test('M4 Iter2: flushPendingAntiCheatLogsQueue drops permanent 413/415/410 4xx and drains valid logs while preserving 401/408/429/5xx/network', async () => {
  const originalIndexedDb = globalThis.indexedDB
  globalThis.indexedDB = createFakeIndexedDb()

  const mkReq = (id) => ({
    ticketId: 't-ac-4xx',
    shiftId: 's1',
    studentId: 'u1',
    clientEventId: id,
    eventType: 'WINDOW_BLUR',
    severity: 'HIGH',
    details: id,
  })

  try {
    // Part A: 413, 415, 410 are deleted; valid log succeeds; 429 stops and preserves remaining
    for (const id of ['evt-413', 'evt-415', 'evt-410', 'evt-good', 'evt-429', 'evt-after-429']) {
      await savePendingAntiCheatLog(mkReq(id))
    }

    const attempted = []
    const flushedA = await flushPendingAntiCheatLogsQueue({
      apiClient: {
        async logAntiCheat(req) {
          attempted.push(req.clientEventId)
          if (req.clientEventId === 'evt-413') throw new ApiProblemError({ status: 413, detail: 'Too Large' }, 413)
          if (req.clientEventId === 'evt-415') throw new ApiProblemError({ status: 415, detail: 'Unsupported Media' }, 415)
          if (req.clientEventId === 'evt-410') throw new ApiProblemError({ status: 410, detail: 'Gone' }, 410)
          if (req.clientEventId === 'evt-429') throw new ApiProblemError({ status: 429, detail: 'Rate Limit' }, 429)
        },
      },
      ticketId: 't-ac-4xx',
    })

    assert.equal(flushedA, 1)
    assert.deepEqual(attempted, ['evt-413', 'evt-415', 'evt-410', 'evt-good', 'evt-429'])
    assert.deepEqual(
      (await loadPendingAntiCheatLogs('t-ac-4xx')).map((item) => item.clientEventId),
      ['evt-429', 'evt-after-429'],
    )

    // Part B: 401, 408, 503, and network errors preserve the queue item and stop draining
    for (const failure of [
      { id: 'evt-401', err: new ApiProblemError({ status: 401, detail: 'Unauthorized' }, 401) },
      { id: 'evt-408', err: new ApiProblemError({ status: 408, detail: 'Request Timeout' }, 408) },
      { id: 'evt-503', err: new ApiProblemError({ status: 503, detail: 'Unavailable' }, 503) },
      { id: 'evt-net', err: new TypeError('fetch failed') },
    ]) {
      const ticketKey = `t-${failure.id}`
      await savePendingAntiCheatLog({ ...mkReq(failure.id), ticketId: ticketKey })
      await savePendingAntiCheatLog({ ...mkReq(`${failure.id}-next`), ticketId: ticketKey })
      const flushed = await flushPendingAntiCheatLogsQueue({
        apiClient: {
          async logAntiCheat() {
            throw failure.err
          },
        },
        ticketId: ticketKey,
      })
      assert.equal(flushed, 0)
      assert.deepEqual(
        (await loadPendingAntiCheatLogs(ticketKey)).map((item) => item.clientEventId),
        [failure.id, `${failure.id}-next`],
      )
    }
  } finally {
    globalThis.indexedDB = originalIndexedDb
  }
})

test('M4 Iter2: resolveQuestionImageUrl rejects javascript: and vbscript: schemes', () => {
  assert.equal(resolveQuestionImageUrl('javascript:alert(1)', 'https://oralexam.io.vn/api/v1'), null)
  assert.equal(resolveQuestionImageUrl('  JaVaScRiPt:alert(1)', 'https://oralexam.io.vn/api/v1'), null)
  assert.equal(resolveQuestionImageUrl('java\tscript:alert(1)', 'https://oralexam.io.vn/api/v1'), null)
  assert.equal(resolveQuestionImageUrl('vbscript:msgbox(1)', 'https://oralexam.io.vn/api/v1'), null)
  assert.equal(
    resolveQuestionImageUrl('/uploads/questions/q1.png', 'https://oralexam.io.vn/api/v1'),
    'https://oralexam.io.vn/uploads/questions/q1.png',
  )
})

test('M4 Iter2: heartbeat onTerminate / submitExam(true) awaits in-flight completeQuestion mid-STT with 1 upload, 1 answer, and no busy flicker', async () => {
  const { createRoot } = require('react-dom/client')
  const { act } = require('react')
  const App = require('../node_modules/.tmp/test-dist/App.js').default

  function createFakeDom() {
    class FakeNode {
      constructor(nodeType, nodeName) {
        this.nodeType = nodeType
        this.nodeName = nodeName
        this.parentNode = null
        this.childNodes = []
        this.ownerDocument = null
        this.listeners = new Map()
      }
      get firstChild() {
        return this.childNodes[0] ?? null
      }
      get lastChild() {
        return this.childNodes[this.childNodes.length - 1] ?? null
      }
      get nextSibling() {
        if (!this.parentNode) return null
        const idx = this.parentNode.childNodes.indexOf(this)
        return idx >= 0 ? (this.parentNode.childNodes[idx + 1] ?? null) : null
      }
      get previousSibling() {
        if (!this.parentNode) return null
        const idx = this.parentNode.childNodes.indexOf(this)
        return idx > 0 ? (this.parentNode.childNodes[idx - 1] ?? null) : null
      }
      appendChild(child) {
        return this.insertBefore(child, null)
      }
      insertBefore(child, refChild) {
        if (child.nodeType === 11) {
          const moved = [...child.childNodes]
          for (const item of moved) this.insertBefore(item, refChild)
          return child
        }
        if (child.parentNode) child.parentNode.removeChild(child)
        child.parentNode = this
        child.ownerDocument = this.nodeType === 9 ? this : this.ownerDocument
        if (!refChild) {
          this.childNodes.push(child)
        } else {
          const idx = this.childNodes.indexOf(refChild)
          if (idx >= 0) this.childNodes.splice(idx, 0, child)
          else this.childNodes.push(child)
        }
        return child
      }
      removeChild(child) {
        const idx = this.childNodes.indexOf(child)
        if (idx >= 0) {
          this.childNodes.splice(idx, 1)
          child.parentNode = null
        }
        return child
      }
      addEventListener(type, fn) {
        const set = this.listeners.get(type) ?? new Set()
        set.add(fn)
        this.listeners.set(type, set)
      }
      removeEventListener(type, fn) {
        this.listeners.get(type)?.delete(fn)
      }
      dispatchEvent(event) {
        event.target ??= this
        event.preventDefault ??= () => {}
        event.stopPropagation ??= () => {}
        let current = this
        while (current) {
          event.currentTarget = current
          const set = current.listeners.get(event.type)
          if (set) {
            for (const fn of Array.from(set)) fn(event)
          }
          current = current.parentNode
        }
        return true
      }
    }

    class FakeText extends FakeNode {
      constructor(text) {
        super(3, '#text')
        this._text = String(text)
      }
      get nodeValue() {
        return this._text
      }
      set nodeValue(val) {
        this._text = String(val)
      }
      get textContent() {
        return this._text
      }
      set textContent(val) {
        this._text = String(val)
      }
    }

    class FakeComment extends FakeNode {
      constructor(text) {
        super(8, '#comment')
        this._text = String(text)
      }
      get nodeValue() {
        return this._text
      }
      set nodeValue(val) {
        this._text = String(val)
      }
    }

    class FakeElement extends FakeNode {
      constructor(tagName) {
        super(1, tagName.toUpperCase())
        this.tagName = tagName.toUpperCase()
        this.attrs = new Map()
        this.style = {}
        this._value = ''
        this.disabled = false
        this.type = ''
        this.id = ''
        this.className = ''
        this.isContentEditable = false
      }
      get value() {
        return this._value
      }
      set value(val) {
        this._value = String(val ?? '')
      }
      get textContent() {
        return this.childNodes.map((c) => c.textContent ?? '').join('')
      }
      set textContent(val) {
        for (const c of [...this.childNodes]) this.removeChild(c)
        if (val !== '' && val !== null && val !== undefined) {
          this.appendChild(this.ownerDocument.createTextNode(String(val)))
        }
      }
      setAttribute(name, val) {
        const str = String(val)
        this.attrs.set(name, str)
        if (name === 'id') this.id = str
        if (name === 'class') this.className = str
        if (name === 'type') this.type = str
        if (name === 'disabled') this.disabled = true
      }
      getAttribute(name) {
        return this.attrs.get(name) ?? null
      }
      removeAttribute(name) {
        this.attrs.delete(name)
        if (name === 'disabled') this.disabled = false
      }
      hasAttribute(name) {
        return this.attrs.has(name)
      }
      focus() {}
      blur() {}
    }

    const doc = new FakeNode(9, '#document')
    doc.visibilityState = 'visible'
    doc.activeElement = null
    doc.createElement = (tag) => {
      const el = new FakeElement(tag)
      el.ownerDocument = doc
      return el
    }
    doc.createElementNS = (_ns, tag) => doc.createElement(tag)
    doc.createTextNode = (text) => {
      const node = new FakeText(text)
      node.ownerDocument = doc
      return node
    }
    doc.createComment = (text) => {
      const node = new FakeComment(text)
      node.ownerDocument = doc
      return node
    }
    doc.createDocumentFragment = () => {
      const frag = new FakeNode(11, '#document-fragment')
      frag.ownerDocument = doc
      return frag
    }
    doc.documentElement = doc.createElement('html')
    doc.head = doc.createElement('head')
    doc.body = doc.createElement('body')
    doc.appendChild(doc.documentElement)
    doc.documentElement.appendChild(doc.head)
    doc.documentElement.appendChild(doc.body)
    return { doc, FakeElement }
  }

  function findAll(rootNode, predicate, out = []) {
    if (predicate(rootNode)) out.push(rootNode)
    for (const child of rootNode.childNodes ?? []) findAll(child, predicate, out)
    return out
  }

  function findButton(rootNode, labelSubstring) {
    return findAll(
      rootNode,
      (node) => node.tagName === 'BUTTON' && node.textContent.includes(labelSubstring),
    )[0]
  }

  function findById(rootNode, id) {
    return findAll(rootNode, (node) => node.id === id)[0]
  }

  function setInputValue(el, value) {
    const reactPropsKey = Object.keys(el).find((k) => k.startsWith('__reactProps$'))
    el.value = value
    if (reactPropsKey && el[reactPropsKey]?.onChange) {
      el[reactPropsKey].onChange({ target: el, currentTarget: el })
    }
  }

  function clickEl(el) {
    const reactPropsKey = Object.keys(el).find((k) => k.startsWith('__reactProps$'))
    if (reactPropsKey && el[reactPropsKey]?.onClick) {
      el[reactPropsKey].onClick({ preventDefault: () => {}, target: el, currentTarget: el })
      return
    }
    el.dispatchEvent({ type: 'click', bubbles: true, cancelable: true })
  }

  function submitForm(formEl) {
    const reactPropsKey = Object.keys(formEl).find((k) => k.startsWith('__reactProps$'))
    if (reactPropsKey && formEl[reactPropsKey]?.onSubmit) {
      return formEl[reactPropsKey].onSubmit({ preventDefault: () => {}, target: formEl, currentTarget: formEl })
    }
    formEl.dispatchEvent({ type: 'submit', bubbles: true, cancelable: true })
    return undefined
  }

  const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const originals = {
    document: globalThis.document,
    window: globalThis.window,
    indexedDB: globalThis.indexedDB,
    fetch: globalThis.fetch,
    MediaRecorder: globalThis.MediaRecorder,
    AudioContext: globalThis.AudioContext,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }

  const { doc, FakeElement } = createFakeDom()
  const windowListeners = new Map()
  let rafId = 0
  let fakePerfNow = 1000
  const origPerfNow = performance.now.bind(performance)
  performance.now = () => fakePerfNow

  const fakeWindow = {
    document: doc,
    HTMLElement: FakeElement,
    HTMLInputElement: FakeElement,
    HTMLTextAreaElement: FakeElement,
    HTMLIFrameElement: class FakeHTMLIFrameElement {},
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener: (type, fn) => {
      const set = windowListeners.get(type) ?? new Set()
      set.add(fn)
      windowListeners.set(type, set)
    },
    removeEventListener: (type, fn) => windowListeners.get(type)?.delete(fn),
    kioskApi: {
      getRuntimeInfo: async () => ({
        appName: 'Oral Exam Desktop Kiosk',
        appVersion: '0.1.1',
        isPackaged: false,
        isKioskMode: true,
        altTabTestMode: false,
        platform: 'win32',
        apiBaseUrl: 'http://127.0.0.1:5000/api/v1',
        deviceId: 'oes-win-1234567890abcdef',
        kioskVersion: 'desktop-kiosk-0.1.1',
        displayCount: 1,
        isFullscreen: true,
        windowsAgentAvailable: true,
      }),
      getSecuritySnapshot: async () => ({
        deviceId: 'oes-win-1234567890abcdef',
        displayCount: 1,
        isFullscreen: true,
        windowsAgent: {
          deviceFingerprint: 'oes-win-1234567890abcdef',
          displayCount: 1,
          vmDetected: false,
          vmIndicators: [],
          remoteControlDetected: false,
          remoteControlProcesses: [],
          disallowedProcesses: [],
          probedAtUtc: '2026-11-27T08:00:00Z',
        },
      }),
      authorizeExitAfterSubmit: async () => true,
      requestExit: async () => true,
      onSecurityEvent: () => () => {},
    },
  }
  doc.defaultView = fakeWindow

  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.document = doc
  globalThis.window = fakeWindow
  globalThis.HTMLInputElement = FakeElement
  globalThis.HTMLTextAreaElement = FakeElement
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop: () => {}, onended: null }],
          getAudioTracks: () => [{ stop: () => {}, onended: null }],
        }),
      },
    },
  })
  globalThis.indexedDB = createFakeIndexedDb()
  const rafTimers = new Map()
  globalThis.requestAnimationFrame = (cb) => {
    rafId += 1
    const id = rafId
    const timer = setTimeout(() => {
      rafTimers.delete(id)
      fakePerfNow += 31_000
      cb(fakePerfNow)
    }, 1)
    rafTimers.set(id, timer)
    return id
  }
  globalThis.cancelAnimationFrame = (id) => {
    const timer = rafTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      rafTimers.delete(id)
    }
  }
  globalThis.AudioContext = class FakeAudioContext {
    createAnalyser() {
      return {
        fftSize: 2048,
        getByteTimeDomainData(arr) {
          arr.fill(160)
        },
      }
    }
    createMediaStreamSource() {
      return { connect() {} }
    }
    close() {
      return Promise.resolve()
    }
  }
  globalThis.MediaRecorder = class FakeMediaRecorder {
    constructor() {
      this.state = 'inactive'
      this.ondataavailable = null
      this.onstop = null
    }
    start() {
      this.state = 'recording'
    }
    stop() {
      this.state = 'inactive'
      this.ondataavailable?.({ data: new Blob(['real-webm-audio-data'], { type: 'audio/webm' }) })
      this.onstop?.()
    }
  }

  let authCalls = 0
  let putCalls = 0
  let answerCalls = 0
  let submitExamCalls = 0
  let followUpCalls = 0
  const submittedAnswers = []
  let resolveStt
  const sttStarted = new Promise((resolve) => {
    resolveStt = { notifyStarted: resolve, release: null }
  })
  const sttResponseGate = new Promise((resolve) => {
    resolveStt.release = resolve
  })
  let sendTimeUpHeartbeat = false
  let heartbeatResolver = null

  const nowIso = new Date().toISOString()
  const endIso = new Date(Date.now() + 600_000).toISOString()

  globalThis.fetch = async (url, init = {}) => {
    const urlStr = String(url)
    if (urlStr.endsWith('/auth/kiosk/password-login')) {
      return jsonResponse({
        accessToken: 'acc-1',
        refreshToken: 'ref-1',
        tokenType: 'Bearer',
        expiresIn: 900,
        mustChangePassword: false,
        user: { id: 'u1', email: 'sv@fpt.edu.vn', fullName: 'SV Test', role: 'student' },
      })
    }
    if (urlStr.endsWith('/official-exams/tickets/current')) {
      return jsonResponse({
        id: 't-race',
        shiftId: 's1',
        shiftName: 'Ca 1',
        roomLab: 'P201',
        startTime: nowIso,
        endTime: endIso,
        shiftStatus: 'in_progress',
        sessionTitle: 'Thi cuoi ky',
        studentId: 'u1',
        seatNumber: 5,
        status: 'IN_PROGRESS',
        examSetId: 'set1',
        examSetCode: 'DE01',
        examInputMode: 'VoiceWithTranscriptEdit',
        transcriptBufferSeconds: 60,
        hasFollowUp: true,
        maxFollowUpQuestions: 2,
        serverNowUtc: nowIso,
        questions: [
          {
            questionId: 'q1',
            orderIndex: 1,
            title: 'DIP',
            content: 'Explain DIP',
            bloomLevel: 'Understand',
            difficulty: 'medium',
            imageUrl: null,
            imageDescription: null,
          },
        ],
      })
    }
    if (urlStr.endsWith('/official-exams/tickets/t-race/check-in')) {
      return jsonResponse({
        id: 't-race',
        shiftId: 's1',
        studentId: 'u1',
        seatNumber: 5,
        ipAddress: '127.0.0.1',
        status: 'IN_PROGRESS',
        checkedInAt: nowIso,
        examSetId: 'set1',
        activeSessionToken: 'kiosk-sess-1',
      })
    }
    if (urlStr.endsWith('/official-exams/tickets/t-race')) {
      return jsonResponse({
        ticketId: 't-race',
        shiftId: 's1',
        status: 'IN_PROGRESS',
        isExamPublished: true,
        isKioskLocked: false,
        violationCount: 0,
        maxViolations: 3,
        lockThreshold: 4,
        remainingStrikes: 4,
        serverNowUtc: nowIso,
        deviceId: 'oes-win-1234567890abcdef',
        deviceLockedAt: nowIso,
        deviceUnlockCount: 0,
        followUps: [],
      })
    }
    if (urlStr.endsWith('/official-exams/tickets/t-race/heartbeat')) {
      if (!sendTimeUpHeartbeat) {
        return new Promise((resolve) => {
          heartbeatResolver = () =>
            resolve(
              jsonResponse({
                ticketId: 't-race',
                shiftId: 's1',
                ticketStatus: 'IN_PROGRESS',
                shiftStatus: 'in_progress',
                serverUtcNow: nowIso,
                remainingShiftSeconds: 0,
                isLocked: false,
                deviceUnlockRequired: false,
                shouldTerminateExam: true,
                notice: null,
              }),
            )
        })
      }
      return jsonResponse({
        ticketId: 't-race',
        shiftId: 's1',
        ticketStatus: 'IN_PROGRESS',
        shiftStatus: 'in_progress',
        serverUtcNow: nowIso,
        remainingShiftSeconds: 0,
        isLocked: false,
        deviceUnlockRequired: false,
        shouldTerminateExam: true,
        notice: null,
      })
    }
    if (urlStr.endsWith('/speech/stt')) {
      resolveStt.notifyStarted()
      await sttResponseGate
      return jsonResponse({ text: 'my real spoken answer', rawText: 'my real spoken answer', provider: 'whisper' })
    }
    if (urlStr.endsWith('/official-exams/tickets/t-race/questions/q1/audio-upload-authorizations')) {
      authCalls += 1
      return jsonResponse({
        objectKey: 'official/s1/t-race/q1_0.webm',
        fileName: '05_SE001_Q1.webm',
        uploadUrl: 'https://r2.example/t-race/q1',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        requiredHeaders: { 'Content-Type': 'audio/webm', 'If-None-Match': '*' },
      })
    }
    if (urlStr === 'https://r2.example/t-race/q1') {
      putCalls += 1
      return new Response(null, { status: 200 })
    }
    if (urlStr.endsWith('/official-exams/tickets/t-race/questions/q1/answers')) {
      answerCalls += 1
      const parsedBody = JSON.parse(init.body)
      submittedAnswers.push(parsedBody)
      return jsonResponse({
        submissionId: 'sub-race-1',
        ticketId: 't-race',
        examQuestionId: 'q1',
        followUpIndex: 0,
        audioObjectKey: parsedBody.audioObjectKey,
        audioHashSha256: parsedBody.audioHashSha256,
        status: 'RECORDED',
        canRequestFollowUp: true,
      })
    }
    if (urlStr.includes('/next-followup')) {
      followUpCalls += 1
      return jsonResponse({ hasMoreFollowUp: false, followUpIndex: 0, maxFollowUpQuestions: 2, parentSubmissionId: 'sub-race-1', questionId: 'q1', followUpPrompt: null })
    }
    if (urlStr.endsWith('/official-exams/tickets/t-race/submission')) {
      submitExamCalls += 1
      assert.deepEqual(JSON.parse(init.body), { answers: [], finalizePerTurn: true })
      return jsonResponse({
        ticketId: 't-race',
        status: 'SUBMITTED',
        submittedAt: nowIso,
        submissionCount: 1,
        isKioskLocked: true,
      })
    }
    throw new Error(`Unexpected fetch URL: ${urlStr}`)
  }

  const container = doc.createElement('div')
  doc.body.appendChild(container)
  const rootInstance = createRoot(container)

  try {
    await act(async () => {
      rootInstance.render(React.createElement(App))
    })

    // 1) Sign in
    await act(async () => {
      setInputValue(findById(container, 'username'), 'sv001')
      setInputValue(findById(container, 'password'), 'Password123!')
    })
    await act(async () => {
      const form = findAll(container, (n) => n.tagName === 'FORM')[0]
      await submitForm(form)
    })

    // 2) Pre-check: run 30s mic test (fast-forwarded via rAF) and check in
    await act(async () => {
      clickEl(findButton(container, 'Bắt đầu kiểm tra'))
      await new Promise((r) => setTimeout(r, 20))
    })
    await act(async () => {
      clickEl(findButton(container, 'Điểm danh và vào phòng chờ'))
      await new Promise((r) => setTimeout(r, 20))
    })

    // 3) Lobby -> Start exam
    await act(async () => {
      clickEl(findButton(container, 'Bắt đầu làm bài'))
      await new Promise((r) => setTimeout(r, 20))
    })

    // 4) Start recording -> stop recording (enters completeQuestion -> stalls mid-/speech/stt)
    await act(async () => {
      clickEl(findButton(container, 'Ghi âm'))
    })
    await act(async () => {
      clickEl(findAll(container, (n) => n.tagName === 'BUTTON' && n.getAttribute('aria-label') === 'Dừng ghi âm')[0])
      await sttStarted
    })

    // 5) Fire heartbeat onTerminate while completeQuestion is mid-STT, and monitor busy button state
    const busyStatesAfterTerminate = []
    const observeBusy = () => {
      const micBtn = findAll(
        container,
        (n) => n.tagName === 'BUTTON' && (n.className || '').includes('practice-mic-orb'),
      )[0]
      if (micBtn) busyStatesAfterTerminate.push(micBtn.disabled)
    }

    await act(async () => {
      sendTimeUpHeartbeat = true
      heartbeatResolver?.()
      await new Promise((r) => setTimeout(r, 15))
      observeBusy()
    })

    // Release STT and verify submitExam finishes cleanly without premature setBusy(false)
    await act(async () => {
      resolveStt.release()
      for (let i = 0; i < 8; i += 1) {
        await new Promise((r) => setTimeout(r, 15))
        observeBusy()
        if (container.textContent.includes('Bài làm đã được lưu an toàn')) break
      }
    })

    assert.match(container.textContent, /Bài làm đã được lưu an toàn/)
    assert.equal(authCalls, 1, 'Expected exactly 1 audio-upload-authorizations call')
    assert.equal(putCalls, 1, 'Expected exactly 1 R2 PUT call')
    assert.equal(answerCalls, 1, 'Expected exactly 1 submitQuestionAnswer call')
    assert.equal(followUpCalls, 0, 'Must not request follow-up when submitExam took over')
    assert.equal(submitExamCalls, 1, 'Expected exactly 1 submitExam call')
    assert.equal(submittedAnswers[0].initialVoiceTranscript, 'my real spoken answer')
    assert.equal(submittedAnswers[0].transcriptWhisper, 'my real spoken answer')
    assert.ok(
      busyStatesAfterTerminate.every((disabled) => disabled === true),
      `Mic/exam button must stay disabled throughout submission, saw: ${JSON.stringify(busyStatesAfterTerminate)}`,
    )
  } finally {
    for (const timer of rafTimers.values()) clearTimeout(timer)
    rafTimers.clear()
    await act(async () => {
      rootInstance.unmount()
    })
    performance.now = origPerfNow
    globalThis.document = originals.document
    globalThis.window = originals.window
    if (origNavDesc) Object.defineProperty(globalThis, 'navigator', origNavDesc)
    globalThis.indexedDB = originals.indexedDB
    globalThis.fetch = originals.fetch
    globalThis.MediaRecorder = originals.MediaRecorder
    globalThis.AudioContext = originals.AudioContext
    globalThis.requestAnimationFrame = originals.requestAnimationFrame
    globalThis.cancelAnimationFrame = originals.cancelAnimationFrame
    globalThis.IS_REACT_ACT_ENVIRONMENT = originals.IS_REACT_ACT_ENVIRONMENT
    delete globalThis.HTMLInputElement
    delete globalThis.HTMLTextAreaElement
  }
})

test('M4: electron/security.ts blocks new shortcuts, emits TAB_SWITCH only on non-repeat keyDown, and watches multi-monitor', () => {
  const Module = require('node:module')
  const originalLoad = Module._load
  const securityPath = path.join(root, 'node_modules', '.tmp', 'test-dist-electron', 'security.js')
  const configPath = path.join(root, 'node_modules', '.tmp', 'test-dist-electron', 'config.js')

  let mockDisplays = [{ id: 1 }]
  const screenListeners = new Map()
  const webContentsListeners = new Map()
  const windowListeners = new Map()

  Module._load = function patchedLoad(request) {
    if (request === 'electron/main') {
      return {
        app: { isPackaged: true },
        screen: {
          getAllDisplays: () => mockDisplays,
          on: (evt, fn) => screenListeners.set(evt, fn),
          removeListener: (evt) => screenListeners.delete(evt),
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }

  try {
    delete require.cache[configPath]
    delete require.cache[securityPath]
    const securityMod = require(securityPath)
    const emitted = []
    const fakeWindow = {
      isDestroyed: () => false,
      isMinimized: () => false,
      isFullScreen: () => true,
      isKiosk: () => true,
      setFullScreen: () => {},
      setKiosk: () => {},
      setAlwaysOnTop: () => {},
      focus: () => {},
      on: (evt, fn) => windowListeners.set(evt, fn),
      webContents: {
        setWindowOpenHandler: () => {},
        on: (evt, fn) => webContentsListeners.set(evt, fn),
      },
    }

    securityMod.configureWindowSecurity(fakeWindow, path.join(root, 'electron'), (evt) => emitted.push(evt))
    const beforeInput = webContentsListeners.get('before-input-event')
    assert.ok(beforeInput)

    const sendKey = (overrides) => {
      let prevented = false
      beforeInput(
        { preventDefault: () => { prevented = true } },
        { type: 'keyDown', key: 'F5', code: 'F5', isAutoRepeat: false, control: false, alt: false, meta: false, shift: false, ...overrides },
      )
      return prevented
    }

    assert.equal(sendKey({ type: 'keyDown', key: 'F5', isAutoRepeat: false }), true)
    assert.equal(sendKey({ type: 'keyDown', key: 'F5', isAutoRepeat: true }), true)
    assert.equal(sendKey({ type: 'keyUp', key: 'F5', isAutoRepeat: false }), true)
    assert.equal(sendKey({ type: 'keyDown', key: 'F4', control: true }), true)
    assert.equal(sendKey({ type: 'keyDown', key: 'p', control: true }), true)
    assert.equal(sendKey({ type: 'keyDown', key: 's', control: true }), true)
    assert.equal(sendKey({ type: 'keyDown', key: 'u', control: true }), true)
    assert.equal(sendKey({ type: 'keyDown', key: 'BrowserBack' }), true)
    assert.equal(sendKey({ type: 'keyDown', key: 'BrowserForward' }), true)
    assert.equal(sendKey({ type: 'keyDown', key: 'BrowserRefresh' }), true)
    assert.equal(sendKey({ type: 'keyDown', key: 'a' }), false)

    // Only non-repeat keyDown emissions (F5, Ctrl+F4, Ctrl+P, Ctrl+S, Ctrl+U, BrowserBack, BrowserForward, BrowserRefresh = 8)
    assert.equal(emitted.length, 8)
    assert.ok(emitted.every((e) => e.eventType === 'TAB_SWITCH'))

    const stopWatch = securityMod.watchDisplayChanges((evt) => emitted.push(evt))
    mockDisplays = [{ id: 1 }, { id: 2 }]
    screenListeners.get('display-added')?.()
    assert.equal(emitted.filter((e) => e.eventType === 'MULTI_MONITOR').length, 1)
    stopWatch()
    assert.equal(screenListeners.size, 0)
  } finally {
    Module._load = originalLoad
  }
})

test('M4: PreCheckScreen relaxes windowsAgent requirement only in non-strict mode, LobbyScreen checks isExamPublished, WaitingTicketScreen & BlockedScreen polish', () => {
  // Non-strict (altTabTestMode: true) with windowsAgent: null -> Check-in stays enabled
  const testModeHtml = renderToStaticMarkup(
    React.createElement(PreCheckScreen, {
      microphoneReady: true,
      micTestSeconds: 30,
      micLevel: 72,
      displayCount: 1,
      isKioskMode: true,
      altTabTestMode: true,
      platform: 'win32',
      securitySnapshot: {
        deviceId: 'oes-win-1234567890abcdef',
        displayCount: 1,
        isFullscreen: true,
        windowsAgent: null,
      },
      scanningEnvironment: false,
      busy: false,
      onTest: async () => {},
      onRescanEnvironment: async () => {},
      onCheckIn: async () => {},
    }),
  )
  assert.doesNotMatch(testModeHtml, /disabled=""[^>]*>Điểm danh và vào phòng chờ/)

  // LobbyScreen with isExamPublished: false must wait even if questions exist and shiftStatus is in_progress
  const unpublishedHtml = renderToStaticMarkup(
    React.createElement(LobbyScreen, {
      ticket: makeTicket({ shiftStatus: 'in_progress', isExamPublished: false }),
      offlineDraftAvailable: false,
      hasCompleteDraft: false,
      onStart: async () => {},
      onResumeSubmit: async () => {},
      onRefreshTicket: async () => {},
    }),
  )
  assert.match(unpublishedHtml, /disabled=""[^>]*>Đang chờ mở ca &amp; phát đề…/)

  // WaitingTicketScreen renders sign-out escape hatch when onReturnToSignIn is provided
  const waitingHtml = renderToStaticMarkup(
    React.createElement(WaitingTicketScreen, {
      studentName: 'SV Test',
      busy: false,
      onRetry: async () => {},
      onReturnToSignIn: () => {},
    }),
  )
  assert.match(waitingHtml, /Quay về đăng nhập/)

  // BlockedScreen omits "0 lần mất tiêu điểm" when blurCount === 0
  const zeroBlurBlockedHtml = renderToStaticMarkup(
    React.createElement(BlockedScreen, {
      blurCount: 0,
      reason: 'ANTI_CHEAT',
      detailMessage: 'VM detected',
      checkingStatus: false,
      onCheckStatus: async () => {},
      onReturnToSignIn: () => {},
    }),
  )
  assert.doesNotMatch(zeroBlurBlockedHtml, /0 lần mất tiêu điểm/)
  assert.match(zeroBlurBlockedHtml, /Đình chỉ an ninh/)
})

test('M4: Oes.WindowsAgent detects SM_REMOTESESSION, SMBIOS VM registry, extra disallowed tools, and --parent-pid lifecycle', () => {
  const probeCs = read('native/Oes.WindowsAgent/Services/EnvironmentProbeService.cs')
  const programCs = read('native/Oes.WindowsAgent/Program.cs')
  assert.match(probeCs, /SmRemoteSession\s*=\s*0x1000/)
  assert.match(probeCs, /rdp-session/)
  assert.match(probeCs, /HARDWARE\\\\DESCRIPTION\\\\System\\\\BIOS|HARDWARE\\DESCRIPTION\\System\\BIOS/)
  for (const tool of ['claude', 'whatsapp', 'zoom', 'greenshot', 'lightshot', 'vncserver']) {
    assert.match(probeCs, new RegExp(`"${tool}"`))
  }
  assert.match(programCs, /--parent-pid/)
  assert.match(programCs, /GetProcessById/)
})

test('M4: executeTurnUploadAndSubmit forwards timestampsWhisper, concurrent saveTurnDraft shares 1 AES key, and flushPendingAntiCheatLogsQueue handles immediate lock & 409 TICKET_LOCKED', async () => {
  const originalIndexedDb = globalThis.indexedDB
  globalThis.indexedDB = createFakeIndexedDb()

  try {
    const ticket = makeTicket()
    const audio1 = new Blob(['audio-1'], { type: 'audio/webm' })
    const audio2 = new Blob(['audio-2'], { type: 'audio/webm' })

    // Concurrent saveTurnDraft on fresh DB must share one generated AES-GCM key so both decrypt cleanly
    const mkMeta = (questionId) => ({
      draftKey: buildTurnDraftKey(ticket.id, questionId, 0),
      ticketId: ticket.id,
      shiftId: ticket.shiftId,
      studentId: ticket.studentId,
      questionId,
      followUpIndex: 0,
      parentSubmissionId: null,
      followUpPrompt: null,
      initialVoiceTranscript: 't',
      transcriptWhisper: 't',
      timestampsWhisper: '{"words":[{"word":"t","start":0,"end":0.3}]}',
      timeSpentSeconds: 5,
      isManuallyEdited: false,
      objectKey: null,
      sha256: null,
      sha256Base64: null,
      uploadAuthorization: null,
      stage: 'RECORDED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    await Promise.all([
      saveTurnDraft({ metadata: mkMeta('q-concurrent-1'), audio: audio1 }),
      saveTurnDraft({ metadata: mkMeta('q-concurrent-2'), audio: audio2 }),
    ])
    const loadedDrafts = await loadTicketTurnDrafts(ticket.id)
    assert.equal(loadedDrafts.length, 2)
    await clearTicketDrafts(ticket.id)

    // executeTurnUploadAndSubmit forwards timestampsWhisper
    let submittedReq = null
    const mockApi = {
      async createQuestionAudioUploadAuthorization() {
        return {
          objectKey: 'official/s1/t1/q1_0.webm',
          fileName: 'q1.webm',
          uploadUrl: 'https://r2.example/put',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          requiredHeaders: { 'Content-Type': 'audio/webm', 'If-None-Match': '*' },
        }
      },
      async uploadAudio() {},
      async submitQuestionAnswer(_t, _q, req) {
        submittedReq = req
        return {
          submissionId: 'sub-ts',
          ticketId: ticket.id,
          questionId: 'q1',
          followUpIndex: 0,
          audioObjectKey: req.audioObjectKey,
          audioHashSha256: req.audioHashSha256,
          status: 'RECORDED',
          canRequestFollowUp: false,
        }
      },
    }
    await executeTurnUploadAndSubmit({
      apiClient: mockApi,
      ticket,
      questionId: 'q1',
      followUpIndex: 0,
      parentSubmissionId: null,
      followUpPrompt: null,
      audio: audio1,
      rawVoiceTranscript: 'hello',
      finalTranscript: 'hello',
      timestampsWhisper: '{"words":[{"word":"hello","start":0,"end":0.5}]}',
      isManuallyEdited: false,
      timeSpentSeconds: 10,
    })
    assert.equal(submittedReq.timestampsWhisper, '{"words":[{"word":"hello","start":0,"end":0.5}]}')

    // flushPendingAntiCheatLogsQueue triggers onTicketLocked on dto.isLocked === true & on 409 TICKET_LOCKED
    await savePendingAntiCheatLog({
      ticketId: 't-lock-1',
      shiftId: 's1',
      studentId: 'u1',
      clientEventId: 'evt-lock-dto',
      eventType: 'TAB_SWITCH',
      severity: 'HIGH',
      details: 'Locked by server',
    })
    let lockedFromDto = null
    let syncedBlur = null
    await flushPendingAntiCheatLogsQueue({
      apiClient: {
        async logAntiCheat() {
          return {
            id: 'ac-1',
            clientEventId: 'evt-lock-dto',
            ticketId: 't-lock-1',
            shiftId: 's1',
            studentId: 'u1',
            studentCode: 'SE1',
            studentName: 'SV',
            eventType: 'TAB_SWITCH',
            severity: 'high',
            details: 'Locked by server',
            violationCount: 1,
            isLocked: true,
            maxViolations: 3,
            lockThreshold: 4,
            remainingStrikes: 2,
            occurredAt: new Date().toISOString(),
          }
        },
      },
      ticketId: 't-lock-1',
      onTicketLocked: (dto) => {
        lockedFromDto = dto
      },
      onBlurCountSync: (count) => {
        syncedBlur = count
      },
    })
    assert.equal(lockedFromDto?.isLocked, true)
    assert.equal(syncedBlur, 2)

    await savePendingAntiCheatLog({
      ticketId: 't-lock-409',
      shiftId: 's1',
      studentId: 'u1',
      clientEventId: 'evt-lock-409',
      eventType: 'WINDOW_BLUR',
      severity: 'HIGH',
      details: 'Blur',
    })
    let lockedFrom409 = false
    await assert.rejects(
      () =>
        flushPendingAntiCheatLogsQueue({
          apiClient: {
            async logAntiCheat() {
              throw new ApiProblemError(
                { status: 409, type: 'https://oralexam.fpt.edu.vn/errors/ticket-locked', detail: 'TICKET_LOCKED' },
                409,
              )
            },
          },
          ticketId: 't-lock-409',
          onTicketLocked: () => {
            lockedFrom409 = true
          },
        }),
      (err) => err instanceof ApiProblemError && err.status === 409,
    )
    assert.equal(lockedFrom409, true)
    assert.equal((await loadPendingAntiCheatLogs('t-lock-409')).length, 0)
  } finally {
    globalThis.indexedDB = originalIndexedDb
  }
})

test('M4: App recovers from mid-exam mic disconnect, preserves VoiceWithTranscriptEdit state on upload error, forwards timestampsJson, and locks immediately on isKioskLocked / 409 TICKET_LOCKED', async () => {
  const { createRoot } = require('react-dom/client')
  const { act } = require('react')
  const App = require('../node_modules/.tmp/test-dist/App.js').default

  function createDom() {
    class FakeNode {
      constructor(nodeType, nodeName) {
        this.nodeType = nodeType
        this.nodeName = nodeName
        this.parentNode = null
        this.childNodes = []
        this.ownerDocument = null
        this.listeners = new Map()
      }
      get firstChild() { return this.childNodes[0] ?? null }
      get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null }
      get nextSibling() {
        if (!this.parentNode) return null
        const idx = this.parentNode.childNodes.indexOf(this)
        return idx >= 0 ? (this.parentNode.childNodes[idx + 1] ?? null) : null
      }
      get previousSibling() {
        if (!this.parentNode) return null
        const idx = this.parentNode.childNodes.indexOf(this)
        return idx > 0 ? (this.parentNode.childNodes[idx - 1] ?? null) : null
      }
      appendChild(c) { return this.insertBefore(c, null) }
      insertBefore(c, ref) {
        if (c.nodeType === 11) {
          for (const item of [...c.childNodes]) this.insertBefore(item, ref)
          return c
        }
        if (c.parentNode) c.parentNode.removeChild(c)
        c.parentNode = this
        c.ownerDocument = this.nodeType === 9 ? this : this.ownerDocument
        if (!ref) this.childNodes.push(c)
        else {
          const idx = this.childNodes.indexOf(ref)
          if (idx >= 0) this.childNodes.splice(idx, 0, c)
          else this.childNodes.push(c)
        }
        return c
      }
      removeChild(c) {
        const idx = this.childNodes.indexOf(c)
        if (idx >= 0) {
          this.childNodes.splice(idx, 1)
          c.parentNode = null
        }
        return c
      }
      addEventListener(t, fn) {
        const set = this.listeners.get(t) ?? new Set()
        set.add(fn)
        this.listeners.set(t, set)
      }
      removeEventListener(t, fn) { this.listeners.get(t)?.delete(fn) }
      dispatchEvent(e) {
        e.target ??= this
        e.preventDefault ??= () => {}
        e.stopPropagation ??= () => {}
        let cur = this
        while (cur) {
          e.currentTarget = cur
          const set = cur.listeners.get(e.type)
          if (set) for (const fn of Array.from(set)) fn(e)
          cur = cur.parentNode
        }
        return true
      }
    }
    class FakeText extends FakeNode {
      constructor(t) { super(3, '#text'); this._t = String(t) }
      get nodeValue() { return this._t }
      set nodeValue(v) { this._t = String(v) }
      get textContent() { return this._t }
      set textContent(v) { this._t = String(v) }
    }
    class FakeComment extends FakeNode {
      constructor(t) { super(8, '#comment'); this._t = String(t) }
      get nodeValue() { return this._t }
      set nodeValue(v) { this._t = String(v) }
    }
    class FakeElement extends FakeNode {
      constructor(tag) {
        super(1, tag.toUpperCase())
        this.tagName = tag.toUpperCase()
        this.attrs = new Map()
        this.style = {}
        this._value = ''
        this.disabled = false
        this.type = ''
        this.id = ''
        this.className = ''
        this.isContentEditable = false
      }
      get value() { return this._value }
      set value(v) { this._value = String(v ?? '') }
      get textContent() { return this.childNodes.map((c) => c.textContent ?? '').join('') }
      set textContent(v) {
        for (const c of [...this.childNodes]) this.removeChild(c)
        if (v !== '' && v != null) this.appendChild(this.ownerDocument.createTextNode(String(v)))
      }
      setAttribute(n, v) {
        const s = String(v)
        this.attrs.set(n, s)
        if (n === 'id') this.id = s
        if (n === 'class') this.className = s
        if (n === 'type') this.type = s
        if (n === 'disabled') this.disabled = true
      }
      getAttribute(n) { return this.attrs.get(n) ?? null }
      removeAttribute(n) { this.attrs.delete(n); if (n === 'disabled') this.disabled = false }
      hasAttribute(n) { return this.attrs.has(n) }
      focus() {}
      blur() {}
    }
    const doc = new FakeNode(9, '#document')
    doc.visibilityState = 'visible'
    doc.activeElement = null
    doc.createElement = (tag) => { const el = new FakeElement(tag); el.ownerDocument = doc; return el }
    doc.createElementNS = (_ns, tag) => doc.createElement(tag)
    doc.createTextNode = (t) => { const n = new FakeText(t); n.ownerDocument = doc; return n }
    doc.createComment = (t) => { const n = new FakeComment(t); n.ownerDocument = doc; return n }
    doc.createDocumentFragment = () => { const f = new FakeNode(11, '#document-fragment'); f.ownerDocument = doc; return f }
    doc.documentElement = doc.createElement('html')
    doc.head = doc.createElement('head')
    doc.body = doc.createElement('body')
    doc.appendChild(doc.documentElement)
    doc.documentElement.appendChild(doc.head)
    doc.documentElement.appendChild(doc.body)
    return { doc, FakeElement }
  }

  const findAll = (n, pred, out = []) => {
    if (pred(n)) out.push(n)
    for (const c of n.childNodes ?? []) findAll(c, pred, out)
    return out
  }
  const findButton = (n, label) => findAll(n, (x) => x.tagName === 'BUTTON' && x.textContent.includes(label))[0]
  const findById = (n, id) => findAll(n, (x) => x.id === id)[0]
  const setInputValue = (el, v) => {
    const k = Object.keys(el).find((x) => x.startsWith('__reactProps$'))
    el.value = v
    if (k && el[k]?.onChange) el[k].onChange({ target: el, currentTarget: el })
  }
  const clickEl = (el) => {
    const k = Object.keys(el).find((x) => x.startsWith('__reactProps$'))
    if (k && el[k]?.onClick) return el[k].onClick({ preventDefault: () => {}, target: el, currentTarget: el })
    el.dispatchEvent({ type: 'click', bubbles: true, cancelable: true })
    return undefined
  }
  const submitForm = (el) => {
    const k = Object.keys(el).find((x) => x.startsWith('__reactProps$'))
    if (k && el[k]?.onSubmit) return el[k].onSubmit({ preventDefault: () => {}, target: el, currentTarget: el })
    el.dispatchEvent({ type: 'submit', bubbles: true, cancelable: true })
    return undefined
  }

  const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const originals = {
    document: globalThis.document,
    window: globalThis.window,
    indexedDB: globalThis.indexedDB,
    fetch: globalThis.fetch,
    MediaRecorder: globalThis.MediaRecorder,
    AudioContext: globalThis.AudioContext,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }

  const { doc, FakeElement } = createDom()
  let rafId = 0
  let fakePerfNow = 1000
  const origPerfNow = performance.now.bind(performance)
  performance.now = () => fakePerfNow
  const rafTimers = new Map()
  const activeTracks = []
  let getUserMediaCount = 0
  let failR2Upload = true
  let ticketIsKioskLockedOnCurrent = false
  let submitReturnsLocked409 = false
  const submittedAnswers = []

  const fakeWindow = {
    document: doc,
    HTMLElement: FakeElement,
    HTMLInputElement: FakeElement,
    HTMLTextAreaElement: FakeElement,
    HTMLIFrameElement: class FakeHTMLIFrameElement {},
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener: () => {},
    removeEventListener: () => {},
    kioskApi: {
      getRuntimeInfo: async () => ({
        appName: 'Oral Exam Desktop Kiosk',
        appVersion: '0.1.1',
        isPackaged: false,
        isKioskMode: true,
        altTabTestMode: false,
        platform: 'win32',
        apiBaseUrl: 'http://127.0.0.1:5000/api/v1',
        deviceId: 'oes-win-1234567890abcdef',
        kioskVersion: 'desktop-kiosk-0.1.1',
        displayCount: 1,
        isFullscreen: true,
        windowsAgentAvailable: true,
      }),
      getSecuritySnapshot: async () => ({
        deviceId: 'oes-win-1234567890abcdef',
        displayCount: 1,
        isFullscreen: true,
        windowsAgent: {
          deviceFingerprint: 'oes-win-1234567890abcdef',
          displayCount: 1,
          vmDetected: false,
          vmIndicators: [],
          remoteControlDetected: false,
          remoteControlProcesses: [],
          disallowedProcesses: [],
          probedAtUtc: '2026-11-27T08:00:00Z',
        },
      }),
      authorizeExitAfterSubmit: async () => true,
      requestExit: async () => true,
      onSecurityEvent: () => () => {},
    },
  }
  doc.defaultView = fakeWindow
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.document = doc
  globalThis.window = fakeWindow
  globalThis.HTMLInputElement = FakeElement
  globalThis.HTMLTextAreaElement = FakeElement
  globalThis.indexedDB = createFakeIndexedDb()

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => {
          getUserMediaCount += 1
          const track = {
            readyState: 'live',
            stop() { this.readyState = 'ended' },
            onended: null,
          }
          activeTracks.push(track)
          return {
            getTracks: () => [track],
            getAudioTracks: () => [track],
          }
        },
      },
    },
  })

  globalThis.requestAnimationFrame = (cb) => {
    rafId += 1
    const id = rafId
    const timer = setTimeout(() => {
      rafTimers.delete(id)
      fakePerfNow += 31_000
      cb(fakePerfNow)
    }, 1)
    rafTimers.set(id, timer)
    return id
  }
  globalThis.cancelAnimationFrame = (id) => {
    const timer = rafTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      rafTimers.delete(id)
    }
  }
  globalThis.AudioContext = class FakeAudioContext {
    createAnalyser() { return { fftSize: 2048, getByteTimeDomainData: (arr) => arr.fill(160) } }
    createMediaStreamSource() { return { connect() {} } }
    close() { return Promise.resolve() }
  }
  globalThis.MediaRecorder = class FakeMediaRecorder {
    constructor(stream) {
      const liveTrack = stream?.getAudioTracks?.().find((t) => t.readyState === 'live')
      if (!liveTrack) throw new Error('Failed to construct MediaRecorder: dead stream')
      this.state = 'inactive'
      this.ondataavailable = null
      this.onstop = null
      this.onerror = null
    }
    start() { this.state = 'recording' }
    stop() {
      this.state = 'inactive'
      this.ondataavailable?.({ data: new Blob(['real-webm-audio'], { type: 'audio/webm' }) })
      this.onstop?.()
    }
  }

  const nowIso = new Date().toISOString()
  const endIso = new Date(Date.now() + 600_000).toISOString()
  globalThis.fetch = async (url, init = {}) => {
    const urlStr = String(url)
    if (urlStr.endsWith('/auth/kiosk/password-login')) {
      return jsonResponse({
        accessToken: 'acc-1',
        refreshToken: 'ref-1',
        tokenType: 'Bearer',
        expiresIn: 900,
        mustChangePassword: false,
        user: { id: 'u1', email: 'sv@fpt.edu.vn', fullName: 'SV Test', role: 'student' },
      })
    }
    if (urlStr.endsWith('/official-exams/tickets/current')) {
      return jsonResponse({
        id: 't-m4',
        shiftId: 's1',
        shiftName: 'Ca 1',
        roomLab: 'P201',
        startTime: nowIso,
        endTime: endIso,
        shiftStatus: 'in_progress',
        sessionTitle: 'Thi cuoi ky',
        studentId: 'u1',
        seatNumber: 5,
        status: 'IN_PROGRESS',
        examSetId: 'set1',
        examSetCode: 'DE01',
        examInputMode: 'VoiceWithTranscriptEdit',
        transcriptBufferSeconds: 60,
        hasFollowUp: false,
        maxFollowUpQuestions: 0,
        isExamPublished: true,
        isKioskLocked: ticketIsKioskLockedOnCurrent,
        violationCount: ticketIsKioskLockedOnCurrent ? 2 : 0,
        serverNowUtc: nowIso,
        questions: [
          {
            questionId: 'q1',
            orderIndex: 1,
            title: 'DIP',
            content: 'Explain DIP',
            bloomLevel: 'Understand',
            difficulty: 'medium',
            imageUrl: null,
            imageDescription: null,
          },
        ],
      })
    }
    if (urlStr.endsWith('/official-exams/tickets/t-m4/check-in')) {
      return jsonResponse({
        id: 't-m4',
        shiftId: 's1',
        studentId: 'u1',
        seatNumber: 5,
        ipAddress: '127.0.0.1',
        status: 'IN_PROGRESS',
        checkedInAt: nowIso,
        examSetId: 'set1',
        activeSessionToken: 'kiosk-sess-m4',
      })
    }
    if (urlStr.endsWith('/official-exams/tickets/t-m4')) {
      return jsonResponse({
        ticketId: 't-m4',
        shiftId: 's1',
        status: 'IN_PROGRESS',
        isExamPublished: true,
        isKioskLocked: false,
        violationCount: 0,
        maxViolations: 3,
        lockThreshold: 4,
        remainingStrikes: 4,
        serverNowUtc: nowIso,
        deviceId: 'oes-win-1234567890abcdef',
        deviceLockedAt: nowIso,
        deviceUnlockCount: 0,
        followUps: [],
      })
    }
    if (urlStr.endsWith('/heartbeat')) {
      return jsonResponse({
        ticketId: 't-m4',
        shiftId: 's1',
        ticketStatus: 'IN_PROGRESS',
        shiftStatus: 'in_progress',
        serverUtcNow: nowIso,
        remainingShiftSeconds: 500,
        isLocked: false,
        deviceUnlockRequired: false,
        shouldTerminateExam: false,
        notice: null,
      })
    }
    if (urlStr.endsWith('/anti-cheat/log')) {
      return jsonResponse({
        id: 'ac-1',
        clientEventId: 'evt',
        ticketId: 't-m4',
        shiftId: 's1',
        studentId: 'u1',
        eventType: 'DEVICE_DISCONNECTION',
        severity: 'high',
        details: 'mic disconnected',
        violationCount: 1,
        isLocked: false,
        maxViolations: 3,
        lockThreshold: 4,
        remainingStrikes: 4,
        occurredAt: nowIso,
      })
    }
    if (urlStr.endsWith('/speech/stt')) {
      return jsonResponse({
        text: 'initial spoken transcript',
        rawText: 'initial spoken transcript',
        provider: 'whisper',
        timestampsJson: '{"words":[{"word":"initial","start":0,"end":0.4}]}',
        confidenceScore: 0.96,
      })
    }
    if (urlStr.endsWith('/audio-upload-authorizations')) {
      return jsonResponse({
        objectKey: 'official/s1/t-m4/q1_0.webm',
        fileName: '05_SE001_Q1.webm',
        uploadUrl: 'https://r2.example/t-m4/q1',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        requiredHeaders: { 'Content-Type': 'audio/webm', 'If-None-Match': '*' },
      })
    }
    if (urlStr === 'https://r2.example/t-m4/q1') {
      if (failR2Upload) return new Response(null, { status: 503 })
      return new Response(null, { status: 200 })
    }
    if (urlStr.endsWith('/questions/q1/answers')) {
      const parsed = JSON.parse(init.body)
      submittedAnswers.push(parsed)
      return jsonResponse({
        submissionId: 'sub-m4-1',
        ticketId: 't-m4',
        examQuestionId: 'q1',
        followUpIndex: 0,
        audioObjectKey: parsed.audioObjectKey,
        audioHashSha256: parsed.audioHashSha256,
        status: 'RECORDED',
        canRequestFollowUp: false,
      })
    }
    if (urlStr.endsWith('/submission')) {
      if (submitReturnsLocked409) {
        return jsonResponse(
          { status: 409, type: 'https://oralexam.fpt.edu.vn/errors/ticket-locked', detail: 'TICKET_LOCKED' },
          409,
        )
      }
      return jsonResponse({
        ticketId: 't-m4',
        status: 'SUBMITTED',
        submittedAt: nowIso,
        submissionCount: 1,
        isKioskLocked: true,
      })
    }
    throw new Error(`Unexpected URL: ${urlStr}`)
  }

  const container = doc.createElement('div')
  doc.body.appendChild(container)
  const rootInstance = createRoot(container)

  try {
    // Part 1: isKioskLocked: true on IN_PROGRESS ticket routes immediately to BlockedScreen on login
    ticketIsKioskLockedOnCurrent = true
    await act(async () => {
      rootInstance.render(React.createElement(App))
    })
    await act(async () => {
      setInputValue(findById(container, 'username'), 'sv001')
      setInputValue(findById(container, 'password'), 'Password123!')
    })
    await act(async () => {
      await submitForm(findAll(container, (n) => n.tagName === 'FORM')[0])
      await new Promise((r) => setTimeout(r, 20))
    })
    assert.match(container.textContent, /Phiên thi đã tạm dừng/)
    assert.match(container.textContent, /Mất tiêu điểm: 2|Vé thi đã bị khóa/)
    await act(async () => {
      clickEl(findButton(container, 'Quay về đăng nhập'))
    })

    // Part 2: Mid-exam mic disconnect -> reconnect recovery + confirm failure preserves review + timestampsJson + 409 TICKET_LOCKED on submit
    ticketIsKioskLockedOnCurrent = false
    await act(async () => {
      setInputValue(findById(container, 'username'), 'sv001')
      setInputValue(findById(container, 'password'), 'Password123!')
    })
    await act(async () => {
      await submitForm(findAll(container, (n) => n.tagName === 'FORM')[0])
      await new Promise((r) => setTimeout(r, 20))
    })
    await act(async () => {
      clickEl(findButton(container, 'Bắt đầu kiểm tra'))
      await new Promise((r) => setTimeout(r, 20))
    })
    await act(async () => {
      clickEl(findButton(container, 'Điểm danh và vào phòng chờ'))
      await new Promise((r) => setTimeout(r, 20))
    })
    await act(async () => {
      clickEl(findButton(container, 'Bắt đầu làm bài'))
      await new Promise((r) => setTimeout(r, 20))
    })

    // Start recording -> simulate physical mic unplug (track.readyState = 'ended' + track.onended())
    await act(async () => {
      clickEl(findButton(container, 'Ghi âm'))
      await new Promise((r) => setTimeout(r, 10))
    })
    const countBeforeDisconnect = getUserMediaCount
    await act(async () => {
      const track = activeTracks[activeTracks.length - 1]
      track.readyState = 'ended'
      track.onended?.()
      await new Promise((r) => setTimeout(r, 15))
    })
    assert.match(container.textContent, /Microphone bị ngắt kết nối đột ngột/)

    // Reconnect mic: clicking "Ghi âm" again re-acquires fresh MediaStream and records without crashing
    await act(async () => {
      clickEl(findButton(container, 'Ghi âm'))
      await new Promise((r) => setTimeout(r, 15))
    })
    assert.equal(getUserMediaCount, countBeforeDisconnect + 1)

    // Stop recording -> enters VoiceWithTranscriptEdit review panel
    await act(async () => {
      clickEl(findAll(container, (n) => n.tagName === 'BUTTON' && n.getAttribute('aria-label') === 'Dừng ghi âm')[0])
      await new Promise((r) => setTimeout(r, 20))
    })
    assert.match(container.textContent, /Hiệu đính bản trả lời/)

    // Edit transcript slightly and click Confirm while R2 returns 503 -> review panel MUST remain intact!
    await act(async () => {
      setInputValue(findById(container, 'transcript'), 'initial spoken transcript v2')
    })
    await act(async () => {
      clickEl(findButton(container, 'Xác nhận và lưu câu trả lời'))
      for (let i = 0; i < 30; i += 1) {
        await new Promise((r) => setTimeout(r, 35))
        if (container.textContent.includes('HTTP 503')) break
      }
    })
    assert.match(container.textContent, /HTTP 503/)
    assert.ok(findById(container, 'transcript'), 'Transcript review textarea must remain preserved after upload error')
    assert.equal(findById(container, 'transcript').value, 'initial spoken transcript v2')

    // Retry confirm with R2 healthy -> succeeds without re-recording and forwards timestampsWhisper!
    failR2Upload = false
    await act(async () => {
      clickEl(findButton(container, 'Xác nhận và lưu câu trả lời'))
      await new Promise((r) => setTimeout(r, 30))
    })
    assert.equal(submittedAnswers.length, 1)
    assert.equal(submittedAnswers[0].transcriptWhisper, 'initial spoken transcript v2')
    assert.equal(
      submittedAnswers[0].timestampsWhisper,
      '{"words":[{"word":"initial","start":0,"end":0.4}]}',
    )

    // Submit with 409 TICKET_LOCKED -> transitions immediately to BlockedScreen
    submitReturnsLocked409 = true
    await act(async () => {
      clickEl(findButton(container, 'Nộp bài và khóa kiosk'))
      await new Promise((r) => setTimeout(r, 20))
    })
    assert.match(container.textContent, /Phiên thi đã tạm dừng/)
    assert.match(container.textContent, /TICKET_LOCKED/)
  } finally {
    for (const timer of rafTimers.values()) clearTimeout(timer)
    rafTimers.clear()
    await act(async () => {
      rootInstance.unmount()
    })
    performance.now = origPerfNow
    globalThis.document = originals.document
    globalThis.window = originals.window
    if (origNavDesc) Object.defineProperty(globalThis, 'navigator', origNavDesc)
    globalThis.indexedDB = originals.indexedDB
    globalThis.fetch = originals.fetch
    globalThis.MediaRecorder = originals.MediaRecorder
    globalThis.AudioContext = originals.AudioContext
    globalThis.requestAnimationFrame = originals.requestAnimationFrame
    globalThis.cancelAnimationFrame = originals.cancelAnimationFrame
    globalThis.IS_REACT_ACT_ENVIRONMENT = originals.IS_REACT_ACT_ENVIRONMENT
    delete globalThis.HTMLInputElement
    delete globalThis.HTMLTextAreaElement
  }
})

test('M4 Iter2 Stress: Oes.WindowsAgent --watch 2000 --parent-pid exits cleanly with code 0 and empty stderr across staggered parent exits', async () => {
  const exeCandidates = [
    path.join(root, 'native', 'Oes.WindowsAgent', 'bin', 'Release', 'net8.0', 'Oes.WindowsAgent.exe'),
    path.join(root, 'native', 'dist', 'Oes.WindowsAgent', 'Oes.WindowsAgent.exe'),
  ]
  const existingExe = exeCandidates.find((candidate) => existsSync(candidate))
  assert.ok(existingExe, 'Oes.WindowsAgent.exe Release binary must exist during verify')

  const runSingleParentExitProbe = (parentLifetimeMs) =>
    new Promise((resolve, reject) => {
      const parentProc = spawn(
        process.execPath,
        ['-e', `setTimeout(() => process.exit(0), ${parentLifetimeMs})`],
        { stdio: 'ignore', windowsHide: true },
      )
      parentProc.once('error', reject)
      assert.ok(parentProc.pid && parentProc.pid > 0, 'Parent probe PID must be valid')

      const agentProc = spawn(
        existingExe,
        ['--watch', '2000', '--parent-pid', String(parentProc.pid)],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      )
      let stderr = ''
      agentProc.stderr.on('data', (chunk) => {
        stderr += String(chunk)
      })
      agentProc.once('error', reject)

      const timeout = setTimeout(() => {
        try {
          agentProc.kill()
        } catch {
          // ignore
        }
        reject(new Error(`Oes.WindowsAgent timed out after parent lifetime ${parentLifetimeMs}ms`))
      }, 12_000)

      agentProc.once('exit', (code, signal) => {
        clearTimeout(timeout)
        resolve({ parentLifetimeMs, code, signal, stderr })
      })
    })

  // Stagger parent exits across 10..400ms to cover Probe(), FlushAsync(), and Task.Delay() windows
  const delays = [15, 45, 75, 110, 145, 180, 220, 270, 330, 400]
  const results = []
  for (const batch of [delays.slice(0, 5), delays.slice(5)]) {
    const batchResults = await Promise.all(batch.map((ms) => runSingleParentExitProbe(ms)))
    results.push(...batchResults)
  }

  for (const res of results) {
    assert.equal(
      res.code,
      0,
      `Expected ExitCode 0 for parentLifetimeMs=${res.parentLifetimeMs}, got code=${res.code}, signal=${res.signal}, stderr=${res.stderr}`,
    )
    assert.equal(
      res.stderr.trim(),
      '',
      `Expected empty stderr for parentLifetimeMs=${res.parentLifetimeMs}, got: ${res.stderr}`,
    )
  }
})

test('M4 Iter2: 409 TicketNotInProgress with SUBMITTED + isKioskLocked transitions to SubmittedScreen, deadline submitExam(true) aborts on 409 TICKET_LOCKED, and combined heartbeat notice is not suppressed', async () => {
  const { createRoot } = require('react-dom/client')
  const { act } = require('react')
  const App = require('../node_modules/.tmp/test-dist/App.js').default

  function createDom() {
    class FakeNode {
      constructor(nodeType, nodeName) {
        this.nodeType = nodeType
        this.nodeName = nodeName
        this.parentNode = null
        this.childNodes = []
        this.ownerDocument = null
        this.listeners = new Map()
      }
      get firstChild() { return this.childNodes[0] ?? null }
      get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null }
      get nextSibling() {
        if (!this.parentNode) return null
        const idx = this.parentNode.childNodes.indexOf(this)
        return idx >= 0 ? (this.parentNode.childNodes[idx + 1] ?? null) : null
      }
      get previousSibling() {
        if (!this.parentNode) return null
        const idx = this.parentNode.childNodes.indexOf(this)
        return idx > 0 ? (this.parentNode.childNodes[idx - 1] ?? null) : null
      }
      appendChild(c) { return this.insertBefore(c, null) }
      insertBefore(c, ref) {
        if (c.nodeType === 11) {
          for (const item of [...c.childNodes]) this.insertBefore(item, ref)
          return c
        }
        if (c.parentNode) c.parentNode.removeChild(c)
        c.parentNode = this
        c.ownerDocument = this.nodeType === 9 ? this : this.ownerDocument
        if (!ref) this.childNodes.push(c)
        else {
          const idx = this.childNodes.indexOf(ref)
          if (idx >= 0) this.childNodes.splice(idx, 0, c)
          else this.childNodes.push(c)
        }
        return c
      }
      removeChild(c) {
        const idx = this.childNodes.indexOf(c)
        if (idx >= 0) {
          this.childNodes.splice(idx, 1)
          c.parentNode = null
        }
        return c
      }
      addEventListener(t, fn) {
        const set = this.listeners.get(t) ?? new Set()
        set.add(fn)
        this.listeners.set(t, set)
      }
      removeEventListener(t, fn) { this.listeners.get(t)?.delete(fn) }
      dispatchEvent(e) {
        e.target ??= this
        e.preventDefault ??= () => {}
        e.stopPropagation ??= () => {}
        let cur = this
        while (cur) {
          e.currentTarget = cur
          const set = cur.listeners.get(e.type)
          if (set) for (const fn of Array.from(set)) fn(e)
          cur = cur.parentNode
        }
        return true
      }
    }
    class FakeText extends FakeNode {
      constructor(t) { super(3, '#text'); this._t = String(t) }
      get nodeValue() { return this._t }
      set nodeValue(v) { this._t = String(v) }
      get textContent() { return this._t }
      set textContent(v) { this._t = String(v) }
    }
    class FakeComment extends FakeNode {
      constructor(t) { super(8, '#comment'); this._t = String(t) }
      get nodeValue() { return this._t }
      set nodeValue(v) { this._t = String(v) }
    }
    class FakeElement extends FakeNode {
      constructor(tag) {
        super(1, tag.toUpperCase())
        this.tagName = tag.toUpperCase()
        this.attrs = new Map()
        this.style = {}
        this._value = ''
        this.disabled = false
        this.type = ''
        this.id = ''
        this.className = ''
        this.isContentEditable = false
      }
      get value() { return this._value }
      set value(v) { this._value = String(v ?? '') }
      get textContent() { return this.childNodes.map((c) => c.textContent ?? '').join('') }
      set textContent(v) {
        for (const c of [...this.childNodes]) this.removeChild(c)
        if (v !== '' && v != null) this.appendChild(this.ownerDocument.createTextNode(String(v)))
      }
      setAttribute(n, v) {
        const s = String(v)
        this.attrs.set(n, s)
        if (n === 'id') this.id = s
        if (n === 'class') this.className = s
        if (n === 'type') this.type = s
        if (n === 'disabled') this.disabled = true
      }
      getAttribute(n) { return this.attrs.get(n) ?? null }
      removeAttribute(n) { this.attrs.delete(n); if (n === 'disabled') this.disabled = false }
      hasAttribute(n) { return this.attrs.has(n) }
      focus() {}
      blur() {}
    }
    const doc = new FakeNode(9, '#document')
    doc.visibilityState = 'visible'
    doc.activeElement = null
    doc.createElement = (tag) => { const el = new FakeElement(tag); el.ownerDocument = doc; return el }
    doc.createElementNS = (_ns, tag) => doc.createElement(tag)
    doc.createTextNode = (t) => { const n = new FakeText(t); n.ownerDocument = doc; return n }
    doc.createComment = (t) => { const n = new FakeComment(t); n.ownerDocument = doc; return n }
    doc.createDocumentFragment = () => { const f = new FakeNode(11, '#document-fragment'); f.ownerDocument = doc; return f }
    doc.documentElement = doc.createElement('html')
    doc.head = doc.createElement('head')
    doc.body = doc.createElement('body')
    doc.appendChild(doc.documentElement)
    doc.documentElement.appendChild(doc.head)
    doc.documentElement.appendChild(doc.body)
    return { doc, FakeElement }
  }

  const findAll = (n, pred, out = []) => {
    if (pred(n)) out.push(n)
    for (const c of n.childNodes ?? []) findAll(c, pred, out)
    return out
  }
  const findButton = (n, label) => findAll(n, (x) => x.tagName === 'BUTTON' && x.textContent.includes(label))[0]
  const findById = (n, id) => findAll(n, (x) => x.id === id)[0]
  const setInputValue = (el, v) => {
    const k = Object.keys(el).find((x) => x.startsWith('__reactProps$'))
    el.value = v
    if (k && el[k]?.onChange) el[k].onChange({ target: el, currentTarget: el })
  }
  const clickEl = (el) => {
    const k = Object.keys(el).find((x) => x.startsWith('__reactProps$'))
    if (k && el[k]?.onClick) return el[k].onClick({ preventDefault: () => {}, target: el, currentTarget: el })
    el.dispatchEvent({ type: 'click', bubbles: true, cancelable: true })
    return undefined
  }
  const submitForm = (el) => {
    const k = Object.keys(el).find((x) => x.startsWith('__reactProps$'))
    if (k && el[k]?.onSubmit) return el[k].onSubmit({ preventDefault: () => {}, target: el, currentTarget: el })
    el.dispatchEvent({ type: 'submit', bubbles: true, cancelable: true })
    return undefined
  }

  const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const originals = {
    document: globalThis.document,
    window: globalThis.window,
    indexedDB: globalThis.indexedDB,
    fetch: globalThis.fetch,
    MediaRecorder: globalThis.MediaRecorder,
    AudioContext: globalThis.AudioContext,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }

  const runAppScenario = async ({ scenario }) => {
    const { doc, FakeElement } = createDom()
    let rafId = 0
    let fakePerfNow = 1000
    const origPerfNow = performance.now.bind(performance)
    performance.now = () => fakePerfNow
    const rafTimers = new Map()
    let answerCalls = 0
    let submitExamCalls = 0
    let heartbeatCount = 0
    let heartbeatIntervalCb = null
    let ticketStateSubmitted = false

    const fakeWindow = {
      document: doc,
      HTMLElement: FakeElement,
      HTMLInputElement: FakeElement,
      HTMLTextAreaElement: FakeElement,
      HTMLIFrameElement: class FakeHTMLIFrameElement {},
      setInterval: (fn, ms, ...args) => {
        if (ms === 20_000) heartbeatIntervalCb = fn
        return globalThis.setInterval(fn, ms, ...args)
      },
      clearInterval: globalThis.clearInterval.bind(globalThis),
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      addEventListener: () => {},
      removeEventListener: () => {},
      kioskApi: {
        getRuntimeInfo: async () => ({
          appName: 'Oral Exam Desktop Kiosk',
          appVersion: '0.1.1',
          isPackaged: false,
          isKioskMode: true,
          altTabTestMode: false,
          platform: 'win32',
          apiBaseUrl: 'http://127.0.0.1:5000/api/v1',
          deviceId: 'oes-win-1234567890abcdef',
          kioskVersion: 'desktop-kiosk-0.1.1',
          displayCount: 1,
          isFullscreen: true,
          windowsAgentAvailable: true,
        }),
        getSecuritySnapshot: async () => ({
          deviceId: 'oes-win-1234567890abcdef',
          displayCount: 1,
          isFullscreen: true,
          windowsAgent: {
            deviceFingerprint: 'oes-win-1234567890abcdef',
            displayCount: 1,
            vmDetected: false,
            vmIndicators: [],
            remoteControlDetected: false,
            remoteControlProcesses: [],
            disallowedProcesses: [],
            probedAtUtc: '2026-11-27T08:00:00Z',
          },
        }),
        authorizeExitAfterSubmit: async () => true,
        requestExit: async () => true,
        onSecurityEvent: () => () => {},
      },
    }
    doc.defaultView = fakeWindow
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    globalThis.document = doc
    globalThis.window = fakeWindow
    globalThis.HTMLInputElement = FakeElement
    globalThis.HTMLTextAreaElement = FakeElement
    globalThis.indexedDB = createFakeIndexedDb()

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        mediaDevices: {
          getUserMedia: async () => {
            const track = { readyState: 'live', stop() { this.readyState = 'ended' }, onended: null }
            return { getTracks: () => [track], getAudioTracks: () => [track] }
          },
        },
      },
    })
    globalThis.requestAnimationFrame = (cb) => {
      rafId += 1
      const id = rafId
      const timer = setTimeout(() => {
        rafTimers.delete(id)
        fakePerfNow += 31_000
        cb(fakePerfNow)
      }, 1)
      rafTimers.set(id, timer)
      return id
    }
    globalThis.cancelAnimationFrame = (id) => {
      const timer = rafTimers.get(id)
      if (timer) {
        clearTimeout(timer)
        rafTimers.delete(id)
      }
    }
    globalThis.AudioContext = class FakeAudioContext {
      createAnalyser() { return { fftSize: 2048, getByteTimeDomainData: (arr) => arr.fill(160) } }
      createMediaStreamSource() { return { connect() {} } }
      close() { return Promise.resolve() }
    }
    globalThis.MediaRecorder = class FakeMediaRecorder {
      constructor() {
        this.state = 'inactive'
        this.ondataavailable = null
        this.onstop = null
        this.onerror = null
      }
      start() { this.state = 'recording' }
      stop() {
        this.state = 'inactive'
        this.ondataavailable?.({ data: new Blob(['real-webm-audio'], { type: 'audio/webm' }) })
        this.onstop?.()
      }
    }

    const nowMs = Date.now()
    const nowIso = new Date(nowMs).toISOString()
    const endIso = new Date(nowMs + (scenario === 'deadline-locked' ? 750 : 600_000)).toISOString()

    globalThis.fetch = async (url) => {
      const urlStr = String(url)
      if (urlStr.endsWith('/auth/kiosk/password-login')) {
        return jsonResponse({
          accessToken: 'acc-1',
          refreshToken: 'ref-1',
          tokenType: 'Bearer',
          expiresIn: 900,
          mustChangePassword: false,
          user: { id: 'u1', email: 'sv@fpt.edu.vn', fullName: 'SV Test', role: 'student' },
        })
      }
      if (urlStr.endsWith('/official-exams/tickets/current')) {
        return jsonResponse({
          id: 't-iter2',
          shiftId: 's1',
          shiftName: 'Ca 1',
          roomLab: 'P201',
          startTime: nowIso,
          endTime: endIso,
          shiftStatus: 'in_progress',
          sessionTitle: 'Thi cuoi ky',
          studentId: 'u1',
          seatNumber: 5,
          status: 'IN_PROGRESS',
          examSetId: 'set1',
          examSetCode: 'DE01',
          examInputMode: 'VoiceOnly',
          transcriptBufferSeconds: 60,
          hasFollowUp: false,
          maxFollowUpQuestions: 0,
          isExamPublished: true,
          isKioskLocked: false,
          serverNowUtc: nowIso,
          questions: [
            {
              questionId: 'q1',
              orderIndex: 1,
              title: 'DIP',
              content: 'Explain DIP',
              bloomLevel: 'Understand',
              difficulty: 'medium',
              imageUrl: null,
              imageDescription: null,
            },
          ],
        })
      }
      if (urlStr.endsWith('/official-exams/tickets/t-iter2/check-in')) {
        return jsonResponse({
          id: 't-iter2',
          shiftId: 's1',
          studentId: 'u1',
          seatNumber: 5,
          ipAddress: '127.0.0.1',
          status: 'IN_PROGRESS',
          checkedInAt: nowIso,
          examSetId: 'set1',
          activeSessionToken: 'kiosk-sess-iter2',
        })
      }
      if (urlStr.endsWith('/official-exams/tickets/t-iter2')) {
        return jsonResponse({
          ticketId: 't-iter2',
          shiftId: 's1',
          status: ticketStateSubmitted ? 'SUBMITTED' : 'IN_PROGRESS',
          isExamPublished: true,
          isKioskLocked: ticketStateSubmitted,
          violationCount: 0,
          maxViolations: 3,
          lockThreshold: 4,
          remainingStrikes: 4,
          serverNowUtc: nowIso,
          deviceId: 'oes-win-1234567890abcdef',
          deviceLockedAt: nowIso,
          deviceUnlockCount: 0,
          followUps: [],
        })
      }
      if (urlStr.endsWith('/heartbeat')) {
        heartbeatCount += 1
        let notice = null
        if (scenario === 'heartbeat-notice') {
          if (heartbeatCount === 2) {
            notice =
              'Tín hiệu micro quá nhỏ hoặc đang bị tắt tiếng (MICROPHONE_LOW_SIGNAL). Vui lòng kiểm tra lại thiết bị thu âm.'
          } else if (heartbeatCount === 4) {
            notice =
              'Ứng dụng Kiosk không ở chế độ toàn màn hình (FULLSCREEN_EXIT). Tín hiệu micro quá nhỏ hoặc đang bị tắt tiếng (MICROPHONE_LOW_SIGNAL). Vui lòng kiểm tra lại thiết bị thu âm.'
          }
        }
        return jsonResponse({
          ticketId: 't-iter2',
          shiftId: 's1',
          ticketStatus: 'IN_PROGRESS',
          shiftStatus: 'in_progress',
          serverUtcNow: new Date().toISOString(),
          remainingShiftSeconds: 500,
          isLocked: false,
          deviceUnlockRequired: false,
          shouldTerminateExam: false,
          notice,
        })
      }
      if (urlStr.endsWith('/audio-upload-authorizations')) {
        return jsonResponse({
          objectKey: 'official/s1/t-iter2/q1_0.webm',
          fileName: '05_SE001_Q1.webm',
          uploadUrl: 'https://r2.example/t-iter2/q1',
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          requiredHeaders: { 'Content-Type': 'audio/webm', 'If-None-Match': '*' },
        })
      }
      if (urlStr === 'https://r2.example/t-iter2/q1') {
        return new Response(null, { status: 200 })
      }
      if (urlStr.endsWith('/questions/q1/answers')) {
        answerCalls += 1
        if (scenario === 'answer-409-submitted') {
          ticketStateSubmitted = true
          return jsonResponse(
            {
              status: 409,
              errorCode: 'TICKET_NOT_IN_PROGRESS',
              detail: 'Vé thi không ở trạng thái đang thi.',
            },
            409,
          )
        }
        if (scenario === 'deadline-locked') {
          return jsonResponse(
            {
              status: 409,
              type: 'https://oralexam.fpt.edu.vn/errors/ticket-locked',
              detail: 'TICKET_LOCKED',
            },
            409,
          )
        }
        return jsonResponse({
          submissionId: 'sub-iter2',
          ticketId: 't-iter2',
          examQuestionId: 'q1',
          followUpIndex: 0,
          audioObjectKey: 'official/s1/t-iter2/q1_0.webm',
          audioHashSha256: 'a'.repeat(64),
          status: 'RECORDED',
          canRequestFollowUp: false,
        })
      }
      if (urlStr.endsWith('/submission')) {
        submitExamCalls += 1
        if (scenario === 'submit-409-submitted') {
          ticketStateSubmitted = true
          return jsonResponse(
            {
              status: 409,
              errorCode: 'TICKET_NOT_IN_PROGRESS',
              detail: 'Vé thi không ở trạng thái đang thi.',
            },
            409,
          )
        }
        return jsonResponse({
          ticketId: 't-iter2',
          status: 'SUBMITTED',
          submittedAt: nowIso,
          submissionCount: 1,
          isKioskLocked: true,
        })
      }
      throw new Error(`Unexpected URL: ${urlStr}`)
    }

    const container = doc.createElement('div')
    doc.body.appendChild(container)
    const rootInstance = createRoot(container)

    try {
      await act(async () => {
        rootInstance.render(React.createElement(App))
      })
      await act(async () => {
        setInputValue(findById(container, 'username'), 'sv001')
        setInputValue(findById(container, 'password'), 'Password123!')
      })
      await act(async () => {
        await submitForm(findAll(container, (n) => n.tagName === 'FORM')[0])
        await new Promise((r) => setTimeout(r, 20))
      })
      await act(async () => {
        clickEl(findButton(container, 'Bắt đầu kiểm tra'))
        await new Promise((r) => setTimeout(r, 20))
      })
      await act(async () => {
        clickEl(findButton(container, 'Điểm danh và vào phòng chờ'))
        await new Promise((r) => setTimeout(r, 20))
      })
      await act(async () => {
        clickEl(findButton(container, 'Bắt đầu làm bài'))
        await new Promise((r) => setTimeout(r, 20))
      })

      if (scenario === 'answer-409-submitted') {
        await act(async () => {
          clickEl(findButton(container, 'Ghi âm'))
          await new Promise((r) => setTimeout(r, 10))
        })
        await act(async () => {
          clickEl(findAll(container, (n) => n.tagName === 'BUTTON' && n.getAttribute('aria-label') === 'Dừng ghi âm')[0])
          for (let i = 0; i < 40; i += 1) {
            await new Promise((r) => setTimeout(r, 25))
            if (container.textContent.includes('Bài làm đã được lưu an toàn')) break
          }
        })
        assert.match(container.textContent, /Bài làm đã được lưu an toàn/)
        assert.doesNotMatch(container.textContent, /Phiên thi đã tạm dừng/)
      } else if (scenario === 'submit-409-submitted') {
        await act(async () => {
          clickEl(findButton(container, 'Ghi âm'))
          await new Promise((r) => setTimeout(r, 10))
        })
        await act(async () => {
          clickEl(findAll(container, (n) => n.tagName === 'BUTTON' && n.getAttribute('aria-label') === 'Dừng ghi âm')[0])
          for (let i = 0; i < 40; i += 1) {
            await new Promise((r) => setTimeout(r, 25))
            if (container.textContent.includes('Đã hoàn thành toàn bộ câu hỏi')) break
          }
        })
        await act(async () => {
          clickEl(findButton(container, 'Nộp bài và khóa kiosk'))
          for (let i = 0; i < 40; i += 1) {
            await new Promise((r) => setTimeout(r, 25))
            if (container.textContent.includes('Bài làm đã được lưu an toàn')) break
          }
        })
        assert.match(container.textContent, /Bài làm đã được lưu an toàn/)
        assert.doesNotMatch(container.textContent, /Phiên thi đã tạm dừng/)
      } else if (scenario === 'deadline-locked') {
        await act(async () => {
          clickEl(findButton(container, 'Ghi âm'))
          await new Promise((r) => setTimeout(r, 10))
        })
        // Wait for deadline auto-submit to fire while recording === true
        await act(async () => {
          for (let i = 0; i < 60; i += 1) {
            await new Promise((r) => setTimeout(r, 40))
            if (container.textContent.includes('Phiên thi đã tạm dừng')) break
          }
        })
        assert.match(container.textContent, /Phiên thi đã tạm dừng/)
        assert.equal(answerCalls, 1, 'submitExam(true) must abort after completeQuestion(true) locks ticket on 409 TICKET_LOCKED')
        assert.equal(submitExamCalls, 0, 'submitExam(true) must not call /submission after lock')
      } else if (scenario === 'heartbeat-notice') {
        assert.equal(typeof heartbeatIntervalCb, 'function', 'Heartbeat interval callback must be registered')
        // Pulse 2: pure MICROPHONE_LOW_SIGNAL on 1st heartbeat -> debounced (suppressed)
        await act(async () => {
          heartbeatIntervalCb()
          for (let i = 0; i < 20; i += 1) {
            await new Promise((r) => setTimeout(r, 15))
            if (heartbeatCount >= 2) break
          }
        })
        assert.doesNotMatch(container.textContent, /MICROPHONE_LOW_SIGNAL/)

        // Pulse 3: clean heartbeat resets low-mic streak
        await act(async () => {
          heartbeatIntervalCb()
          for (let i = 0; i < 20; i += 1) {
            await new Promise((r) => setTimeout(r, 15))
            if (heartbeatCount >= 3) break
          }
        })

        // Pulse 4: combined FULLSCREEN_EXIT + MICROPHONE_LOW_SIGNAL -> surfaces FULLSCREEN_EXIT immediately
        await act(async () => {
          heartbeatIntervalCb()
          for (let i = 0; i < 20; i += 1) {
            await new Promise((r) => setTimeout(r, 15))
            if (container.textContent.includes('FULLSCREEN_EXIT')) break
          }
        })
        assert.match(container.textContent, /FULLSCREEN_EXIT/)
        assert.doesNotMatch(container.textContent, /MICROPHONE_LOW_SIGNAL/)
      }
    } finally {
      for (const timer of rafTimers.values()) clearTimeout(timer)
      rafTimers.clear()
      await act(async () => {
        rootInstance.unmount()
      })
      performance.now = origPerfNow
      globalThis.document = originals.document
      globalThis.window = originals.window
      if (origNavDesc) Object.defineProperty(globalThis, 'navigator', origNavDesc)
      globalThis.indexedDB = originals.indexedDB
      globalThis.fetch = originals.fetch
      globalThis.MediaRecorder = originals.MediaRecorder
      globalThis.AudioContext = originals.AudioContext
      globalThis.requestAnimationFrame = originals.requestAnimationFrame
      globalThis.cancelAnimationFrame = originals.cancelAnimationFrame
      globalThis.IS_REACT_ACT_ENVIRONMENT = originals.IS_REACT_ACT_ENVIRONMENT
      delete globalThis.HTMLInputElement
      delete globalThis.HTMLTextAreaElement
    }
  }

  await runAppScenario({ scenario: 'answer-409-submitted' })
  await runAppScenario({ scenario: 'submit-409-submitted' })
  await runAppScenario({ scenario: 'deadline-locked' })
  await runAppScenario({ scenario: 'heartbeat-notice' })
})
