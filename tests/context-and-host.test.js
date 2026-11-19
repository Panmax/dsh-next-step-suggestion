import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import { extractTurnContext, parseSuggestionOutput } from '../src/context.js'
import {
  CONFIG_ROUTE_PATH,
  createSuggestionCoordinator,
  createSuggestRouteHandler,
  resolveHostConfig,
  SUGGEST_ROUTE_PATH,
} from '../src/host.js'
import { apply as applyHostPlugin, Config as ExportedPluginConfig } from '../index.js'

function buildCompletedSessionEvents({
  turn = 1,
  userText = '帮我修复登录超时 bug',
  assistantText = '已修复登录超时重连逻辑，但尚未运行相关回归测试。',
  endReason = { kind: 'completed' },
  interrupted = false,
  toolCalls = ['read', 'edit', 'edit'],
  rawToolOutput = 'SECRET_RAW_TOOL_LOG_OUTPUT_SHOULD_NEVER_LEAK',
} = {}) {
  const events = [
    {
      type: 'system/message',
      seq: 0,
      data: { turn, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'SYSTEM_PROMPT_SECRET' }] } },
    },
    {
      type: 'turn/start',
      seq: 1,
      data: { turn },
    },
    {
      type: 'user/message',
      seq: 2,
      data: {
        role: 'user',
        source: { kind: 'user' },
        content: [
          {
            type: 'text',
            text: `${userText}<system-reminder>INTERNAL_REMINDER_DO_NOT_FORWARD</system-reminder>`,
          },
        ],
      },
    },
    {
      type: 'step/start',
      seq: 3,
      data: { turn, step: 1 },
    },
  ]

  let seq = 4
  for (const [idx, toolName] of toolCalls.entries()) {
    events.push({
      type: 'tool/call',
      seq: seq++,
      data: { turn, step: 1, callId: `call_${idx}`, name: toolName, arguments: '{"file":"huge_secret_arg"}' },
    })
    events.push({
      type: 'tool/result',
      seq: seq++,
      data: {
        turn,
        step: 1,
        message: { role: 'tool', content: [{ type: 'text', text: rawToolOutput }] },
      },
    })
  }

  events.push(
    {
      type: 'assistant/message',
      seq: seq++,
      data: {
        turn,
        step: 1,
        ...(interrupted ? { interrupted: true } : {}),
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'PRIVATE_REASONING_TRACE' },
            { type: 'text', text: assistantText },
          ],
        },
      },
    },
    {
      type: 'step/end',
      seq: seq++,
      data: { turn, step: 1 },
    },
    {
      type: 'turn/end',
      seq: seq++,
      data: { turn, reason: endReason },
    },
  )

  return events
}

test('extractTurnContext keeps only bounded recent context and excludes raw tool logs, system prompt, and reasoning', () => {
  const events = buildCompletedSessionEvents()
  const result = extractTurnContext(events, 6000)

  assert.equal(result.eligible, true)
  assert.equal(result.turn, 1)
  assert.match(result.promptInput, /修复登录超时 bug/)
  assert.match(result.promptInput, /尚未运行相关回归测试/)
  assert.match(result.promptInput, /"tool":"edit","count":2/)
  assert.doesNotMatch(result.promptInput, /SECRET_RAW_TOOL_LOG_OUTPUT_SHOULD_NEVER_LEAK/)
  assert.doesNotMatch(result.promptInput, /SYSTEM_PROMPT_SECRET/)
  assert.doesNotMatch(result.promptInput, /PRIVATE_REASONING_TRACE/)
  assert.doesNotMatch(result.promptInput, /INTERNAL_REMINDER_DO_NOT_FORWARD/)
  assert.doesNotMatch(result.promptInput, /huge_secret_arg/)
})

test('extractTurnContext skips streaming, aborted, errored, max-tokens, and interrupted turns', () => {
  const inProgress = buildCompletedSessionEvents().slice(0, -1)
  assert.deepEqual(extractTurnContext(inProgress, 6000), {
    eligible: false,
    turn: 1,
    reason: 'turn-in-progress',
  })

  for (const kind of ['aborted', 'error', 'max-tokens', 'blocked']) {
    const nonNormal = buildCompletedSessionEvents({ endReason: { kind } })
    const res = extractTurnContext(nonNormal, 6000)
    assert.equal(res.eligible, false)
    assert.equal(res.reason, kind)
  }

  const interrupted = buildCompletedSessionEvents({ interrupted: true })
  assert.equal(extractTurnContext(interrupted, 6000).eligible, false)
})

test('extractTurnContext enforces UTF-8 byte budget while preserving end-of-reply next-step cue', () => {
  const longPrefix = '修改详情说明。'.repeat(800)
  const tailCue = '最后提醒：尚未运行相关回归测试，建议下一步执行测试套件。'
  const events = buildCompletedSessionEvents({
    assistantText: `${longPrefix}\n${tailCue}`,
  })

  const extracted = extractTurnContext(events, 1200)
  assert.equal(extracted.eligible, true)
  assert.ok(Buffer.byteLength(extracted.promptInput, 'utf8') <= 1200)
  assert.match(extracted.promptInput, /尚未运行相关回归测试/)
})

test('parseSuggestionOutput cleans valid user prompts and rejects NONE, slash commands, code fences, and assistant-voice offers', () => {
  assert.equal(
    parseSuggestionOutput('“运行相关回归测试，并总结失败原因”\n附注解释会被忽略'),
    '运行相关回归测试，并总结失败原因',
  )
  assert.equal(
    parseSuggestionOutput('- **Run the regression suite and summarize any failing cases**'),
    'Run the regression suite and summarize any failing cases',
  )
  assert.equal(parseSuggestionOutput('NONE'), null)
  assert.equal(parseSuggestionOutput('none\n'), null)
  assert.equal(parseSuggestionOutput('无'), null)
  assert.equal(parseSuggestionOutput('/compact'), null)
  assert.equal(parseSuggestionOutput('```bash\nnpm test\n```'), null)
  assert.equal(parseSuggestionOutput('需要我帮你运行回归测试吗？'), null)
  assert.equal(parseSuggestionOutput('Would you like me to run the tests now?'), null)
  assert.equal(parseSuggestionOutput('继续等待子代理审查结果并输出收尾总结'), null)
  assert.equal(parseSuggestionOutput('等待后台任务完成'), null)
  assert.equal(parseSuggestionOutput('Continue waiting for the subagent result'), null)
  assert.equal(parseSuggestionOutput('Wait for the background job to finish'), null)
  // Human-only browser/UI actions may never be delegated back to the agent as a suggestion.
  assert.equal(parseSuggestionOutput('已硬刷新，麻烦按切走再切回的场景再验证一遍'), null)
  assert.equal(parseSuggestionOutput('请刷新页面后观察界面再确认一下'), null)
  assert.equal(parseSuggestionOutput('Please hard-refresh the page and verify it again'), null)
})

test('manual-verification replies reach the suggestion LLM, which decides NONE semantically across languages', async () => {
  const manualReply = '下一步（2分钟内）：硬刷新 http://127.0.0.1:3080，然后二选一测试：\n' +
    '- 在 A 发任务后切到 B，等 A 完成再切回 A；\n' +
    '如果仍没有，把新的 session id 和「切走/切回」的具体时间发我。'

  const events = buildCompletedSessionEvents({ turn: 4, assistantText: manualReply })
  const extracted = extractTurnContext(events, 6000)
  assert.equal(extracted.eligible, true)
  // The plugin no longer classifies the reply itself with language-specific regexes; the LLM sees the full reply.
  assert.equal('assistantAwaitsHumanAction' in extracted, false)
  assert.match(extracted.promptInput, /"assistantFinalReply":"下一步/)

  let llmCalls = 0
  const agent = {
    id: 'sess-manual',
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    model: { current: () => ({ provider: 'mock', model: 'fast' }) },
    session: {
      id: 'sess-manual',
      header: {},
      snapshotEvents: () => events,
    },
  }
  const coordinator = createSuggestionCoordinator({
    agents: { get: id => (id === 'sess-manual' ? agent : undefined) },
    llm: {
      async prepareCall(callConfig) {
        llmCalls += 1
        return {
          config: callConfig,
          async *stream() {
            yield { type: 'text-delta', index: 0, text: 'NONE' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
  }, { timeoutMs: 2000 })
  const outcome = await coordinator.suggest('sess-manual', 4)
  assert.deepEqual(outcome, { status: 'none', turn: 4, suggestion: null })
  assert.equal(llmCalls, 1)
})

test('resolveHostConfig validates bounds and provider/model pairing', () => {
  const defaults = resolveHostConfig()
  assert.equal(defaults.maxInputBytes, 6000)
  assert.equal(defaults.maxOutputTokens, 4096)
  assert.equal(defaults.timeoutMs, 30000)

  assert.throws(() => resolveHostConfig({ maxInputBytes: 0 }), /maxInputBytes/)
  assert.throws(() => resolveHostConfig({ provider: 'deepseek' }), /together/)
  const explicit = resolveHostConfig({ provider: 'deepseek', model: 'deepseek-chat', timeoutMs: 5000 })
  assert.equal(explicit.provider, 'deepseek')
  assert.equal(explicit.model, 'deepseek-chat')
})

test('coordinator calls LLM at most once per completed turn, passes no tools, writes no session events, and aborts on new turn', async () => {
  let llmCalls = 0
  let capturedOptions = null
  let sessionAppends = 0

  const agent = {
    id: 'sess-1',
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    model: {
      current: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
    },
    session: {
      id: 'sess-1',
      header: {},
      snapshotEvents: () => buildCompletedSessionEvents({ turn: 3 }),
      append: () => { sessionAppends += 1 },
    },
  }

  const ctx = {
    agents: {
      get: id => (id === 'sess-1' ? agent : undefined),
    },
    llm: {
      async prepareCall(config, signal, configure) {
        llmCalls += 1
        const merged = configure
          ? configure(config, { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } })
          : config
        return {
          config: merged,
          async *stream(options) {
            capturedOptions = options
            yield { type: 'text-delta', index: 0, text: '运行相关回归测试，' }
            yield { type: 'text-delta', index: 0, text: '并总结失败原因' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
  }

  const coordinator = createSuggestionCoordinator(ctx, { timeoutMs: 3000 })

  // Concurrent + repeated calls for the same (sessionId, turn) must share 1 LLM call.
  const [first, second] = await Promise.all([
    coordinator.suggest('sess-1', 3),
    coordinator.suggest('sess-1', 3),
  ])
  const third = await coordinator.suggest('sess-1', 3)

  assert.equal(llmCalls, 1)
  assert.equal(sessionAppends, 0)
  assert.equal(capturedOptions.tools, undefined)
  assert.equal(capturedOptions.reasoningEffort, 'low')
  assert.deepEqual(first, {
    status: 'ready',
    turn: 3,
    suggestion: '运行相关回归测试，并总结失败原因',
  })
  assert.deepEqual(second, first)
  assert.deepEqual(third, first)

  // Now simulate turn 4 in flight, then aborted when a new turn starts mid-generation.
  let observedAbort = false
  let releaseStream
  const streamGate = new Promise((resolve) => { releaseStream = resolve })

  agent.session.snapshotEvents = () => buildCompletedSessionEvents({ turn: 4 })
  ctx.llm.prepareCall = async (config, signal) => {
    llmCalls += 1
    signal.addEventListener('abort', () => {
      observedAbort = true
      releaseStream()
    })
    return {
      config,
      async *stream() {
        await streamGate
        yield { type: 'text-delta', index: 0, text: '过期的建议' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
  }

  const pendingTurn4 = coordinator.suggest('sess-1', 4)
  await new Promise(r => setTimeout(r, 10))
  coordinator.abortSessionInflight('sess-1')

  const cancelledOutcome = await pendingTurn4
  assert.equal(observedAbort, true)
  assert.equal(cancelledOutcome.status, 'stale')
  assert.equal(cancelledOutcome.suggestion, null)
})

test('Host plugin route enforces auth, method/media-type checks, and cleans up on fiber disposal', async () => {
  const effects = []
  const listeners = new Map()
  const routes = new Map()
  let authRejection = undefined

  const agent = {
    id: 'sess-http',
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    model: { current: () => ({ provider: 'mock', model: 'fast' }) },
    session: {
      id: 'sess-http',
      header: {},
      snapshotEvents: () => buildCompletedSessionEvents({ turn: 1 }),
    },
  }

  const ctx = {
    effect(fn) {
      const cleanup = fn()
      if (typeof cleanup === 'function') effects.push(cleanup)
      return cleanup
    },
    on(event, fn) {
      listeners.set(event, fn)
      return () => { listeners.delete(event) }
    },
    connection: {
      requestRejection: () => authRejection,
    },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    },
    agents: {
      get: id => (id === 'sess-http' ? agent : undefined),
    },
    llm: {
      async prepareCall(config) {
        return {
          config,
          async *stream() {
            yield { type: 'text-delta', index: 0, text: '执行单元测试并确认修复结果' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
  }

  applyHostPlugin(ctx, { timeoutMs: 2000 })
  assert.equal(routes.has(SUGGEST_ROUTE_PATH), true)

  async function invokeRoute({ method = 'POST', contentType = 'application/json', body = '' } = {}) {
    const handler = routes.get(SUGGEST_ROUTE_PATH)
    const req = Readable.from(body ? [Buffer.from(body, 'utf8')] : [])
    req.method = method
    req.headers = contentType ? { 'content-type': contentType } : {}
    let statusCode = 200
    const headers = new Map()
    let rawBody = ''
    const res = {
      get statusCode() { return statusCode },
      set statusCode(v) { statusCode = v },
      setHeader(k, v) { headers.set(k.toLowerCase(), v) },
      end(chunk = '') { rawBody += String(chunk) },
    }
    await handler(req, res)
    return { statusCode, headers, rawBody, json: rawBody ? JSON.parse(rawBody) : null }
  }

  authRejection = 401
  const unauth = await invokeRoute({ body: JSON.stringify({ sessionId: 'sess-http' }) })
  assert.equal(unauth.statusCode, 401)

  authRejection = undefined
  const wrongMethod = await invokeRoute({ method: 'GET' })
  assert.equal(wrongMethod.statusCode, 405)

  const wrongMedia = await invokeRoute({ contentType: 'text/plain', body: '{}' })
  assert.equal(wrongMedia.statusCode, 415)

  const ok = await invokeRoute({ body: JSON.stringify({ sessionId: 'sess-http', expectedTurn: 1 }) })
  assert.equal(ok.statusCode, 200)
  assert.deepEqual(ok.json, {
    status: 'ready',
    turn: 1,
    suggestion: '执行单元测试并确认修复结果',
  })

  // Disposing plugin effects removes the HTTP route cleanly.
  for (const cleanup of effects.splice(0)) cleanup()
  assert.equal(routes.has(SUGGEST_ROUTE_PATH), false)
})

test('requireLiveCompletion skips cold historical sessions while allowing background-completed live turns', async () => {
  let llmCalls = 0
  const agent = {
    id: 'sess-bg',
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    model: { current: () => ({ provider: 'mock', model: 'fast' }) },
    session: {
      id: 'sess-bg',
      header: {},
      snapshotEvents: () => buildCompletedSessionEvents({ turn: 2 }),
    },
  }

  const ctx = {
    agents: { get: id => (id === 'sess-bg' ? agent : undefined) },
    llm: {
      async prepareCall(config) {
        llmCalls += 1
        return {
          config,
          async *stream() {
            yield { type: 'text-delta', index: 0, text: '查看后台任务的变更摘要' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
  }

  const coordinator = createSuggestionCoordinator(ctx, { timeoutMs: 2000 })

  // Cold historical session never observed completing live -> skipped with 0 LLM calls.
  const cold = await coordinator.suggest('sess-bg', 2, { requireLiveCompletion: true })
  assert.equal(cold.status, 'ineligible')
  assert.equal(cold.reason, 'historical-turn')
  assert.equal(llmCalls, 0)

  // Once Host observes a live `turn/end` (`completed`) for turn 2, background backfill succeeds!
  coordinator.markLiveTurnCompleted('sess-bg', 2)
  const backfilled = await coordinator.suggest('sess-bg', 2, { requireLiveCompletion: true })
  assert.equal(llmCalls, 1)
  assert.deepEqual(backfilled, {
    status: 'ready',
    turn: 2,
    suggestion: '查看后台任务的变更摘要',
  })
})

test('extractTurnContext derives sanitized boolean toolFeatures without leaking raw command secrets', () => {
  const events = [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 2,
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '修复测试并提交推送' }] },
    },
    {
      type: 'tool/call',
      seq: 3,
      data: { turn: 1, step: 1, name: 'edit', arguments: '{"file_path":"src/a.js"}' },
    },
    {
      type: 'tool/call',
      seq: 4,
      data: {
        turn: 1,
        step: 1,
        name: 'bash',
        arguments: JSON.stringify({ command: 'TOKEN=TOP_SECRET_VAL npm test && git commit -m "fix" && git push' }),
      },
    },
    {
      type: 'assistant/message',
      seq: 5,
      data: {
        turn: 1,
        step: 2,
        message: { role: 'assistant', content: [{ type: 'text', text: '已修改文件、跑通测试并完成推送。' }] },
      },
    },
    { type: 'turn/end', seq: 6, data: { turn: 1, reason: { kind: 'completed' } } },
  ]

  const res = extractTurnContext(events, 6000)
  assert.equal(res.eligible, true)
  assert.match(res.promptInput, /"ranTests":true/)
  assert.match(res.promptInput, /"ranGitCommit":true/)
  assert.match(res.promptInput, /"ranGitPush":true/)
  assert.match(res.promptInput, /"editedFiles":true/)
  assert.doesNotMatch(res.promptInput, /TOP_SECRET_VAL/)

  // Malformed JSON in tool/call arguments must NOT match non-command prose fields, while >4 KB valid JSON still extracts command.
  const edgeEvents = [
    { type: 'turn/start', seq: 1, data: { turn: 2 } },
    {
      type: 'user/message',
      seq: 2,
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '生成长脚本并测试' }] },
    },
    {
      type: 'tool/call',
      seq: 3,
      data: { turn: 2, step: 1, name: 'bash', arguments: '{"description":"Do not git push yet","command":"incomplete' },
    },
    {
      type: 'tool/call',
      seq: 4,
      data: { turn: 2, step: 1, name: 'bash', arguments: JSON.stringify({ command: `echo "${'x'.repeat(5000)}" && npm test` }) },
    },
    {
      type: 'assistant/message',
      seq: 5,
      data: { turn: 2, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: '长脚本测试已通过。' }] } },
    },
    { type: 'turn/end', seq: 6, data: { turn: 2, reason: { kind: 'completed' } } },
  ]
  const edgeRes = extractTurnContext(edgeEvents, 6000)
  assert.equal(edgeRes.eligible, true)
  assert.match(edgeRes.promptInput, /"ranTests":true/)
  assert.match(edgeRes.promptInput, /"ranGitPush":false/)
})

test('Standard Schema Config validator, unknown key rejection, armed goal gate, and /api/next-step-suggestion/config GET/POST', async () => {
  // 1. Unknown config keys and Standard Schema v1 contract.
  assert.throws(() => resolveHostConfig({ maxOutputToken: 1024 }), /unknown config key "maxOutputToken"/)
  assert.equal(ExportedPluginConfig['~standard'].version, 1)
  const validSchemaRes = ExportedPluginConfig['~standard'].validate({ timeoutMs: 15000 })
  assert.equal(validSchemaRes.issues, undefined)
  assert.equal(validSchemaRes.value.timeoutMs, 15000)
  const undefSchemaRes = ExportedPluginConfig['~standard'].validate(undefined)
  assert.equal(undefSchemaRes.issues, undefined)
  const nullSchemaRes = ExportedPluginConfig['~standard'].validate(null)
  assert.ok(Array.isArray(nullSchemaRes.issues) && nullSchemaRes.issues.length === 1)
  const invalidSchemaRes = ExportedPluginConfig['~standard'].validate({ typoField: true })
  assert.ok(Array.isArray(invalidSchemaRes.issues) && invalidSchemaRes.issues.length === 1)

  // 2. Host config route + armed Goal gate.
  const effects = []
  const routes = new Map()
  let authRejection
  let persistedConfig = null
  let shouldRejectSave = false
  let editorAvailable = true
  let entryAddressable = true
  let goalArmed = false
  let subagentRunning = false
  let bgJobRunning = false
  const usedRoutes = []
  let currentTurn = 1

  const fakeEntry = { options: { id: 'next-step-suggestion' } }
  const agent = {
    id: 'sess-cfg',
    status: 'idle',
    inbox: { nextTurn: [], nextStep: [] },
    model: { current: () => ({ provider: 'anthropic', model: 'claude-opus-4-6' }) },
    session: {
      id: 'sess-cfg',
      header: {},
      snapshotEvents: () => buildCompletedSessionEvents({ turn: currentTurn }),
    },
  }
  const childAgent = {
    id: 'sess-child-1',
    get status() { return subagentRunning ? 'running' : 'idle' },
    session: {
      id: 'sess-child-1',
      header: { origin: 'subagent', parentSession: 'sess-cfg' },
    },
  }

  const ctx = {
    fiber: { entry: fakeEntry },
    effect(fn) {
      const c = fn()
      if (typeof c === 'function') effects.push(c)
      return c
    },
    on() { return () => {} },
    get(key) {
      if (key === 'configEditor') {
        return editorAvailable
          ? {
              entries: () => (entryAddressable ? [fakeEntry] : []),
              async edit(entry, change) {
                assert.equal(entry, fakeEntry)
                if (shouldRejectSave) throw new Error('Overridden by command-line overlay')
                persistedConfig = change(persistedConfig ?? {}, { maxInputBytes: 6000, maxOutputTokens: 4096, timeoutMs: 30000 })
              },
            }
          : undefined
      }
      if (key === 'jobs') {
        return {
          list: caller => (caller === 'sess-cfg' && bgJobRunning ? [{ id: 'job-1', status: 'running' }] : []),
        }
      }
      if (key === 'goal') {
        return {
          get: () => (goalArmed ? { goal: { phase: 'active' }, activation: 'armed' } : undefined),
        }
      }
      if (key === 'agentDefaultModel') {
        return { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-reasoner' }) }
      }
      return ctx[key]
    },
    connection: { requestRejection: () => authRejection },
    webServer: {
      register(route) {
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    },
    agents: {
      get: id => (id === 'sess-cfg' ? agent : (id === 'sess-child-1' ? childAgent : undefined)),
      list: () => [agent, childAgent],
    },
    llm: {
      listProviders: () => [
        { id: 'deepseek', name: 'DeepSeek' },
        { id: 'broken-provider', name: 'Broken' },
      ],
      async listModels(providerId) {
        if (providerId === 'broken-provider') throw new Error('Adapter unreachable')
        return [
          { provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' },
          { provider: 'deepseek', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
        ]
      },
      async prepareCall(callCfg) {
        usedRoutes.push({ provider: callCfg.provider, model: callCfg.model, maxTokens: callCfg.maxTokens })
        return {
          config: callCfg,
          async *stream() {
            yield { type: 'text-delta', index: 0, text: '检查配置保存结果' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
  }

  applyHostPlugin(ctx, { timeoutMs: 25000 })
  assert.equal(routes.has(CONFIG_ROUTE_PATH), true)

  async function callRoute(path, { method = 'GET', contentType = 'application/json', body = '' } = {}) {
    const handler = routes.get(path)
    const req = Readable.from(body ? [Buffer.from(body, 'utf8')] : [])
    req.method = method
    req.headers = contentType ? { 'content-type': contentType } : {}
    let statusCode = 200
    const headers = new Map()
    let rawBody = ''
    const res = {
      get statusCode() { return statusCode },
      set statusCode(v) { statusCode = v },
      setHeader(k, v) { headers.set(k.toLowerCase(), v) },
      end(chunk = '') { rawBody += String(chunk) },
    }
    await handler(req, res)
    return { statusCode, headers, json: rawBody ? JSON.parse(rawBody) : null }
  }

  // Auth enforced on config route.
  authRejection = 403
  assert.equal((await callRoute(CONFIG_ROUTE_PATH)).statusCode, 403)
  authRejection = undefined

  // GET returns current config, defaults, editable=true, defaultRoute, and catalog (broken adapter gracefully yields []).
  const getRes = await callRoute(CONFIG_ROUTE_PATH)
  assert.equal(getRes.statusCode, 200)
  assert.equal(getRes.json.editable, true)
  assert.equal(getRes.json.config.timeoutMs, 25000)
  assert.equal(getRes.json.config.provider, null)
  assert.deepEqual(getRes.json.defaultRoute, { provider: 'deepseek', model: 'deepseek-reasoner' })
  assert.equal(getRes.json.providers.length, 2)
  assert.equal(getRes.json.providers[0].models.length, 2)
  assert.deepEqual(getRes.json.providers[1].models, [])

  // POST rejects unknown keys or mismatched provider/model with 400.
  const badKey = await callRoute(CONFIG_ROUTE_PATH, {
    method: 'POST',
    body: JSON.stringify({ maxInputBytes: 6000, maxOutputTokens: 4096, timeoutMs: 30000, extraKey: 1 }),
  })
  assert.equal(badKey.statusCode, 400)
  assert.equal(badKey.json.code, 'invalid-config')

  // POST surfaces missing configEditor with 409.
  editorAvailable = false
  const noEditor = await callRoute(CONFIG_ROUTE_PATH, {
    method: 'POST',
    body: JSON.stringify({ maxInputBytes: 6000, maxOutputTokens: 4096, timeoutMs: 20000, provider: null, model: null }),
  })
  assert.equal(noEditor.statusCode, 409)
  assert.equal(noEditor.json.code, 'config-editor-unavailable')
  editorAvailable = true

  // POST surfaces higher-layer override error with 409.
  shouldRejectSave = true
  const rejectedSave = await callRoute(CONFIG_ROUTE_PATH, {
    method: 'POST',
    body: JSON.stringify({ maxInputBytes: 6000, maxOutputTokens: 4096, timeoutMs: 20000, provider: 'deepseek', model: 'deepseek-chat' }),
  })
  assert.equal(rejectedSave.statusCode, 409)
  assert.match(rejectedSave.json.message, /Overridden by command-line overlay/)
  shouldRejectSave = false

  // Non-addressable entry reports editable=false on GET.
  entryAddressable = false
  assert.equal((await callRoute(CONFIG_ROUTE_PATH)).json.editable, false)
  entryAddressable = true

  // Armed Goal session is skipped on Host (`goal-active`).
  goalArmed = true
  const goalRes = await callRoute(SUGGEST_ROUTE_PATH, {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'sess-cfg', expectedTurn: 1 }),
  })
  assert.equal(goalRes.json.status, 'ineligible')
  assert.equal(goalRes.json.reason, 'goal-active')
  assert.equal(usedRoutes.length, 0)
  goalArmed = false

  // Running descendant subagent skips suggestion generation (`subagent-running`).
  subagentRunning = true
  const subRes = await callRoute(SUGGEST_ROUTE_PATH, {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'sess-cfg', expectedTurn: 1 }),
  })
  assert.equal(subRes.json.status, 'ineligible')
  assert.equal(subRes.json.reason, 'subagent-running')
  assert.equal(usedRoutes.length, 0)
  subagentRunning = false

  // Running background job skips suggestion generation (`background-job-running`).
  bgJobRunning = true
  const jobRes = await callRoute(SUGGEST_ROUTE_PATH, {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'sess-cfg', expectedTurn: 1 }),
  })
  assert.equal(jobRes.json.status, 'ineligible')
  assert.equal(jobRes.json.reason, 'background-job-running')
  assert.equal(usedRoutes.length, 0)
  bgJobRunning = false

  // Before pinning a model, suggest uses session's model (`anthropic/claude-opus-4-6`).
  await callRoute(SUGGEST_ROUTE_PATH, {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'sess-cfg', expectedTurn: 1 }),
  })
  assert.deepEqual(usedRoutes[0], { provider: 'anthropic', model: 'claude-opus-4-6', maxTokens: 4096 })

  // POST pins lightweight `deepseek/deepseek-chat` and `maxOutputTokens: 2048` -> persists via ConfigEditor & switches route immediately!
  const savedCustom = await callRoute(CONFIG_ROUTE_PATH, {
    method: 'POST',
    body: JSON.stringify({
      maxInputBytes: 5000,
      maxOutputTokens: 2048,
      timeoutMs: 15000,
      provider: 'deepseek',
      model: 'deepseek-chat',
    }),
  })
  assert.equal(savedCustom.statusCode, 200)
  assert.deepEqual(persistedConfig, {
    maxInputBytes: 5000,
    maxOutputTokens: 2048,
    timeoutMs: 15000,
    provider: 'deepseek',
    model: 'deepseek-chat',
  })

  currentTurn = 2
  await callRoute(SUGGEST_ROUTE_PATH, {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'sess-cfg', expectedTurn: 2 }),
  })
  assert.deepEqual(usedRoutes[1], { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 2048 })

  // POST with `provider: null, model: null` omits route keys cleanly so ConfigEditor can drop redundant overrides.
  const resetRes = await callRoute(CONFIG_ROUTE_PATH, {
    method: 'POST',
    body: JSON.stringify({
      maxInputBytes: 6000,
      maxOutputTokens: 4096,
      timeoutMs: 30000,
      provider: null,
      model: null,
    }),
  })
  assert.equal(resetRes.statusCode, 200)
  assert.deepEqual(persistedConfig, {
    maxInputBytes: 6000,
    maxOutputTokens: 4096,
    timeoutMs: 30000,
  })

  for (const c of effects.splice(0)) c()
  assert.equal(routes.has(CONFIG_ROUTE_PATH), false)
})
