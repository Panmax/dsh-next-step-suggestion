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
  assert.match(detailEn, /^!\[[^\]]+\]\(preview\.svg\)$/)
  assert.match(detailZh, /^!\[[^\]]+\]\(preview\.zh\.svg\)$/)

  const icon = readFileSync(resolve(rootDir, 'icon.svg'), 'utf8')
  assert.match(icon, /viewBox="0 0 36 36"/)
  assert.doesNotMatch(icon, /<(?:script|style|text|image|foreignObject)\b/i)

  for (const svgRelPath of [
    'docs/preview.svg',
    'docs/preview.zh.svg',
    'docs/step-1-ghost.svg',
    'docs/step-2-accepted.svg',
    'docs/step-1-ghost.zh.svg',
    'docs/step-2-accepted.zh.svg',
  ]) {
    const svg = readFileSync(resolve(rootDir, svgRelPath), 'utf8')
    assert.match(svg, /^<svg\b/)
    assert.doesNotMatch(svg, /<(?:script|style|text|image|foreignObject)\b/i)
  }

  // Client CSS must use theme tokens only (no hardcoded hex/rgb colors).
  assert.doesNotMatch(SUGGESTION_CSS, /#[0-9a-fA-F]{3,8}\b|rgba?\(/u)
  assert.match(SUGGESTION_CSS, /var\(--dsw-/)
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
  const editorEl = {
    hasAttribute: () => false,
    contains: target => target === editorEl,
  }
  const scrollEl = { offsetTop: 8 }
  const doc = { activeElement: editorEl, querySelector: () => null }
  const overlayHost = { children: [] }
  const cardEl = {
    ownerDocument: doc,
    querySelector(sel) {
      if (sel === '[data-input-scroll] [contenteditable]') return editorEl
      if (sel === '[data-input-scroll]') return scrollEl
      if (sel === '[data-composer-overlay]') return overlayHost
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
    overlayHost,
    doc,
    dispatchKeyDown(ev) {
      for (const fn of listeners.get('keydown') ?? []) fn(ev)
    },
  }
}
