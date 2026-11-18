import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'

import { extractTurnContext, parseSuggestionOutput } from '../src/context.js'
import {
  createSuggestionCoordinator,
  createSuggestRouteHandler,
  resolveHostConfig,
  SUGGEST_ROUTE_PATH,
} from '../src/host.js'
import { apply as applyHostPlugin } from '../index.js'

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
