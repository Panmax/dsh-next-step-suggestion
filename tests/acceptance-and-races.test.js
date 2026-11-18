import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { apply as applyHostPlugin } from '../index.js'
import { generateClientBundle } from '../scripts/build-client.mjs'
import { createClientSuggestionMachine, SUGGESTION_CSS } from '../src/client-core.js'
import { createClientPlugin } from '../src/client-entry.js'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function baseEnv(overrides = {}) {
  return {
    sessionId: 'session-a',
    foreground: true,
    running: false,
    hasError: false,
    submissionPending: false,
    draft: '',
    draftRev: 0,
    hasAttachments: false,
    phase: 'plain',
    popupOpen: false,
    composing: false,
    turnHint: 1,
    ...overrides,
  }
}

function makeKeyEvent(key, extra = {}) {
  let prevented = Boolean(extra.defaultPrevented)
  let stopped = false
  return {
    key,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 0,
    ...extra,
    get defaultPrevented() { return prevented },
    preventDefault() { prevented = true },
    get propagationStopped() { return stopped },
    stopPropagation() { stopped = true },
  }
}

const flushMicrotasks = () => new Promise(resolvePromise => setTimeout(resolvePromise, 15))

test('Bundle manifest, locales, icon, CSS tokens, and built client.js stay in sync and compliant', () => {
  const diskClient = readFileSync(resolve(rootDir, 'client.js'), 'utf8')
  assert.equal(diskClient, generateClientBundle())

  const pkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-next-step-suggestion')
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(pkg.dsh?.client?.platform, 'web')

  const en = JSON.parse(readFileSync(resolve(rootDir, 'locale/en.json'), 'utf8'))
  const zh = JSON.parse(readFileSync(resolve(rootDir, 'locale/zh.json'), 'utf8'))
  assert.ok(en.meta?.title?.length > 0 && en.meta?.description?.length > 0)
  assert.ok(zh.meta?.title?.length > 0 && zh.meta?.description?.length > 0)
  assert.equal(en.meta?.detail, 'docs/DETAIL.md')
  assert.equal(zh.meta?.detail, 'docs/DETAIL.zh.md')

  const detailEn = readFileSync(resolve(rootDir, 'docs/DETAIL.md'), 'utf8').trim()
  const detailZh = readFileSync(resolve(rootDir, 'docs/DETAIL.zh.md'), 'utf8').trim()
  assert.match(detailEn, /^!\[[^\]]+\]\(preview\.png\)$/)
  assert.match(detailZh, /^!\[[^\]]+\]\(preview\.zh\.png\)$/)

  const icon = readFileSync(resolve(rootDir, 'icon.svg'), 'utf8')
  assert.match(icon, /viewBox="0 0 36 36"/)
  assert.doesNotMatch(icon, /<(?:script|style|text|image|foreignObject)\b/i)

  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  for (const pngRelPath of [
    'docs/preview.png',
    'docs/preview.zh.png',
  ]) {
    const buf = readFileSync(resolve(rootDir, pngRelPath))
    assert.ok(buf.byteLength > 1024 && buf.byteLength < 1024 * 1024)
    assert.deepEqual(buf.subarray(0, 8), PNG_SIGNATURE)
  }

  // Client CSS must use theme tokens only (no hardcoded hex/rgb colors).
  assert.doesNotMatch(SUGGESTION_CSS, /#[0-9a-fA-F]{3,8}\b|rgba?\(/u)
  assert.match(SUGGESTION_CSS, /var\(--dsw-/)

  // `.overlayAnchor` (`[data-composer-overlay]`) precedes `<DraftEditor>` (`.grow`, `position: relative`)
  // in `InputBar.tsx` DOM order, so `.dsh-nss-ghost` must declare a positive `z-index` (< 100 menu z-index)
  // for `.dsh-nss-kbd` (`pointer-events: auto`) to receive hover/click events above the transparent editor.
  assert.match(SUGGESTION_CSS, /\.dsh-nss-ghost\s*\{[\s\S]*?\bz-index:\s*([1-9]\d?)\s*;/u)
  assert.match(SUGGESTION_CSS, /\.dsh-nss-kbd\s*\{[\s\S]*?\bpointer-events:\s*auto\s*;/u)
})

test('Acceptance 1 & 2: Normal turn end shows ghost suggestion separated from draft; Tab accepts into editable draft without sending; Esc dismisses', async () => {
  let fetchCount = 0
  const sentMessages = []
  let editorDraft = ''
  let editorRev = 0

  const machine = createClientSuggestionMachine({
    fetchSuggestion: async (sessionId, expectedTurn) => {
      fetchCount += 1
      assert.equal(sessionId, 'session-a')
      assert.equal(expectedTurn, 1)
      return {
        status: 'ready',
        turn: 1,
        suggestion: '运行相关回归测试，并总结失败原因',
      }
    },
  })

  // Agent running -> no suggestion yet.
  machine.sync(baseEnv({ running: true }))
  assert.equal(machine.getVisibleSuggestion(), null)
  assert.equal(fetchCount, 0)

  // Agent completes normally with empty input -> requests once and displays ghost suggestion.
  machine.sync(baseEnv({ running: false, draft: editorDraft, draftRev: editorRev, turnHint: 1 }))
  await flushMicrotasks()

  assert.equal(fetchCount, 1)
  assert.equal(machine.getVisibleSuggestion(), '运行相关回归测试，并总结失败原因')
  // Actual draft value remains completely separate (still empty).
  assert.equal(editorDraft, '')
  assert.equal(sentMessages.length, 0)

  // Pressing Tab while focused accepts suggestion into editable draft, clears preview, and does NOT send.
  const tabEvent = makeKeyEvent('Tab')
  const consumed = machine.handleKeyDown(tabEvent, {
    isEditorFocused: true,
    acceptDraft: (text) => {
      editorDraft = text
      editorRev += 1
    },
  })

  assert.equal(consumed, true)
  assert.equal(tabEvent.defaultPrevented, true)
  assert.equal(editorDraft, '运行相关回归测试，并总结失败原因')
  assert.equal(machine.getVisibleSuggestion(), null)
  // Chat history has NO new sent user message until user explicitly submits.
  assert.equal(sentMessages.length, 0)

  // User edits the accepted draft and explicitly sends it.
  editorDraft = `${editorDraft}（仅限 auth 模块）`
  sentMessages.push(editorDraft)
  assert.equal(sentMessages.length, 1)

  // Turn 2: verify Esc dismisses visible preview only when unclaimed, then passes subsequent Esc.
  machine.sync(baseEnv({ running: true, draft: '', draftRev: 2, turnHint: 2 }))
  machine.sync(baseEnv({ running: false, draft: '', draftRev: 2, turnHint: 2 }))
  await flushMicrotasks()
  // Note: fetchSuggestion returned turn: 1 above; let's test Esc on a fresh machine returning turn 2.
  machine.dispose()

  const machine2 = createClientSuggestionMachine({
    fetchSuggestion: async () => ({ status: 'ready', turn: 2, suggestion: '提交修复并查看 git diff' }),
  })
  machine2.sync(baseEnv({ running: true, turnHint: 2 }))
  machine2.sync(baseEnv({ running: false, turnHint: 2 }))
  await flushMicrotasks()
  assert.equal(machine2.getVisibleSuggestion(), '提交修复并查看 git diff')

  const escWhenClaimed = makeKeyEvent('Escape', { defaultPrevented: true })
  assert.equal(machine2.handleKeyDown(escWhenClaimed, { isEditorFocused: true, acceptDraft: () => {} }), false)
  assert.equal(machine2.getVisibleSuggestion(), '提交修复并查看 git diff')

  const escClean = makeKeyEvent('Escape')
  assert.equal(machine2.handleKeyDown(escClean, { isEditorFocused: true, acceptDraft: () => {} }), true)
  assert.equal(escClean.defaultPrevented, true)
  assert.equal(machine2.getVisibleSuggestion(), null)

  const escAgain = makeKeyEvent('Escape')
  assert.equal(machine2.handleKeyDown(escAgain, { isEditorFocused: true, acceptDraft: () => {} }), false)
  assert.equal(escAgain.defaultPrevented, false)
  machine2.dispose()
})

test('Acceptance 3: Existing draft, open completion popup, unfocused editor, Shift+Tab, or no suggestion leaves Tab untouched', async () => {
  let fetchCount = 0
  const machine = createClientSuggestionMachine({
    fetchSuggestion: async (_sid, turn) => {
      fetchCount += 1
      return turn === 2
        ? { status: 'none', turn: 2, suggestion: null }
        : { status: 'ready', turn: turn ?? 1, suggestion: '运行单元测试' }
    },
  })

  // Case A: Non-empty draft when turn finishes -> does not fetch and does not intercept Tab.
  machine.sync(baseEnv({ running: true, draft: '我已经在写草稿了', draftRev: 5, turnHint: 1 }))
  machine.sync(baseEnv({ running: false, draft: '我已经在写草稿了', draftRev: 5, turnHint: 1 }))
  await flushMicrotasks()
  assert.equal(fetchCount, 0)
  const tabWithDraft = makeKeyEvent('Tab')
  assert.equal(machine.handleKeyDown(tabWithDraft, { isEditorFocused: true, acceptDraft: () => {} }), false)
  assert.equal(tabWithDraft.defaultPrevented, false)

  // Case B: Model returns no suggestion (`status: 'none'`) -> Tab stays untouched.
  machine.sync(baseEnv({ running: true, draft: '', draftRev: 6, turnHint: 2 }))
  machine.sync(baseEnv({ running: false, draft: '', draftRev: 6, turnHint: 2 }))
  await flushMicrotasks()
  assert.equal(fetchCount, 1)
  assert.equal(machine.getVisibleSuggestion(), null)
  const tabNoSuggestion = makeKeyEvent('Tab')
  assert.equal(machine.handleKeyDown(tabNoSuggestion, { isEditorFocused: true, acceptDraft: () => {} }), false)
  assert.equal(tabNoSuggestion.defaultPrevented, false)

  // Case C: Suggestion exists, check unfocused editor, Shift+Tab, and open completion popup (`/` or `@` menu).
  machine.sync(baseEnv({ running: true, draft: '', draftRev: 7, turnHint: 3 }))
  machine.sync(baseEnv({ running: false, draft: '', draftRev: 7, turnHint: 3 }))
  await flushMicrotasks()
  assert.equal(machine.getVisibleSuggestion(), '运行单元测试')

  // Editor NOT focused -> Tab passes through for native focus traversal!
  const tabUnfocused = makeKeyEvent('Tab')
  assert.equal(machine.handleKeyDown(tabUnfocused, { isEditorFocused: false, acceptDraft: () => {} }), false)
  assert.equal(tabUnfocused.defaultPrevented, false)

  // Shift+Tab -> passes through!
  const shiftTab = makeKeyEvent('Tab', { shiftKey: true })
  assert.equal(machine.handleKeyDown(shiftTab, { isEditorFocused: true, acceptDraft: () => {} }), false)
  assert.equal(shiftTab.defaultPrevented, false)

  // Completion popup opens (`popupOpen: true`) -> preview hides and Tab passes to completion menu!
  machine.sync(baseEnv({ running: false, draft: '', draftRev: 7, popupOpen: true, turnHint: 3 }))
  assert.equal(machine.getVisibleSuggestion(), null)
  const tabPopupOpen = makeKeyEvent('Tab')
  assert.equal(machine.handleKeyDown(tabPopupOpen, { isEditorFocused: true, acceptDraft: () => {} }), false)
  assert.equal(tabPopupOpen.defaultPrevented, false)

  machine.dispose()
})

test('Acceptance 4: Async race guards — typing then deleting to empty, switching sessions, or starting a new turn suppresses late suggestions', async () => {
  // Race 1: User types and deletes back to empty BEFORE async suggestion resolves.
  let resolveSlow1
  const machine1 = createClientSuggestionMachine({
    fetchSuggestion: () => new Promise((resolvePromise) => { resolveSlow1 = resolvePromise }),
  })
  machine1.sync(baseEnv({ running: true, draft: '', draftRev: 10, turnHint: 1 }))
  machine1.sync(baseEnv({ running: false, draft: '', draftRev: 10, turnHint: 1 }))

  // User types 'a' (draftRev 11) and deletes back to '' (draftRev 12) while request is still in flight.
  machine1.notifyUserEditIntent()
  machine1.sync(baseEnv({ running: false, draft: 'a', draftRev: 11, turnHint: 1 }))
  machine1.sync(baseEnv({ running: false, draft: '', draftRev: 12, turnHint: 1 }))

  resolveSlow1({ status: 'ready', turn: 1, suggestion: '迟到的建议1' })
  await flushMicrotasks()
  assert.equal(machine1.getVisibleSuggestion(), null)
  machine1.dispose()

  // Race 2: Suggestion already visible -> user types 'x' -> suggestion disappears -> user deletes back to '' -> stays gone!
  const machine2 = createClientSuggestionMachine({
    fetchSuggestion: async () => ({ status: 'ready', turn: 1, suggestion: '可见建议' }),
  })
  machine2.sync(baseEnv({ running: true, draft: '', draftRev: 1, turnHint: 1 }))
  machine2.sync(baseEnv({ running: false, draft: '', draftRev: 1, turnHint: 1 }))
  await flushMicrotasks()
  assert.equal(machine2.getVisibleSuggestion(), '可见建议')

  machine2.sync(baseEnv({ running: false, draft: 'x', draftRev: 2, turnHint: 1 }))
  assert.equal(machine2.getVisibleSuggestion(), null)
  machine2.sync(baseEnv({ running: false, draft: '', draftRev: 3, turnHint: 1 }))
  assert.equal(machine2.getVisibleSuggestion(), null)
  machine2.dispose()

  // P1 #5: Plan Mode blocks ghost suggestions
  const machine3_p1 = createClientSuggestionMachine({
    fetchSuggestion: async () => ({ status: 'ready', turn: 1, suggestion: 'Plan模式测试' }),
  })
  machine3_p1.sync(baseEnv({ sessionId: 's-plan', running: false, planActive: false, turnHint: 1 }))
  await flushMicrotasks()
  assert.equal(machine3_p1.getVisibleSuggestion(), 'Plan模式测试')

  machine3_p1.sync(baseEnv({ sessionId: 's-plan', running: false, planActive: true, turnHint: 1 }))
  assert.equal(machine3_p1.getVisibleSuggestion(), null)

  machine3_p1.sync(baseEnv({ sessionId: 's-plan', running: false, planActive: false, turnHint: 1 }))
  assert.equal(machine3_p1.getVisibleSuggestion(), 'Plan模式测试')
  machine3_p1.dispose()

  // P1 #3: Goal auto-continuation blocks ghost suggestions
  const machine4_p1 = createClientSuggestionMachine({
    fetchSuggestion: async () => ({ status: 'ready', turn: 1, suggestion: 'Goal模式测试' }),
  })
  machine4_p1.sync(baseEnv({ sessionId: 's-goal', running: false, goalActive: false, turnHint: 1 }))
  await flushMicrotasks()
  assert.equal(machine4_p1.getVisibleSuggestion(), 'Goal模式测试')

  machine4_p1.sync(baseEnv({ sessionId: 's-goal', running: false, goalActive: true, turnHint: 1 }))
  assert.equal(machine4_p1.getVisibleSuggestion(), null)

  machine4_p1.sync(baseEnv({ sessionId: 's-goal', running: false, goalActive: false, turnHint: 1 }))
  assert.equal(machine4_p1.getVisibleSuggestion(), 'Goal模式测试')
  machine4_p1.dispose()

  // P1 #4: RightArrow triggers acceptance on empty composer
  const machine5_p1 = createClientSuggestionMachine({
    fetchSuggestion: async () => ({ status: 'ready', turn: 1, suggestion: '右键测试' }),
  })
  let acceptedDraft = ''
  machine5_p1.sync(baseEnv({ running: false, draft: '', turnHint: 1 }))
  await flushMicrotasks()
  assert.equal(machine5_p1.getVisibleSuggestion(), '右键测试')

  const arrowEvent = makeKeyEvent('ArrowRight')
  const consumed = machine5_p1.handleKeyDown(arrowEvent, {
    isEditorFocused: true,
    acceptDraft: (text) => { acceptedDraft = text },
    focusEditor: () => {},
  })
  assert.equal(consumed, true)
  assert.equal(acceptedDraft, '右键测试')
  machine5_p1.dispose()

  // Race 3: Multi-session switching — never leaks onto session-b, preserves unconsumed suggestion on return to session-a
  // (even if InputHub recreates SessionInputShell with draftRev=0), and backfills turns that finished in background!
  let resolveSlowA
  const fetchLog = []
  const machine3 = createClientSuggestionMachine({
    fetchSuggestion: (sid, turn, _signal, options) => {
      fetchLog.push({ sid, turn, requireLiveCompletion: Boolean(options?.requireLiveCompletion) })
      if (sid === 'session-a') {
        return new Promise((resolvePromise) => { resolveSlowA = resolvePromise })
      }
      if (sid === 'session-bg') {
        return Promise.resolve({ status: 'ready', turn: turn ?? 4, suggestion: '检查后台完成的构建产物' })
      }
      // Historical cold session-b returns ineligible from Host when requireLiveCompletion=true.
      return Promise.resolve({ status: 'ineligible', turn: turn ?? 5, suggestion: null, reason: 'historical-turn' })
    },
  })
  machine3.sync(baseEnv({ sessionId: 'session-a', running: true, draftRev: 15, turnHint: 1 }))
  machine3.sync(baseEnv({ sessionId: 'session-a', running: false, draftRev: 15, turnHint: 1 }))

  // Switch to historical session-b while session-a's request is still in flight.
  machine3.sync(baseEnv({ sessionId: 'session-b', running: false, draftRev: 0, turnHint: 5 }))

  // session-a resolves in the background -> MUST NOT leak onto session-b!
  resolveSlowA({ status: 'ready', turn: 1, suggestion: '仅属于会话A的建议' })
  await flushMicrotasks()
  assert.equal(machine3.getVisibleSuggestion(), null)

  // Return to idle, clean session-a (with freshly mounted SessionInputShell `draftRev: 0`) -> suggestion is preserved!
  machine3.sync(baseEnv({ sessionId: 'session-a', running: false, draft: '', draftRev: 0, turnHint: 1 }))
  assert.equal(machine3.getVisibleSuggestion(), '仅属于会话A的建议')

  // Consume/invalidate in session-a (type then delete to empty), switch away and return -> stays permanently gone!
  machine3.sync(baseEnv({ sessionId: 'session-a', running: false, draft: 'z', draftRev: 1, turnHint: 1 }))
  machine3.sync(baseEnv({ sessionId: 'session-a', running: false, draft: '', draftRev: 2, turnHint: 1 }))
  assert.equal(machine3.getVisibleSuggestion(), null)
  machine3.sync(baseEnv({ sessionId: 'session-b', running: false, draft: '', draftRev: 0, turnHint: 5 }))
  machine3.sync(baseEnv({ sessionId: 'session-a', running: false, draft: '', draftRev: 0, turnHint: 1 }))
  assert.equal(machine3.getVisibleSuggestion(), null)

  // Background-running session observed via sidebar list + transient non-foreground mount frame -> still backfills!
  machine3.noteSessionRunning('session-bg')
  // Frame 1 on switch: input not hydrated yet (`foreground: false`).
  machine3.sync(baseEnv({ sessionId: 'session-bg', foreground: false, running: false, draft: '', draftRev: 0, turnHint: 4 }))
  // Frame 2: hydrated (`foreground: true`) -> preserves `sawRunning` (`requireLiveCompletion === false`) and backfills!
  machine3.sync(baseEnv({ sessionId: 'session-bg', foreground: true, running: false, draft: '', draftRev: 0, turnHint: 4 }))
  await flushMicrotasks()
  assert.equal(machine3.getVisibleSuggestion(), '检查后台完成的构建产物')
  const bgCall = fetchLog.find(entry => entry.sid === 'session-bg')
  assert.ok(bgCall)
  assert.equal(bgCall.requireLiveCompletion, false)
  machine3.dispose()

  // Race 4: Starting a new turn while suggestion request is in flight discards late result.
  let resolveSlow4
  const machine4 = createClientSuggestionMachine({
    fetchSuggestion: () => new Promise((resolvePromise) => { resolveSlow4 = resolvePromise }),
  })
  machine4.sync(baseEnv({ running: true, turnHint: 1 }))
  machine4.sync(baseEnv({ running: false, turnHint: 1 }))
  // Immediately start turn 2.
  machine4.sync(baseEnv({ running: true, turnHint: 2 }))
  resolveSlow4({ status: 'ready', turn: 1, suggestion: '旧回合建议' })
  await flushMicrotasks()
  assert.equal(machine4.getVisibleSuggestion(), null)
  machine4.dispose()
})

test('Acceptance 5 & End-to-End HTTP + client.js ModuleLoader integration: normal flow, LLM failure fallback, and plugin disable', async () => {
  // 1. Verify root `client.js` loads cleanly through `window.__ModuleLoader__.load`.
  let loadedModuleDescriptor = null
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(descriptor) {
          loadedModuleDescriptor = descriptor
        },
      },
    },
    globalThis: {},
  }
  vm.runInNewContext(readFileSync(resolve(rootDir, 'client.js'), 'utf8'), sandbox)
  assert.ok(loadedModuleDescriptor)
  assert.equal(loadedModuleDescriptor.id, 'dsh-next-step-suggestion')
  assert.equal(typeof loadedModuleDescriptor.factory, 'function')

  // 2. Spin up a real Node HTTP server mounting the Host plugin (`applyHostPlugin`).
  const hostEffects = []
  const routes = new Map()
  let shouldFailLlm = false
  let hostLlmCalls = 0
  let agentRunning = true
  let currentTurn = 1

  const agent = {
    id: 'live-session-1',
    get status() { return agentRunning ? 'running' : 'idle' },
    inbox: { nextTurn: [], nextStep: [] },
    model: { current: () => ({ provider: 'deepseek', model: 'deepseek-chat' }) },
    session: {
      id: 'live-session-1',
      header: {},
      snapshotEvents: () => [
        { type: 'turn/start', seq: 1, data: { turn: currentTurn } },
        {
          type: 'user/message',
          seq: 2,
          data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '重构配置解析模块' }] },
        },
        {
          type: 'assistant/message',
          seq: 3,
          data: {
            turn: currentTurn,
            step: 1,
            message: { role: 'assistant', content: [{ type: 'text', text: '重构已完成，尚未运行回归测试。' }] },
          },
        },
        ...(agentRunning ? [] : [{ type: 'turn/end', seq: 4, data: { turn: currentTurn, reason: { kind: 'completed' } } }]),
      ],
    },
  }

  const hostCtx = {
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') hostEffects.push(cleanup)
      return cleanup
    },
    on() { return () => {} },
    connection: { requestRejection: () => undefined },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    },
    agents: { get: id => (id === 'live-session-1' ? agent : undefined) },
    llm: {
      async prepareCall(config) {
        hostLlmCalls += 1
        if (shouldFailLlm) throw new Error('Simulated provider outage')
        return {
          config,
          async *stream() {
            yield { type: 'text-delta', index: 0, text: '运行配置解析模块的回归测试' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
  }

  applyHostPlugin(hostCtx, { timeoutMs: 2000 })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const handler = routes.get(url.pathname)
    if (!handler) {
      res.statusCode = 404
      res.end()
      return
    }
    await handler(req, res)
  })

  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const port = server.address().port
  const baseUrl = `http://127.0.0.1:${port}`

  try {
    // Wire a minimal reactive harness exercising `createClientPlugin` end-to-end over HTTP.
    const clientEffects = []
    let registeredOverlayComponent = null
    const mockReact = createMinimalReactHarness()

    const clientPlugin = createClientPlugin(mockReact.React, {
      fetchImpl: (path, init) => fetch(`${baseUrl}${path}`, init),
    })

    const clientCtx = {
      effect(fn) {
        const cleanup = fn()
        if (typeof cleanup === 'function') clientEffects.push(cleanup)
        return cleanup
      },
      locale: { register: () => () => {} },
      slots: {
        inject(_key, cb) { return cb() },
        register(_meta, Comp) {
          registeredOverlayComponent = Comp
          return () => { registeredOverlayComponent = null }
        },
      },
    }

    clientPlugin.apply(clientCtx)
    assert.equal(typeof registeredOverlayComponent, 'function')

    // Build mock composer DOM card with focused contenteditable editor.
    const cardDom = createMockComposerCard()
    let draftText = ''
    let draftRev = 0
    const submittedMessages = []

    const inputActions = {
      setDraft(next) {
        draftText = next
        draftRev += 1
      },
      persistDraft() {},
      submit() {
        if (draftText.trim() !== '') {
          submittedMessages.push(draftText)
          draftText = ''
          draftRev += 1
        }
      },
    }

    // Regression coverage: `conversationContinuation` returns `null` (not `undefined`) when healthy,
    // and sibling overlay plugins (e.g. `dsh-context`) inject inert `<style>` nodes into `[data-composer-overlay]`.
    cardDom.overlayHost.children.unshift({
      tagName: 'STYLE',
      textContent: ':root { --tw-ring-offset-width: 0px; }',
      childElementCount: 0,
      hasAttribute: () => false,
    })

    const renderOverlay = () => mockReact.render(registeredOverlayComponent, {
      sessionId: 'live-session-1',
      useSession: sel => sel({ running: agentRunning, promptError: null, pendingSubmissions: [], subagent: null, removed: false }),
      useInput: sel => sel({ draft: draftText, draftRev, attachmentIds: [], phase: 'plain', queue: [] }),
      inputActions,
      useProjection: (key) => {
        if (key === 'conversationContinuation') return null
        if (key === 'turnOutline') return [{ turn: currentTurn, seq: 1, prompt: '重构', response: agentRunning ? '' : '完成' }]
        return undefined
      },
      usePanelInfo: sel => sel({ activePanelId: null }),
    }, cardDom.anchorEl)

    // Step A: Agent running -> empty overlay.
    let vnode = renderOverlay()
    assert.equal(vnode.children[0], null)

    // Step B: Agent finishes turn 1 -> fetches over real HTTP and renders ghost suggestion!
    agentRunning = false
    renderOverlay()
    await flushMicrotasks()
    await flushMicrotasks()
    vnode = renderOverlay()

    assert.equal(hostLlmCalls, 1)
    assert.ok(vnode.children[0] !== null)
    assert.equal(vnode.children[0].props['data-next-step-suggestion-active'], '')
    assert.equal(vnode.children[0].children[0].children[0], '运行配置解析模块的回归测试')

    // Step C: Press Tab on focused editor -> accepts into draft, does NOT submit.
    const tabEv = makeKeyEvent('Tab')
    cardDom.dispatchKeyDown(tabEv)
    assert.equal(tabEv.defaultPrevented, true)
    assert.equal(draftText, '运行配置解析模块的回归测试')
    assert.equal(submittedMessages.length, 0)

    // User presses submit explicitly -> message sends normally.
    inputActions.submit()
    assert.deepEqual(submittedMessages, ['运行配置解析模块的回归测试'])

    // Step D: Generation failure on turn 2 -> degrades gracefully; typing and sending work normally.
    shouldFailLlm = true
    currentTurn = 2
    agentRunning = true
    renderOverlay()
    agentRunning = false
    renderOverlay()
    await flushMicrotasks()
    await flushMicrotasks()
    vnode = renderOverlay()
    assert.equal(hostLlmCalls, 2)
    assert.equal(vnode.children[0], null)

    inputActions.setDraft('手动输入的下一条消息')
    inputActions.submit()
    assert.deepEqual(submittedMessages, ['运行配置解析模块的回归测试', '手动输入的下一条消息'])

    // Step E: Disable plugin (dispose Host & Client effects) -> zero new requests, slot unregistered, Tab untouched.
    mockReact.unmount()
    for (const cleanup of clientEffects.splice(0)) cleanup()
    for (const cleanup of hostEffects.splice(0)) cleanup()
    assert.equal(registeredOverlayComponent, null)

    const callsBeforeDisabledTurn = hostLlmCalls
    const tabAfterDisable = makeKeyEvent('Tab')
    cardDom.dispatchKeyDown(tabAfterDisable)
    assert.equal(tabAfterDisable.defaultPrevented, false)
    assert.equal(hostLlmCalls, callsBeforeDisabledTurn)
  } finally {
    await new Promise(resolveClose => server.close(resolveClose))
  }
})

/** Minimal synchronous hook harness to execute the real `NextStepOverlay` component without external DOM deps. */
function createMinimalReactHarness() {
  const hookSlots = []
  let cursor = 0
  const cleanups = new Map()
  const pendingEffects = []

  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children }
    },
    useRef(initial) {
      const idx = cursor++
      if (!(idx in hookSlots)) hookSlots[idx] = { current: initial }
      return hookSlots[idx]
    },
    useState(initial) {
      const idx = cursor++
      if (!(idx in hookSlots)) hookSlots[idx] = typeof initial === 'function' ? initial() : initial
      const setState = (next) => {
        hookSlots[idx] = typeof next === 'function' ? next(hookSlots[idx]) : next
      }
      return [hookSlots[idx], setState]
    },
    useReducer(reducer, initial) {
      const idx = cursor++
      if (!(idx in hookSlots)) hookSlots[idx] = initial
      const dispatch = (action) => {
        hookSlots[idx] = reducer(hookSlots[idx], action)
      }
      return [hookSlots[idx], dispatch]
    },
    useMemo(factory, deps) {
      const idx = cursor++
      const prev = hookSlots[idx]
      if (!prev || !depsEqual(prev.deps, deps)) {
        hookSlots[idx] = { value: factory(), deps }
      }
      return hookSlots[idx].value
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      cursor++
      return getSnapshot()
    },
    useLayoutEffect(fn, deps) {
      recordEffect(fn, deps)
    },
    useEffect(fn, deps) {
      recordEffect(fn, deps)
    },
  }

  function recordEffect(fn, deps) {
    const idx = cursor++
    const prevDeps = hookSlots[idx]
    if (deps === undefined || prevDeps === undefined || !depsEqual(prevDeps, deps)) {
      hookSlots[idx] = deps
      pendingEffects.push({ idx, fn })
    }
  }

  function depsEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => Object.is(v, b[i]))
  }

  return {
    React,
    render(Comp, props, anchorNode) {
      cursor = 0
      pendingEffects.length = 0
      const tree = Comp(props)
      if (tree?.props?.ref && typeof tree.props.ref === 'object') {
        tree.props.ref.current = anchorNode
      }
      for (const { idx, fn } of pendingEffects.splice(0)) {
        const prevCleanup = cleanups.get(idx)
        if (typeof prevCleanup === 'function') prevCleanup()
        const nextCleanup = fn()
        if (typeof nextCleanup === 'function') cleanups.set(idx, nextCleanup)
        else cleanups.delete(idx)
      }
      return tree
    },
    unmount() {
      for (const cleanup of cleanups.values()) {
        if (typeof cleanup === 'function') cleanup()
      }
      cleanups.clear()
    },
  }
}

function createMockComposerCard() {
  const listeners = new Map()
  const editorAttrs = new Map([['contenteditable', 'true']])
  const focusCalls = []
  let hasQuote = false
  let hasChip = false
  let hasPopup = false
  let takeoverDisplay = 'contents'

  const fallbackWrapper = {
    style: {
      get display() { return takeoverDisplay },
      set display(v) { takeoverDisplay = v },
    },
    hidden: false,
    getAttribute: () => null,
  }

  const editorEl = {
    focusCalls,
    getAttribute(name) {
      return editorAttrs.has(name) ? editorAttrs.get(name) : null
    },
    setAttribute(name, value) {
      editorAttrs.set(name, String(value))
    },
    removeAttribute(name) {
      editorAttrs.delete(name)
    },
    hasAttribute(name) {
      return editorAttrs.has(name)
    },
    focus(opts) {
      focusCalls.push(opts ?? null)
      doc.activeElement = editorEl
    },
    contains: target => target === editorEl,
  }
  const scrollEl = { offsetTop: 8 }
  const doc = { activeElement: editorEl, querySelector: () => null }
  const overlayHost = { children: [] }
  const cardEl = {
    ownerDocument: doc,
    closest(sel) {
      if (sel === '[data-chain-overlay-fallback="conversation.composer"]') return fallbackWrapper
      if (sel === '[data-composer-card]') return cardEl
      return null
    },
    querySelector(sel) {
      if (sel === '[data-composer-input]' || sel === '[data-input-scroll] [contenteditable]') return editorEl
      if (sel === '[data-input-scroll]') return scrollEl
      if (sel === '[data-composer-overlay]') return overlayHost
      if (sel.includes('[data-composer-quote]') && (hasQuote || hasChip)) return { tagName: 'SPAN' }
      if (sel.includes('[data-trigger-menu]') && hasPopup) return { tagName: 'DIV' }
      return null
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn)
    },
  }
  const anchorEl = {
    ownerDocument: doc,
    parentElement: overlayHost,
    hasAttribute: name => name === 'data-nss-anchor',
    closest(sel) {
      return sel === '[data-composer-card]' ? cardEl : null
    },
  }
  overlayHost.children.push(anchorEl)

  return {
    anchorEl,
    cardEl,
    editorEl,
    fallbackWrapper,
    overlayHost,
    doc,
    setQuotePresent(v) { hasQuote = Boolean(v) },
    setChipPresent(v) { hasChip = Boolean(v) },
    setPopupPresent(v) { hasPopup = Boolean(v) },
    setTakeoverActive(v) { takeoverDisplay = v ? 'none' : 'contents' },
    dispatchKeyDown(ev) {
      for (const fn of listeners.get('keydown') ?? []) fn(ev)
    },
  }
}

test('P0 #1 (Machine): blocked editor, denied prompt access, composer takeover, and inline decorators gate suggestions accurately', async () => {
  let fetchCount = 0
  const machine = createClientSuggestionMachine({
    fetchSuggestion: async (_sid, turn) => {
      fetchCount += 1
      return { status: 'ready', turn: turn ?? 1, suggestion: '运行单元测试并检查覆盖率' }
    },
  })

  // 1. Read-only viewer (`promptAllowed: false`) -> never fetches on turn completion.
  machine.sync(baseEnv({ sessionId: 's-readonly', running: true, promptAllowed: false, turnHint: 1 }))
  machine.sync(baseEnv({ sessionId: 's-readonly', running: false, promptAllowed: false, turnHint: 1 }))
  await flushMicrotasks()
  assert.equal(fetchCount, 0)
  assert.equal(machine.getVisibleSuggestion(), null)

  // 2. Normal session fetches & shows suggestion; temporary model block (`editorEditable: false`) hides it without burning turn,
  //    then restoring model (`editorEditable: true`) restores the cached suggestion with zero extra fetches.
  machine.sync(baseEnv({ sessionId: 's-block', running: true, turnHint: 1 }))
  machine.sync(baseEnv({ sessionId: 's-block', running: false, turnHint: 1 }))
  await flushMicrotasks()
  assert.equal(fetchCount, 1)
  assert.equal(machine.getVisibleSuggestion(), '运行单元测试并检查覆盖率')

  // Model becomes blocked -> preview hides and refuses Tab / click acceptance.
  machine.sync(baseEnv({ sessionId: 's-block', running: false, editorEditable: false, turnHint: 1 }))
  assert.equal(machine.getVisibleSuggestion(), null)
  assert.equal(machine.acceptSuggestion({ acceptDraft: () => { throw new Error('must not accept') } }), false)

  // User picks valid model -> cached suggestion reappears without calling fetchSuggestion again!
  machine.sync(baseEnv({ sessionId: 's-block', running: false, editorEditable: true, turnHint: 1 }))
  assert.equal(fetchCount, 1)
  assert.equal(machine.getVisibleSuggestion(), '运行单元测试并检查覆盖率')

  // 3. `conversation.composer` takeover (`composerTakenOver: true`) hides preview temporarily, then restores when cleared.
  machine.sync(baseEnv({ sessionId: 's-block', running: false, composerTakenOver: true, turnHint: 1 }))
  assert.equal(machine.getVisibleSuggestion(), null)
  machine.sync(baseEnv({ sessionId: 's-block', running: false, composerTakenOver: false, turnHint: 1 }))
  assert.equal(machine.getVisibleSuggestion(), '运行单元测试并检查覆盖率')

  // 4. Inserting an inline quote/reference decorator (`hasInlineDecorators: true`) permanently invalidates this turn's suggestion
  //    even if `draft` stays `''` and the quote is subsequently removed!
  machine.sync(baseEnv({ sessionId: 's-block', running: false, draft: '', hasInlineDecorators: true, turnHint: 1 }))
  assert.equal(machine.getVisibleSuggestion(), null)
  machine.sync(baseEnv({ sessionId: 's-block', running: false, draft: '', hasInlineDecorators: false, turnHint: 1 }))
  assert.equal(machine.getVisibleSuggestion(), null)

  machine.dispose()
})

test('P0 #1 (DOM + MutationObserver): NextStepOverlay yields to disabled/blocked composer, takeover wrapper, prompt denial, and quote nodes', async () => {
  let fetchCalls = 0
  let registeredOverlayComponent = null
  const mockReact = createMinimalReactHarness()

  // Stub global MutationObserver to verify DOM-only attribute mutations trigger re-sync without infinite loops.
  const prevMutationObserver = globalThis.MutationObserver
  const activeObservers = []
  globalThis.MutationObserver = class MockMutationObserver {
    constructor(cb) {
      this.cb = cb
      this.targets = []
      activeObservers.push(this)
    }
    observe(target, opts) { this.targets.push({ target, opts }) }
    disconnect() {
      const idx = activeObservers.indexOf(this)
      if (idx >= 0) activeObservers.splice(idx, 1)
    }
  }

  try {
    const clientPlugin = createClientPlugin(mockReact.React, {
      fetchImpl: async () => {
        fetchCalls += 1
        return {
          ok: true,
          json: async () => ({ status: 'ready', turn: 1, suggestion: '验证禁用态与引用块门控' }),
        }
      },
    })

    const cleanups = []
    clientPlugin.apply({
      effect(fn) {
        const c = fn()
        if (typeof c === 'function') cleanups.push(c)
        return c
      },
      locale: { register: () => () => {} },
      slots: {
        inject(_k, cb) { return cb() },
        register(_m, Comp) {
          registeredOverlayComponent = Comp
          return () => { registeredOverlayComponent = null }
        },
      },
    })

    const cardDom = createMockComposerCard()
    let agentRunning = true
    let promptGranted = false
    let planState = { active: false, pending: false }
    let occurrences = []

    const renderOverlay = () => mockReact.render(registeredOverlayComponent, {
      sessionId: 'dom-gate-session',
      useAccess: action => (action === 'session/prompt' ? promptGranted : true),
      useSession: sel => sel({ running: agentRunning, promptError: null, pendingSubmissions: [], subagent: null, removed: false }),
      useInput: sel => sel({ draft: '', draftRev: 0, attachmentIds: [], occurrences, phase: 'plain', queue: [] }),
      inputActions: { setDraft() {}, persistDraft() {} },
      useProjection: (key) => {
        if (key === 'turnOutline') return [{ turn: 1 }]
        if (key === 'plan') return planState
        return null
      },
      usePanelInfo: sel => sel({ activePanelId: null }),
    }, cardDom.anchorEl)

    // A. `useAccess('session/prompt') === false`: turn finishes -> zero fetches, null overlay.
    renderOverlay()
    agentRunning = false
    let vnode = renderOverlay()
    await flushMicrotasks()
    assert.equal(fetchCalls, 0)
    assert.equal(vnode.children[0], null)

    // B. Grant `session/prompt` access -> backfills once and renders ghost suggestion!
    promptGranted = true
    renderOverlay()
    await flushMicrotasks()
    vnode = renderOverlay()
    assert.equal(fetchCalls, 1)
    assert.ok(vnode.children[0] !== null)

    // Verify MutationObserver observed both cardEl and `[data-chain-overlay-fallback="conversation.composer"]`.
    assert.equal(activeObservers.length, 1)
    assert.equal(activeObservers[0].targets.length, 2)

    // C. Host sets `aria-disabled="true"` / `contenteditable="false"` on composer (`blocked` state) -> hides overlay so native block reason shows!
    cardDom.editorEl.setAttribute('aria-disabled', 'true')
    cardDom.editorEl.setAttribute('contenteditable', 'false')
    activeObservers[0].cb()
    vnode = renderOverlay()
    assert.equal(vnode.children[0], null)

    // Clearing `blocked` state restores suggestion without re-fetching.
    cardDom.editorEl.removeAttribute('aria-disabled')
    cardDom.editorEl.setAttribute('contenteditable', 'true')
    activeObservers[0].cb()
    vnode = renderOverlay()
    assert.equal(fetchCalls, 1)
    assert.ok(vnode.children[0] !== null)

    // D. `conversation.composer` takeover (`style.display = 'none'`) hides overlay, then restores when cleared.
    cardDom.setTakeoverActive(true)
    activeObservers[0].cb()
    vnode = renderOverlay()
    assert.equal(vnode.children[0], null)

    cardDom.setTakeoverActive(false)
    activeObservers[0].cb()
    vnode = renderOverlay()
    assert.ok(vnode.children[0] !== null)

    // D2. Plan Mode projection (`active` or `pending` toggle) hides overlay, then restores when exited.
    planState = { active: true, pending: false }
    vnode = renderOverlay()
    assert.equal(vnode.children[0], null)

    planState = { active: false, pending: false }
    vnode = renderOverlay()
    assert.ok(vnode.children[0] !== null)

    // E. Inserting an atomic reply quote (`[data-composer-quote]`) invalidates the turn permanently.
    cardDom.setQuotePresent(true)
    activeObservers[0].cb()
    vnode = renderOverlay()
    assert.equal(vnode.children[0], null)

    cardDom.setQuotePresent(false)
    activeObservers[0].cb()
    vnode = renderOverlay()
    assert.equal(vnode.children[0], null)

    // Also verify structured `input.occurrences` invalidates on a subsequent turn.
    agentRunning = true
    renderOverlay()
    agentRunning = false
    occurrences = [{ id: 'occ-1', start: 0, end: 5 }]
    renderOverlay()
    await flushMicrotasks()
    assert.equal(fetchCalls, 1)

    mockReact.unmount()
    assert.equal(activeObservers.length, 0)
    for (const c of cleanups) c()
  } finally {
    globalThis.MutationObserver = prevMutationObserver
  }
})

test('P0 #4 (Clickable/tappable Tab badge): clicking Tab pill accepts into draft, focuses unfocused editor, preserves tabIndex=-1, and ignores clicks when popup/disabled', async () => {
  let registeredOverlayComponent = null
  const mockReact = createMinimalReactHarness()
  let currentTurn = 1

  const clientPlugin = createClientPlugin(mockReact.React, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        status: 'ready',
        turn: currentTurn,
        suggestion: currentTurn === 1 ? '在触屏上点击 Tab 采纳草稿' : '第二次点击测试草稿',
      }),
    }),
  })

  const cleanups = []
  clientPlugin.apply({
    effect(fn) {
      const c = fn()
      if (typeof c === 'function') cleanups.push(c)
      return c
    },
    locale: { register: () => () => {} },
    slots: {
      inject(_k, cb) { return cb() },
      register(_m, Comp) {
        registeredOverlayComponent = Comp
        return () => { registeredOverlayComponent = null }
      },
    },
  })

  const cardDom = createMockComposerCard()
  let agentRunning = true
  let draftText = ''
  let draftRev = 0
  let persistedCount = 0
  let submittedCount = 0

  const inputActions = {
    setDraft(next) {
      draftText = next
      draftRev += 1
    },
    persistDraft() {
      persistedCount += 1
    },
    submit() {
      submittedCount += 1
    },
  }

  const renderOverlay = () => mockReact.render(registeredOverlayComponent, {
    sessionId: 'tap-accept-session',
    useSession: sel => sel({ running: agentRunning, promptError: null, pendingSubmissions: [], subagent: null, removed: false }),
    useInput: sel => sel({ draft: draftText, draftRev, attachmentIds: [], phase: 'plain', queue: [] }),
    inputActions,
    useProjection: key => (key === 'turnOutline' ? [{ turn: currentTurn }] : null),
    usePanelInfo: sel => sel({ activePanelId: null }),
  }, cardDom.anchorEl)

  renderOverlay()
  agentRunning = false
  renderOverlay()
  await flushMicrotasks()
  let vnode = renderOverlay()

  const ghostNode = vnode.children[0]
  assert.ok(ghostNode)
  const badgeBtn = ghostNode.children[1]
  assert.equal(badgeBtn.type, 'button')
  assert.equal(badgeBtn.props.type, 'button')
  assert.equal(badgeBtn.props.tabIndex, -1)
  assert.equal(badgeBtn.props['data-nss-accept'], '')
  assert.equal(badgeBtn.children[0], 'Tab')

  // Simulate unfocused editor (e.g. mobile touch or clicking directly while reading transcript).
  cardDom.doc.activeElement = null
  assert.equal(cardDom.editorEl.focusCalls.length, 0)

  // If a trigger popup opens right before click, click is safely ignored.
  cardDom.setPopupPresent(true)
  badgeBtn.props.onClick({ preventDefault() {}, stopPropagation() {} })
  assert.equal(draftText, '')
  cardDom.setPopupPresent(false)

  // Mouse down preserves focus without side effects; click accepts draft, persists, focuses editor, and does NOT submit!
  let mouseDownPrevented = false
  badgeBtn.props.onMouseDown({
    preventDefault() { mouseDownPrevented = true },
    stopPropagation() {},
  })
  assert.equal(mouseDownPrevented, true)

  let clickPrevented = false
  badgeBtn.props.onClick({
    preventDefault() { clickPrevented = true },
    stopPropagation() {},
  })
  assert.equal(clickPrevented, true)
  assert.equal(draftText, '在触屏上点击 Tab 采纳草稿')
  assert.equal(persistedCount, 1)
  assert.equal(submittedCount, 0)
  assert.equal(cardDom.editorEl.focusCalls.length, 1)
  assert.deepEqual(cardDom.editorEl.focusCalls[0], { preventScroll: true })
  assert.equal(cardDom.doc.activeElement, cardDom.editorEl)

  // Subsequent render hides the ghost preview and will not re-show if draft is cleared back to empty.
  vnode = renderOverlay()
  assert.equal(vnode.children[0], null)
  draftText = ''
  draftRev += 1
  vnode = renderOverlay()
  assert.equal(vnode.children[0], null)

  // Turn 2: when editor is ALREADY focused, clicking badge accepts without redundant `.focus()` call (preserving Lexical selection).
  currentTurn = 2
  agentRunning = true
  renderOverlay()
  agentRunning = false
  renderOverlay()
  await flushMicrotasks()
  vnode = renderOverlay()
  const badgeBtn2 = vnode.children[0].children[1]
  cardDom.doc.activeElement = cardDom.editorEl
  const focusCountBefore = cardDom.editorEl.focusCalls.length
  badgeBtn2.props.onClick({ preventDefault() {}, stopPropagation() {} })
  assert.equal(draftText, '第二次点击测试草稿')
  assert.equal(cardDom.editorEl.focusCalls.length, focusCountBefore)

  mockReact.unmount()
  for (const c of cleanups) c()
})
