import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import React from 'react'

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
      indexNames: { contains: (name) => storeDef.indexes.has(name) },
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
          objectStoreNames: { contains: (storeName) => dbState.stores.has(storeName) },
          createObjectStore(storeName, opts) {
            const storeDef = { keyPath: opts.keyPath, indexes: new Map(), records: new Map() }
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

function createFakeDomEnvironment() {
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
        for (const item of [...child.childNodes]) this.insertBefore(item, refChild)
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

  const findAll = (rootNode, predicate, out = []) => {
    if (predicate(rootNode)) out.push(rootNode)
    for (const child of rootNode.childNodes ?? []) findAll(child, predicate, out)
    return out
  }

  return {
    doc,
    FakeElement,
    findAll,
    findById: (rootNode, id) => findAll(rootNode, (n) => n.id === id)[0],
    findButton: (rootNode, label) =>
      findAll(rootNode, (n) => n.tagName === 'BUTTON' && n.textContent.includes(label))[0],
    setInputValue(el, value) {
      const reactPropsKey = Object.keys(el).find((k) => k.startsWith('__reactProps$'))
      el.value = value
      if (reactPropsKey && el[reactPropsKey]?.onChange) {
        el[reactPropsKey].onChange({ target: el, currentTarget: el })
      }
    },
    clickEl(el) {
      const reactPropsKey = Object.keys(el).find((k) => k.startsWith('__reactProps$'))
      if (reactPropsKey && el[reactPropsKey]?.onClick) {
        return el[reactPropsKey].onClick({ preventDefault: () => {}, target: el, currentTarget: el })
      }
      el.dispatchEvent({ type: 'click', bubbles: true, cancelable: true })
      return undefined
    },
    submitForm(formEl) {
      const reactPropsKey = Object.keys(formEl).find((k) => k.startsWith('__reactProps$'))
      if (reactPropsKey && formEl[reactPropsKey]?.onSubmit) {
        return formEl[reactPropsKey].onSubmit({ preventDefault: () => {}, target: formEl, currentTarget: formEl })
      }
      formEl.dispatchEvent({ type: 'submit', bubbles: true, cancelable: true })
      return undefined
    },
  }
}

test('B4: packaged mode unconditionally locks getApiBaseUrl() to production HTTPS endpoint and ignores KIOSK_API_BASE_URL', () => {
  const Module = require('node:module')
  const originalLoad = Module._load
  const originalEnvUrl = process.env.KIOSK_API_BASE_URL
  const configPath = path.join(root, 'node_modules', '.tmp', 'test-dist-electron', 'config.js')

  let mockIsPackaged = true
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron/main') {
      return {
        app: {
          get isPackaged() {
            return mockIsPackaged
          },
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }

  try {
    delete require.cache[configPath]
    const configMod = require(configPath)

    mockIsPackaged = true
    process.env.KIOSK_API_BASE_URL = 'http://127.0.0.1:5000/api/v1'
    assert.equal(configMod.getApiBaseUrl(), 'https://oralexam.io.vn/api/v1')

    process.env.KIOSK_API_BASE_URL = 'https://attacker-mitm.example.com/api/v1'
    assert.equal(configMod.getApiBaseUrl(), 'https://oralexam.io.vn/api/v1')

    process.env.KIOSK_API_BASE_URL = 'http://evil.local/api/v1'
    assert.equal(configMod.getApiBaseUrl(), 'https://oralexam.io.vn/api/v1')

    delete process.env.KIOSK_API_BASE_URL
    assert.equal(configMod.getApiBaseUrl(), 'https://oralexam.io.vn/api/v1')

    // Unpackaged dev mode still honors valid KIOSK_API_BASE_URL and rejects non-HTTP(S) schemes
    mockIsPackaged = false
    process.env.KIOSK_API_BASE_URL = 'http://127.0.0.1:5000/api/v1/'
    assert.equal(configMod.getApiBaseUrl(), 'http://127.0.0.1:5000/api/v1')

    process.env.KIOSK_API_BASE_URL = 'file:///C:/Windows/System32'
    assert.equal(configMod.getApiBaseUrl(), 'http://127.0.0.1:5000/api/v1')
  } finally {
    Module._load = originalLoad
    if (originalEnvUrl === undefined) delete process.env.KIOSK_API_BASE_URL
    else process.env.KIOSK_API_BASE_URL = originalEnvUrl
  }
})

test('B5: cold-start device ID stays consistent across late WindowsAgent probe and full process restart (no 409 DEVICE_MISMATCH)', () => {
  const tmpBase = path.join(root, 'node_modules', '.tmp')
  mkdirSync(tmpBase, { recursive: true })
  const tempUserData = mkdtempSync(path.join(tmpBase, 'oes-kiosk-b5-'))
  const Module = require('node:module')
  const originalLoad = Module._load
  const devicePath = path.join(root, 'node_modules', '.tmp', 'test-dist-electron', 'device.js')

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron/main') {
      return {
        app: {
          isPackaged: true,
          getPath: () => tempUserData,
        },
        safeStorage: {
          isEncryptionAvailable: () => true,
          encryptString: (str) => Buffer.from(`dpapi:${str}`, 'utf8'),
          decryptString: (buf) => {
            const text = buf.toString('utf8')
            if (!text.startsWith('dpapi:')) throw new Error('bad cipher')
            return text.slice('dpapi:'.length)
          },
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }

  try {
    delete require.cache[devicePath]
    const deviceMod = require(devicePath)
    deviceMod.resetCachedDeviceId()

    // Scenario A: Extreme cold-start timeout on Launch 1 -> fallback UUID persisted
    const launch1RuntimeDeviceId = deviceMod.getOrCreatePersistentDeviceId(null)
    assert.match(launch1RuntimeDeviceId, /^oes-[a-z0-9]+-[0-9a-f-]{36}$/)

    // Later during Launch 1 PreCheck / Heartbeat, Oes.WindowsAgent warms up and reports hardware fingerprint.
    // Disk & cached deviceId MUST NOT be silently overwritten out-of-band.
    const lateHardwareFingerprint = 'oes-win-aaaa1111bbbb2222cccc3333dddd4444'
    const launch1SnapshotDeviceId = deviceMod.getOrCreatePersistentDeviceId(lateHardwareFingerprint)
    assert.equal(launch1SnapshotDeviceId, launch1RuntimeDeviceId)
    assert.equal(
      readFileSync(path.join(tempUserData, 'kiosk-device-id.dat'), 'utf8'),
      `dpapi:${launch1RuntimeDeviceId}`,
    )

    // Launch 2 (full process restart on the exact same laptop, agent now fast and returns hardware fingerprint):
    deviceMod.resetCachedDeviceId()
    const launch2RuntimeDeviceId = deviceMod.getOrCreatePersistentDeviceId(lateHardwareFingerprint)
    assert.equal(
      launch2RuntimeDeviceId,
      launch1RuntimeDeviceId,
      'Restart must preserve the persisted device ID bound to DB ticket',
    )

    // Scenario B: Clean laptop where agent succeeds within cold-start window -> persists hardware fingerprint & survives agent failure on restart
    const cleanUserData = mkdtempSync(path.join(tmpBase, 'oes-kiosk-b5-clean-'))
    try {
      const adapter = {
        userDataDir: cleanUserData,
        platform: 'win32',
        isEncryptionAvailable: () => true,
        encryptString: (str) => Buffer.from(`dpapi:${str}`, 'utf8'),
        decryptString: (buf) => buf.toString('utf8').replace(/^dpapi:/, ''),
      }
      const initialHw = deviceMod.resolveDeviceIdWithAdapter(adapter, lateHardwareFingerprint, {
        allowOverwriteExisting: false,
      })
      assert.equal(initialHw, lateHardwareFingerprint)

      const restartWithoutAgent = deviceMod.resolveDeviceIdWithAdapter(adapter, null, {
        allowOverwriteExisting: false,
      })
      assert.equal(restartWithoutAgent, lateHardwareFingerprint)
    } finally {
      rmSync(cleanUserData, { recursive: true, force: true })
    }

    // Verify cold-start startupTimeoutMs increased >= 8000ms for single-file .NET 8 extraction
    const agentSource = read('electron/windows-agent.ts')
    const timeoutMatch = agentSource.match(/DEFAULT_STARTUP_TIMEOUT_MS\s*=\s*([0-9_]+)/)
    assert.ok(timeoutMatch, 'DEFAULT_STARTUP_TIMEOUT_MS must be defined')
    const parsedTimeout = Number(timeoutMatch[1].replaceAll('_', ''))
    assert.ok(parsedTimeout >= 8000, `Expected startup timeout >= 8000ms, got ${parsedTimeout}`)
  } finally {
    Module._load = originalLoad
    rmSync(tempUserData, { recursive: true, force: true })
  }
})

test('B5: SignInScreen gates login until runtime-info resolves and preserves auth tokens when deviceId syncs before checkIn', async () => {
  const { createRoot } = require('react-dom/client')
  const { act } = require('react')
  const App = require('../node_modules/.tmp/test-dist/App.js').default

  const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const originals = {
    document: globalThis.document,
    window: globalThis.window,
    indexedDB: globalThis.indexedDB,
    fetch: globalThis.fetch,
    AudioContext: globalThis.AudioContext,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }

  const dom = createFakeDomEnvironment()
  let resolveRuntimeInfo
  const runtimeInfoPromise = new Promise((resolve) => {
    resolveRuntimeInfo = resolve
  })

  let rafId = 0
  let fakePerfNow = 1000
  const origPerfNow = performance.now.bind(performance)
  performance.now = () => fakePerfNow
  const rafTimers = new Map()

  const fakeWindow = {
    document: dom.doc,
    HTMLElement: dom.FakeElement,
    HTMLInputElement: dom.FakeElement,
    HTMLTextAreaElement: dom.FakeElement,
    HTMLIFrameElement: class FakeHTMLIFrameElement {},
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener: () => {},
    removeEventListener: () => {},
    kioskApi: {
      getRuntimeInfo: () => runtimeInfoPromise,
      getSecuritySnapshot: async () => ({
        deviceId: 'oes-win-synced9999888877776666',
        displayCount: 1,
        isFullscreen: true,
        windowsAgent: {
          deviceFingerprint: 'oes-win-synced9999888877776666',
          displayCount: 1,
          vmDetected: false,
          vmIndicators: [],
          remoteControlDetected: false,
          remoteControlProcesses: [],
          disallowedProcesses: [],
          probedAtUtc: new Date().toISOString(),
        },
      }),
      authorizeExitAfterSubmit: async () => true,
      requestExit: async () => true,
      onSecurityEvent: () => () => {},
    },
  }
  dom.doc.defaultView = fakeWindow

  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.document = dom.doc
  globalThis.window = fakeWindow
  globalThis.HTMLInputElement = dom.FakeElement
  globalThis.HTMLTextAreaElement = dom.FakeElement
  globalThis.indexedDB = createFakeIndexedDb()
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
      return { fftSize: 2048, getByteTimeDomainData: (arr) => arr.fill(160) }
    }
    createMediaStreamSource() {
      return { connect() {} }
    }
    close() {
      return Promise.resolve()
    }
  }

  const fetchCalls = []
  const nowIso = new Date().toISOString()
  const endIso = new Date(Date.now() + 600_000).toISOString()

  globalThis.fetch = async (url, init = {}) => {
    const urlStr = String(url)
    fetchCalls.push({ url: urlStr, headers: init.headers ?? {}, body: init.body })
    if (urlStr === 'https://oralexam.io.vn/api/v1/auth/kiosk/password-login') {
      return jsonResponse({
        accessToken: 'acc-live-1',
        refreshToken: 'ref-live-1',
        tokenType: 'Bearer',
        expiresIn: 900,
        mustChangePassword: false,
        user: { id: 'u1', email: 'sv@fpt.edu.vn', fullName: 'SV Test', role: 'student' },
      })
    }
    if (urlStr === 'https://oralexam.io.vn/api/v1/official-exams/tickets/current') {
      return jsonResponse({
        id: 't-sync',
        shiftId: 's1',
        shiftName: 'Ca 1',
        roomLab: 'P201',
        startTime: nowIso,
        endTime: endIso,
        shiftStatus: 'scheduled',
        sessionTitle: 'Thi cuoi ky',
        studentId: 'u1',
        seatNumber: 5,
        status: 'SCHEDULED',
        examSetId: 'set1',
        examSetCode: 'DE01',
        examInputMode: 'VoiceOnly',
        transcriptBufferSeconds: 60,
        hasFollowUp: false,
        maxFollowUpQuestions: 0,
        serverNowUtc: nowIso,
        questions: [],
      })
    }
    if (urlStr === 'https://oralexam.io.vn/api/v1/official-exams/tickets/t-sync/check-in') {
      return jsonResponse({
        id: 't-sync',
        shiftId: 's1',
        studentId: 'u1',
        seatNumber: 5,
        ipAddress: '127.0.0.1',
        status: 'IN_PROGRESS',
        checkedInAt: nowIso,
        examSetId: 'set1',
        activeSessionToken: 'kiosk-sess-synced',
      })
    }
    if (urlStr === 'https://oralexam.io.vn/api/v1/official-exams/tickets/t-sync') {
      return jsonResponse({
        ticketId: 't-sync',
        shiftId: 's1',
        status: 'IN_PROGRESS',
        isExamPublished: false,
        isKioskLocked: false,
        violationCount: 0,
        maxViolations: 3,
        lockThreshold: 4,
        remainingStrikes: 4,
        serverNowUtc: nowIso,
        deviceId: 'oes-win-synced9999888877776666',
        deviceLockedAt: nowIso,
        deviceUnlockCount: 0,
        followUps: [],
      })
    }
    if (urlStr.endsWith('/heartbeat')) {
      return jsonResponse({
        ticketId: 't-sync',
        shiftId: 's1',
        ticketStatus: 'IN_PROGRESS',
        shiftStatus: 'scheduled',
        serverUtcNow: nowIso,
        remainingShiftSeconds: 600,
        isLocked: false,
        deviceUnlockRequired: false,
        shouldTerminateExam: false,
        notice: null,
      })
    }
    throw new Error(`Unexpected fetch URL: ${urlStr}`)
  }

  const container = dom.doc.createElement('div')
  dom.doc.body.appendChild(container)
  const rootInstance = createRoot(container)

  try {
    await act(async () => {
      rootInstance.render(React.createElement(App))
    })

    // While runtime-info is still pending, SignInScreen MUST render loading gate and hide login form
    assert.match(container.textContent, /Đang khởi tạo môi trường Kiosk/)
    assert.equal(dom.findById(container, 'username'), undefined, 'Login input must be gated until runtimeReady')
    assert.equal(fetchCalls.length, 0)

    // Resolve runtime-info with production URL and initial device ID
    await act(async () => {
      resolveRuntimeInfo({
        appName: 'Oral Exam Desktop Kiosk',
        appVersion: '0.1.1',
        isPackaged: true,
        isKioskMode: true,
        altTabTestMode: false,
        platform: 'win32',
        apiBaseUrl: 'https://oralexam.io.vn/api/v1',
        deviceId: 'oes-win-initial1111222233334444',
        kioskVersion: 'desktop-kiosk-0.1.1',
        displayCount: 1,
        isFullscreen: true,
        windowsAgentAvailable: true,
      })
      await new Promise((r) => setTimeout(r, 10))
    })

    assert.ok(dom.findById(container, 'username'), 'Login form must appear once runtimeReady is true')

    // Login -> lands on PreCheckScreen where getSecuritySnapshot returns synced deviceId
    await act(async () => {
      dom.setInputValue(dom.findById(container, 'username'), 'sv001')
      dom.setInputValue(dom.findById(container, 'password'), 'Password123!')
    })
    await act(async () => {
      const form = dom.findAll(container, (n) => n.tagName === 'FORM')[0]
      await dom.submitForm(form)
      await new Promise((r) => setTimeout(r, 20))
    })

    const loginCall = fetchCalls.find((c) => c.url.endsWith('/auth/kiosk/password-login'))
    assert.ok(loginCall)
    assert.equal(loginCall.headers['X-Device-Id'], 'oes-win-initial1111222233334444')

    // Run mic test & check-in: auth token MUST still be intact and checkIn MUST send the synced deviceId
    await act(async () => {
      dom.clickEl(dom.findButton(container, 'Bắt đầu kiểm tra'))
      await new Promise((r) => setTimeout(r, 20))
    })
    await act(async () => {
      dom.clickEl(dom.findButton(container, 'Điểm danh và vào phòng chờ'))
      await new Promise((r) => setTimeout(r, 20))
    })

    const checkInCall = fetchCalls.find((c) => c.url.endsWith('/check-in'))
    assert.ok(checkInCall, 'check-in must succeed without losing auth tokens after deviceId sync')
    assert.equal(checkInCall.headers.Authorization, 'Bearer acc-live-1')
    assert.equal(checkInCall.headers['X-Device-Id'], 'oes-win-synced9999888877776666')
    assert.equal(JSON.parse(checkInCall.body).deviceId, 'oes-win-synced9999888877776666')
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
    globalThis.AudioContext = originals.AudioContext
    globalThis.requestAnimationFrame = originals.requestAnimationFrame
    globalThis.cancelAnimationFrame = originals.cancelAnimationFrame
    globalThis.IS_REACT_ACT_ENVIRONMENT = originals.IS_REACT_ACT_ENVIRONMENT
    delete globalThis.HTMLInputElement
    delete globalThis.HTMLTextAreaElement
  }
})

test('R3: LOCKED ticket preserves BlockedScreen on login, recovers to PreCheckScreen after EO unlock, and supports return to sign-in', async () => {
  const { createRoot } = require('react-dom/client')
  const { act } = require('react')
  const App = require('../node_modules/.tmp/test-dist/App.js').default

  const originals = {
    document: globalThis.document,
    window: globalThis.window,
    indexedDB: globalThis.indexedDB,
    fetch: globalThis.fetch,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }

  const dom = createFakeDomEnvironment()
  const fakeWindow = {
    document: dom.doc,
    HTMLElement: dom.FakeElement,
    HTMLInputElement: dom.FakeElement,
    HTMLTextAreaElement: dom.FakeElement,
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
        isPackaged: true,
        isKioskMode: true,
        altTabTestMode: false,
        platform: 'win32',
        apiBaseUrl: 'https://oralexam.io.vn/api/v1',
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
          probedAtUtc: new Date().toISOString(),
        },
      }),
      authorizeExitAfterSubmit: async () => true,
      requestExit: async () => true,
      onSecurityEvent: () => () => {},
    },
  }
  dom.doc.defaultView = fakeWindow

  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  globalThis.document = dom.doc
  globalThis.window = fakeWindow
  globalThis.HTMLInputElement = dom.FakeElement
  globalThis.HTMLTextAreaElement = dom.FakeElement
  globalThis.indexedDB = createFakeIndexedDb()

  let ticketLockedOnServer = true
  const nowIso = new Date().toISOString()
  const endIso = new Date(Date.now() + 600_000).toISOString()

  globalThis.fetch = async (url) => {
    const urlStr = String(url)
    if (urlStr.endsWith('/auth/kiosk/password-login')) {
      return jsonResponse({
        accessToken: 'acc-r3',
        refreshToken: 'ref-r3',
        tokenType: 'Bearer',
        expiresIn: 900,
        mustChangePassword: false,
        user: { id: 'u1', email: 'sv@fpt.edu.vn', fullName: 'SV Locked', role: 'student' },
      })
    }
    if (urlStr.endsWith('/official-exams/tickets/current')) {
      return jsonResponse({
        id: 't-locked',
        shiftId: 's1',
        shiftName: 'Ca 1',
        roomLab: 'P201',
        startTime: nowIso,
        endTime: endIso,
        shiftStatus: 'in_progress',
        sessionTitle: 'Thi cuoi ky',
        studentId: 'u1',
        seatNumber: 3,
        status: ticketLockedOnServer ? 'LOCKED' : 'IN_PROGRESS',
        examSetId: 'set1',
        examSetCode: 'DE01',
        examInputMode: 'VoiceOnly',
        transcriptBufferSeconds: 60,
        hasFollowUp: false,
        maxFollowUpQuestions: 0,
        serverNowUtc: nowIso,
        questions: [],
      })
    }
    if (urlStr.endsWith('/official-exams/tickets/t-locked')) {
      return jsonResponse({
        ticketId: 't-locked',
        shiftId: 's1',
        status: ticketLockedOnServer ? 'LOCKED' : 'IN_PROGRESS',
        isExamPublished: true,
        isKioskLocked: ticketLockedOnServer,
        violationCount: ticketLockedOnServer ? 4 : 0,
        maxViolations: 3,
        lockThreshold: 4,
        remainingStrikes: ticketLockedOnServer ? 0 : 4,
        serverNowUtc: nowIso,
        deviceId: 'oes-win-1234567890abcdef',
        deviceLockedAt: nowIso,
        deviceUnlockCount: ticketLockedOnServer ? 0 : 1,
        followUps: [],
      })
    }
    throw new Error(`Unexpected fetch URL: ${urlStr}`)
  }

  const container = dom.doc.createElement('div')
  dom.doc.body.appendChild(container)
  const rootInstance = createRoot(container)

  try {
    await act(async () => {
      rootInstance.render(React.createElement(App))
      await new Promise((r) => setTimeout(r, 10))
    })

    // 1) Sign in with LOCKED ticket -> MUST stay on BlockedScreen, NOT overwrite with PreCheckScreen
    await act(async () => {
      dom.setInputValue(dom.findById(container, 'username'), 'sv001')
      dom.setInputValue(dom.findById(container, 'password'), 'Password123!')
    })
    await act(async () => {
      const form = dom.findAll(container, (n) => n.tagName === 'FORM')[0]
      await dom.submitForm(form)
      await new Promise((r) => setTimeout(r, 15))
    })

    assert.match(container.textContent, /Phiên thi đã tạm dừng/)
    assert.doesNotMatch(container.textContent, /Kiểm tra thiết bị trước giờ thi/)
    assert.ok(dom.findButton(container, 'Kiểm tra lại trạng thái vé'))
    assert.ok(dom.findButton(container, 'Quay về đăng nhập'))

    // 2) While still LOCKED on server, checking status keeps BlockedScreen
    await act(async () => {
      await dom.clickEl(dom.findButton(container, 'Kiểm tra lại trạng thái vé'))
      await new Promise((r) => setTimeout(r, 15))
    })
    assert.match(container.textContent, /Vé thi vẫn đang bị khóa trên máy chủ/)
    assert.match(container.textContent, /Phiên thi đã tạm dừng/)

    // 3) EO unlocks ticket -> clicking "Kiểm tra lại trạng thái vé" transitions cleanly to PreCheckScreen
    ticketLockedOnServer = false
    await act(async () => {
      await dom.clickEl(dom.findButton(container, 'Kiểm tra lại trạng thái vé'))
      await new Promise((r) => setTimeout(r, 15))
    })
    assert.match(container.textContent, /Kiểm tra thiết bị trước giờ thi/)
    assert.match(container.textContent, /Vé thi đã được mở khóa từ máy chủ/)

    // 4) Re-lock and verify "Quay về đăng nhập" recovery button returns cleanly to SignInScreen
    ticketLockedOnServer = true
    await act(async () => {
      rootInstance.unmount()
    })
    const rootInstance2 = createRoot(container)
    try {
      await act(async () => {
        rootInstance2.render(React.createElement(App))
        await new Promise((r) => setTimeout(r, 10))
      })
      await act(async () => {
        dom.setInputValue(dom.findById(container, 'username'), 'sv001')
        dom.setInputValue(dom.findById(container, 'password'), 'Password123!')
      })
      await act(async () => {
        const form = dom.findAll(container, (n) => n.tagName === 'FORM')[0]
        await dom.submitForm(form)
        await new Promise((r) => setTimeout(r, 15))
      })
      assert.match(container.textContent, /Phiên thi đã tạm dừng/)

      await act(async () => {
        dom.clickEl(dom.findButton(container, 'Quay về đăng nhập'))
      })
      assert.match(container.textContent, /Đăng nhập phòng thi/)
      assert.ok(dom.findById(container, 'username'))
    } finally {
      await act(async () => {
        rootInstance2.unmount()
      })
    }
  } finally {
    globalThis.document = originals.document
    globalThis.window = originals.window
    globalThis.indexedDB = originals.indexedDB
    globalThis.fetch = originals.fetch
    globalThis.IS_REACT_ACT_ENVIRONMENT = originals.IS_REACT_ACT_ENVIRONMENT
    delete globalThis.HTMLInputElement
    delete globalThis.HTMLTextAreaElement
  }
})

test('R7: upload-audio-to-r2 enforces strict *.r2.cloudflarestorage.com allowlist in packaged builds', async () => {
  const Module = require('node:module')
  const originalLoad = Module._load
  const originalResourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  const configPath = path.join(root, 'node_modules', '.tmp', 'test-dist-electron', 'config.js')
  const mainBundlePath = path.join(root, 'dist-electron', 'main.cjs')
  const ipcHandlers = new Map()
  const appListeners = new Map()
  const fetchedUrls = []
  let whenReadyCallback = null
  const fakeWindow = {
    isDestroyed: () => false,
    isFullScreen: () => true,
    isMinimized: () => false,
    isKiosk: () => true,
    setFullScreen: () => {},
    setKiosk: () => {},
    setAlwaysOnTop: () => {},
    focus: () => {},
    show: () => {},
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

  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: path.join(root, 'node_modules', '.tmp', 'nonexistent-resources'),
  })

  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron/main') {
      return {
        app: {
          isPackaged: true,
          getVersion: () => '0.1.1',
          getPath: () => path.join(root, 'node_modules', '.tmp'),
          quit: () => {},
          whenReady: () => ({
            then: (fn) => {
              whenReadyCallback = fn
              return Promise.resolve()
            },
          }),
          on: (evt, fn) => {
            appListeners.set(evt, fn)
          },
        },
        BrowserWindow: Object.assign(
          function FakeBrowserWindow() {
            return fakeWindow
          },
          { getAllWindows: () => [fakeWindow] },
        ),
        ipcMain: {
          handle: (channel, fn) => {
            ipcHandlers.set(channel, fn)
          },
        },
        Menu: { setApplicationMenu: () => {} },
        net: {
          fetch: async (url) => {
            fetchedUrls.push(String(url))
            return new Response(null, { status: 200, statusText: 'OK' })
          },
        },
        safeStorage: {
          isEncryptionAvailable: () => false,
          encryptString: (s) => Buffer.from(s),
          decryptString: (b) => b.toString('utf8'),
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
    delete require.cache[configPath]
    const { isAllowedR2UploadHostname } = require(configPath)

    // Packaged mode strictly allows *.r2.cloudflarestorage.com only
    assert.equal(isAllowedR2UploadHostname('oral-exam-bucket.abc123.r2.cloudflarestorage.com', true), true)
    assert.equal(isAllowedR2UploadHostname('bucket.r2.cloudflarestorage.com', true), true)
    assert.equal(isAllowedR2UploadHostname('r2.cloudflarestorage.com', true), false)
    assert.equal(isAllowedR2UploadHostname('evil-r2.cloudflarestorage.com', true), false)
    assert.equal(isAllowedR2UploadHostname('r2.cloudflarestorage.com.evil.com', true), false)
    assert.equal(isAllowedR2UploadHostname('127.0.0.1', true), false)
    assert.equal(isAllowedR2UploadHostname('localhost', true), false)
    assert.equal(isAllowedR2UploadHostname('host.docker.internal', true), false)
    assert.equal(isAllowedR2UploadHostname('evil.example.com', true), false)

    // Dev mode additionally allows localhost / 127.0.0.1 / host.docker.internal
    assert.equal(isAllowedR2UploadHostname('127.0.0.1', false), true)
    assert.equal(isAllowedR2UploadHostname('localhost', false), true)
    assert.equal(isAllowedR2UploadHostname('host.docker.internal', false), true)
    assert.equal(isAllowedR2UploadHostname('bucket.r2.cloudflarestorage.com', false), true)
    assert.equal(isAllowedR2UploadHostname('evil.example.com', false), false)

    // Invoke real IPC handler from compiled dist-electron/main.cjs
    if (existsSync(mainBundlePath)) {
      delete require.cache[mainBundlePath]
      require(mainBundlePath)
      assert.ok(whenReadyCallback)
      await whenReadyCallback()

      const uploadHandler = ipcHandlers.get('upload-audio-to-r2')
      assert.ok(uploadHandler, 'upload-audio-to-r2 IPC handler must be registered')

      const fakeEvent = { sender: fakeWindow.webContents }
      const audioBytes = new Uint8Array([1, 2, 3, 4]).buffer

      const blockedLocal = await uploadHandler(fakeEvent, {
        uploadUrl: 'https://127.0.0.1:9000/bucket/test.webm',
        headers: { 'Content-Type': 'audio/webm' },
        data: audioBytes,
      })
      assert.equal(blockedLocal.ok, false)
      assert.equal(blockedLocal.status, 403)

      const blockedEvil = await uploadHandler(fakeEvent, {
        uploadUrl: 'https://evil.example.com/bucket/test.webm',
        headers: { 'Content-Type': 'audio/webm' },
        data: audioBytes,
      })
      assert.equal(blockedEvil.ok, false)
      assert.equal(blockedEvil.status, 403)

      const blockedCleartext = await uploadHandler(fakeEvent, {
        uploadUrl: 'http://bucket.r2.cloudflarestorage.com/test.webm',
        headers: { 'Content-Type': 'audio/webm' },
        data: audioBytes,
      })
      assert.equal(blockedCleartext.ok, false)
      assert.equal(blockedCleartext.status, 400)
      assert.equal(fetchedUrls.length, 0, 'Blocked URLs must never reach net.fetch')

      const allowedR2 = await uploadHandler(fakeEvent, {
        uploadUrl: 'https://oral-exam-bucket.acct123.r2.cloudflarestorage.com/official/a.webm?X-Amz-Signature=ok',
        headers: { 'Content-Type': 'audio/webm' },
        data: audioBytes,
      })
      assert.equal(allowedR2.ok, true)
      assert.equal(allowedR2.status, 200)
      assert.equal(fetchedUrls.length, 1)
    }
  } finally {
    appListeners.get('before-quit')?.()
    Module._load = originalLoad
    if (originalResourcesPath) {
      Object.defineProperty(process, 'resourcesPath', originalResourcesPath)
    } else {
      delete process.resourcesPath
    }
  }
})

test('B6 & R7: release packaging config, workflow wildcard, gitignore, lockfile version, and verify script order are aligned', () => {
  const pkg = JSON.parse(read('package.json'))
  const lock = JSON.parse(read('package-lock.json'))
  const releaseYml = read('.github/workflows/release.yml')
  const gitignore = read('.gitignore')
  const verifyScript = read('scripts/verify-kiosk.mjs')

  // B6: electron-builder outputs to release/ and PowerShell wildcard matches *.exe + *.blockmap
  assert.equal(pkg.build?.directories?.output, 'release')
  assert.match(releaseYml, /Get-ChildItem -Path "release\\\*" -File -Include \*\.exe,\*\.blockmap/)
  assert.match(releaseYml, /release\/\*\.exe/)
  assert.match(releaseYml, /release\/\*\.blockmap/)
  assert.match(releaseYml, /release\/SHA256SUMS\.txt/)

  // B6: .gitignore hygiene
  for (const pattern of ['release/', '.env*', '*.pfx', '*.p12', '.vscode/']) {
    assert.ok(gitignore.includes(pattern), `.gitignore must include ${pattern}`)
  }

  // R7: package-lock.json version matches package.json
  assert.equal(lock.version, pkg.version)
  assert.equal(lock.packages?.['']?.version, pkg.version)

  // R7: verify-kiosk.mjs builds Oes.WindowsAgent before running npm test
  const dotnetBuildIdx = verifyScript.indexOf("'Build native/Oes.WindowsAgent (.NET 8)'")
  const npmTestIdx = verifyScript.indexOf("'Contract & unit tests'")
  assert.ok(dotnetBuildIdx > 0 && npmTestIdx > 0)
  assert.ok(dotnetBuildIdx < npmTestIdx, 'verify-kiosk.mjs must build Oes.WindowsAgent BEFORE running unit tests')
})

test('M4 Security: upload-audio-to-r2 enforces redirect error, bounds, URL credentials/port, header allowlist, single-instance lock, and audio-only media permission', async () => {
  const Module = require('node:module')
  const originalLoad = Module._load
  const mainBundlePath = path.join(root, 'dist-electron', 'main.cjs')
  assert.ok(existsSync(mainBundlePath), 'dist-electron/main.cjs must exist during verify')

  const setupMain = ({ singleInstanceLockResult = true, isPackaged = true } = {}) => {
    const ipcHandlers = new Map()
    const appListeners = new Map()
    const fetchCalls = []
    let quitCount = 0
    let whenReadyCallback = null
    let permissionRequestHandler = null
    let permissionCheckHandler = null
    let enforceCount = 0
    const fakeWindow = {
      isDestroyed: () => false,
      isFullScreen: () => false,
      isMinimized: () => true,
      isKiosk: () => false,
      restore: () => {
        enforceCount += 1
      },
      setFullScreen: () => {
        enforceCount += 1
      },
      setKiosk: () => {},
      setAlwaysOnTop: () => {},
      focus: () => {
        enforceCount += 1
      },
      show: () => {},
      webContents: {
        id: 1,
        send: () => {},
        setWindowOpenHandler: () => {},
        on: () => {},
      },
      once: () => {},
      on: () => {},
      loadURL: async () => {},
      loadFile: async () => {},
    }

    Module._load = function patchedLoad(request) {
      if (request === 'electron/main') {
        return {
          app: {
            isPackaged,
            getVersion: () => '0.1.1',
            getPath: () => path.join(root, 'node_modules', '.tmp'),
            requestSingleInstanceLock: () => singleInstanceLockResult,
            quit: () => {
              quitCount += 1
            },
            whenReady: () => ({
              then: (fn) => {
                whenReadyCallback = fn
                return Promise.resolve()
              },
            }),
            on: (evt, fn) => {
              appListeners.set(evt, fn)
            },
          },
          BrowserWindow: Object.assign(
            function FakeBrowserWindow() {
              return fakeWindow
            },
            { getAllWindows: () => [fakeWindow] },
          ),
          ipcMain: {
            handle: (channel, fn) => {
              ipcHandlers.set(channel, fn)
            },
          },
          Menu: { setApplicationMenu: () => {} },
          net: {
            fetch: async (url, init) => {
              fetchCalls.push({ url: String(url), init })
              return new Response(null, { status: 200, statusText: 'OK' })
            },
          },
          safeStorage: {
            isEncryptionAvailable: () => false,
            encryptString: (s) => Buffer.from(s),
            decryptString: (b) => b.toString('utf8'),
          },
          screen: {
            getAllDisplays: () => [{ id: 1 }],
            on: () => {},
            removeListener: () => {},
          },
          session: {
            defaultSession: {
              webRequest: { onBeforeSendHeaders: () => {}, onHeadersReceived: () => {} },
              setPermissionRequestHandler: (fn) => {
                permissionRequestHandler = fn
              },
              setPermissionCheckHandler: (fn) => {
                permissionCheckHandler = fn
              },
            },
          },
        }
      }
      return originalLoad.apply(this, arguments)
    }

    delete require.cache[mainBundlePath]
    require(mainBundlePath)
    return {
      ipcHandlers,
      appListeners,
      fetchCalls,
      fakeWindow,
      getQuitCount: () => quitCount,
      getWhenReady: () => whenReadyCallback,
      getPermissionRequestHandler: () => permissionRequestHandler,
      getPermissionCheckHandler: () => permissionCheckHandler,
      getEnforceCount: () => enforceCount,
    }
  }

  try {
    // 1. Single-instance lock failure quits immediately without running whenReady
    {
      const env = setupMain({ singleInstanceLockResult: false })
      assert.equal(env.getQuitCount(), 1)
      assert.equal(env.getWhenReady(), null)
    }

    // 2. Single-instance lock success: test second-instance, permissions, and R2 IPC hardening
    {
      const env = setupMain({ singleInstanceLockResult: true, isPackaged: true })
      assert.equal(env.getQuitCount(), 0)
      const ready = env.getWhenReady()
      assert.ok(ready)
      await ready()

      // second-instance re-enforces window
      env.appListeners.get('second-instance')?.()
      assert.ok(env.getEnforceCount() > 0)

      // Media permissions: audio allowed, video denied, untrusted denied
      const reqHandler = env.getPermissionRequestHandler()
      const chkHandler = env.getPermissionCheckHandler()
      assert.ok(reqHandler && chkHandler)

      let reqAudioAllowed = null
      reqHandler(env.fakeWindow.webContents, 'media', (res) => {
        reqAudioAllowed = res
      }, { mediaTypes: ['audio'] })
      assert.equal(reqAudioAllowed, true)

      let reqVideoAllowed = null
      reqHandler(env.fakeWindow.webContents, 'media', (res) => {
        reqVideoAllowed = res
      }, { mediaTypes: ['video'] })
      assert.equal(reqVideoAllowed, false)

      let reqUntrustedAllowed = null
      reqHandler({ id: 999 }, 'media', (res) => {
        reqUntrustedAllowed = res
      }, { mediaTypes: ['audio'] })
      assert.equal(reqUntrustedAllowed, false)

      assert.equal(chkHandler(env.fakeWindow.webContents, 'media', 'file://', { mediaTypes: ['audio'] }), true)
      assert.equal(chkHandler(env.fakeWindow.webContents, 'media', 'file://', { mediaTypes: ['audio', 'video'] }), false)
      assert.equal(chkHandler(env.fakeWindow.webContents, 'geolocation', 'file://', {}), false)

      // upload-audio-to-r2 hardening checks
      const uploadHandler = env.ipcHandlers.get('upload-audio-to-r2')
      const trustedEvent = { sender: env.fakeWindow.webContents }
      const validR2Url = 'https://bucket.r2.cloudflarestorage.com/official/turn.webm?X-Amz-Signature=ok'

      const emptyBufRes = await uploadHandler(trustedEvent, {
        uploadUrl: validR2Url,
        headers: { 'Content-Type': 'audio/webm' },
        data: new ArrayBuffer(0),
      })
      assert.equal(emptyBufRes.status, 400)

      const oversizedRes = await uploadHandler(trustedEvent, {
        uploadUrl: validR2Url,
        headers: { 'Content-Type': 'audio/webm' },
        data: new Uint8Array(26 * 1024 * 1024 + 1).buffer,
      })
      assert.equal(oversizedRes.status, 413)

      const credsUrlRes = await uploadHandler(trustedEvent, {
        uploadUrl: 'https://user:pass@bucket.r2.cloudflarestorage.com/official/turn.webm',
        headers: { 'Content-Type': 'audio/webm' },
        data: new Uint8Array([1, 2]).buffer,
      })
      assert.equal(credsUrlRes.status, 400)

      const non443Res = await uploadHandler(trustedEvent, {
        uploadUrl: 'https://bucket.r2.cloudflarestorage.com:8443/official/turn.webm',
        headers: { 'Content-Type': 'audio/webm' },
        data: new Uint8Array([1, 2]).buffer,
      })
      assert.equal(non443Res.status, 403)

      assert.equal(env.fetchCalls.length, 0)

      const validRes = await uploadHandler(trustedEvent, {
        uploadUrl: validR2Url,
        headers: {
          'Content-Type': 'audio/webm',
          'If-None-Match': '*',
          'x-amz-checksum-sha256': 'abc=',
          Authorization: 'Bearer steal-me',
          Cookie: 'session=bad',
          Host: 'evil.com',
        },
        data: new Uint8Array([1, 2, 3]).buffer,
      })
      assert.equal(validRes.ok, true)
      assert.equal(env.fetchCalls.length, 1)
      assert.equal(env.fetchCalls[0].init.redirect, 'error')
      assert.deepEqual(Object.keys(env.fetchCalls[0].init.headers).sort(), [
        'Content-Type',
        'If-None-Match',
        'x-amz-checksum-sha256',
      ])

      // Duplicate case-variant headers must be deduplicated so Fetch Headers never merges values
      const caseVariantRes = await uploadHandler(trustedEvent, {
        uploadUrl: validR2Url,
        headers: {
          'Content-Type': 'audio/webm',
          'content-type': 'application/octet-stream',
          'X-Amz-Checksum-Sha256': 'hash1',
          'x-amz-checksum-sha256': 'hash2',
          'If-None-Match': '*',
          'if-none-match': '"etag"',
        },
        data: new Uint8Array([1, 2, 3]).buffer,
      })
      assert.equal(caseVariantRes.ok, true)
      assert.equal(env.fetchCalls.length, 2)
      const dedupedHeaders = env.fetchCalls[1].init.headers
      assert.equal(Object.keys(dedupedHeaders).length, 3)
      const fetchedHeadersObj = new Headers(dedupedHeaders)
      assert.equal(fetchedHeadersObj.get('content-type'), 'application/octet-stream')
      assert.equal(fetchedHeadersObj.get('x-amz-checksum-sha256'), 'hash2')
      assert.equal(fetchedHeadersObj.get('if-none-match'), '"etag"')
    }
  } finally {
    Module._load = originalLoad
  }
})
