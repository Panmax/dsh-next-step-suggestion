/**
 * Host-side suggestion coordinator and authenticated HTTP route handler.
 */

import { extractTurnContext, parseSuggestionOutput, SUGGESTION_SYSTEM_PROMPT } from './context.js'

export const SUGGEST_ROUTE_PATH = '/api/next-step-suggestion/suggest'
export const CONFIG_ROUTE_PATH = '/api/next-step-suggestion/config'

const DEFAULT_MAX_INPUT_BYTES = 6000
const DEFAULT_MAX_OUTPUT_TOKENS = 4096
const DEFAULT_TIMEOUT_MS = 30000
const MAX_TIMEOUT_MS = 300_000
const MAX_SETTLED_ENTRIES = 200
const MAX_REQUEST_BODY_BYTES = 16 * 1024
const CATALOG_PROVIDER_TIMEOUT_MS = 3000

export const DEFAULT_HOST_CONFIG = Object.freeze({
  maxInputBytes: DEFAULT_MAX_INPUT_BYTES,
  maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
})

const CONFIG_KEYS = new Set([
  'maxInputBytes',
  'maxOutputTokens',
  'timeoutMs',
  'provider',
  'model',
])

/**
 * Validate and resolve plugin configuration with explicit defaults and strict key whitelist.
 * @param {Record<string, unknown> | undefined} raw
 */
export function resolveHostConfig(raw = {}) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('dsh-next-step-suggestion: config must be an object')
  }
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`dsh-next-step-suggestion: unknown config key "${key}"`)
    }
  }
  const maxInputBytes = raw.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES
  const maxOutputTokens = raw.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
  const timeoutMs = raw.timeoutMs ?? DEFAULT_TIMEOUT_MS

  for (const [field, value] of [
    ['maxInputBytes', maxInputBytes],
    ['maxOutputTokens', maxOutputTokens],
    ['timeoutMs', timeoutMs],
  ]) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new Error(`dsh-next-step-suggestion: ${field} must be a positive integer`)
    }
  }
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`dsh-next-step-suggestion: timeoutMs must not exceed ${MAX_TIMEOUT_MS}`)
  }

  const hasProvider = raw.provider !== undefined
  const hasModel = raw.model !== undefined
  if (hasProvider !== hasModel) {
    throw new Error('dsh-next-step-suggestion: provider and model must be configured together')
  }
  if (hasProvider && (typeof raw.provider !== 'string' || raw.provider.trim() === '' || typeof raw.model !== 'string' || raw.model.trim() === '')) {
    throw new Error('dsh-next-step-suggestion: provider and model must be non-empty strings')
  }

  return Object.freeze({
    maxInputBytes,
    maxOutputTokens,
    timeoutMs,
    ...(hasProvider ? { provider: raw.provider.trim(), model: raw.model.trim() } : {}),
  })
}

/**
 * Zero-dependency Standard Schema v1 validator for Cordis Loader & ConfigEditor.
 */
export const HostConfigSchema = Object.freeze({
  '~standard': Object.freeze({
    version: 1,
    vendor: 'dsh-next-step-suggestion',
    validate(input) {
      try {
        return { value: resolveHostConfig(input) }
      } catch (err) {
        return { issues: [{ message: err instanceof Error ? err.message : String(err) }] }
      }
    },
  }),
})

/**
 * Resolve optional or injected service from Cordis context.
 * @param {any} ctx
 * @param {string} key
 */
function getService(ctx, key) {
  if (ctx && typeof ctx.get === 'function') {
    const found = ctx.get(key)
    if (found !== undefined) return found
  }
  return ctx?.[key]
}

/**
 * Resolve the model route for one background suggestion call.
 * @param {any} ctx
 * @param {any} agent
 * @param {ReturnType<typeof resolveHostConfig>} config
 * @returns {{ provider: string, model: string } | null}
 */
export function resolveModelRoute(ctx, agent, config) {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  const agentChoice = agent?.model?.current?.()
  if (agentChoice && typeof agentChoice.provider === 'string' && agentChoice.provider.length > 0
    && typeof agentChoice.model === 'string' && agentChoice.model.length > 0) {
    return { provider: agentChoice.provider, model: agentChoice.model }
  }
  const headerConfig = agent?.session?.requestHeader?.()?.config
  if (headerConfig && typeof headerConfig.provider === 'string' && headerConfig.provider.length > 0
    && typeof headerConfig.model === 'string' && headerConfig.model.length > 0) {
    return { provider: headerConfig.provider, model: headerConfig.model }
  }
  const defaultModel = getService(ctx, 'agentDefaultModel')?.currentSelection?.()
  if (defaultModel && typeof defaultModel.provider === 'string' && defaultModel.provider.length > 0
    && typeof defaultModel.model === 'string' && defaultModel.model.length > 0) {
    return { provider: defaultModel.provider, model: defaultModel.model }
  }
  return null
}

function isDescendantOfSession(agentsSvc, candidateAgent, targetSessionId) {
  if (!candidateAgent || !candidateAgent.session) return false
  const visited = new Set([candidateAgent.id])
  let header = candidateAgent.session.header
  while (header?.origin === 'subagent' && typeof header.parentSession === 'string' && !visited.has(header.parentSession)) {
    const parentId = header.parentSession
    if (parentId === targetSessionId) return true
    visited.add(parentId)
    const parentAgent = agentsSvc?.get?.(parentId)
    if (!parentAgent?.session) break
    header = parentAgent.session.header
  }
  return false
}

function hasRunningDescendantSubagent(ctx, sessionId) {
  const agentsSvc = getService(ctx, 'agents')
  const allAgents = typeof agentsSvc?.list === 'function' ? agentsSvc.list() : null
  if (!Array.isArray(allAgents)) return false
  return allAgents.some(
    candidate => candidate && candidate.id !== sessionId && candidate.status === 'running'
      && isDescendantOfSession(agentsSvc, candidate, sessionId),
  )
}

function hasRunningSessionJob(ctx, sessionId) {
  const jobsSvc = getService(ctx, 'jobs')
  if (typeof jobsSvc?.list !== 'function') return false
  const jobs = jobsSvc.list(sessionId)
  return Array.isArray(jobs) && jobs.some(job => job && (job.status === 'running' || job.status === 'stopping'))
}

/**
 * Check whether an agent is currently idle in a foreground-eligible session with no queued input
 * and no active background subagents, background jobs, or armed goal continuations.
 * @param {any} ctx
 * @param {any} agent
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function checkAgentIdle(ctx, agent) {
  if (!agent || !agent.session) return { ok: false, reason: 'agent-not-found' }
  if (agent.session.header?.origin === 'subagent') return { ok: false, reason: 'subagent' }
  if (agent.status !== 'idle') return { ok: false, reason: 'agent-running' }
  if ((agent.inbox?.nextTurn?.length ?? 0) > 0 || (agent.inbox?.nextStep?.length ?? 0) > 0) {
    return { ok: false, reason: 'inbox-pending' }
  }
  if (hasRunningDescendantSubagent(ctx, agent.id)) {
    return { ok: false, reason: 'subagent-running' }
  }
  if (hasRunningSessionJob(ctx, agent.id)) {
    return { ok: false, reason: 'background-job-running' }
  }
  try {
    const goalView = getService(ctx, 'goal')?.get?.(agent)
    if (goalView?.goal?.phase === 'active' && goalView?.activation === 'armed') {
      return { ok: false, reason: 'goal-active' }
    }
  } catch {
    // Ignore optional goal service lookup errors on mock agents.
  }
  return { ok: true }
}

/**
 * Execute a single tool-free, non-logged LLM stream for suggestion text.
 * @param {any} llm
 * @param {{ provider: string, model: string }} route
 * @param {string} promptInput
 * @param {ReturnType<typeof resolveHostConfig>} config
 * @param {AbortSignal} signal
 * @returns {Promise<string | null>}
 */
async function runSuggestionLlmCall(llm, route, promptInput, config, signal) {
  signal.throwIfAborted()

  const prepared = typeof llm.prepareCall === 'function'
    ? await llm.prepareCall(
        {
          provider: route.provider,
          model: route.model,
          maxTokens: config.maxOutputTokens,
        },
        signal,
        (controls, modelInfo) => {
          const leastEffort = modelInfo?.reasoning?.efforts?.[0]?.id
          return leastEffort === undefined ? controls : { ...controls, reasoningEffort: leastEffort }
        },
      )
    : {
        config: {
          provider: route.provider,
          model: route.model,
          maxTokens: config.maxOutputTokens,
        },
        stream: options => llm.stream(options),
      }

  signal.throwIfAborted()

  const options = Object.freeze({
    ...prepared.config,
    system: SUGGESTION_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: promptInput }],
      },
    ],
    signal,
  })

  const deltaByBlock = new Map()
  const blockEndTexts = []
  let finishKind = 'stop'

  for await (const chunk of prepared.stream(options)) {
    signal.throwIfAborted()
    if (!chunk || typeof chunk !== 'object') continue
    switch (chunk.type) {
      case 'block-start':
        if (chunk.blockType === 'tool-call') return null
        break
      case 'tool-call-delta':
        return null
      case 'text-delta':
        if (typeof chunk.text === 'string') {
          const idx = typeof chunk.index === 'number' ? chunk.index : 0
          deltaByBlock.set(idx, (deltaByBlock.get(idx) ?? '') + chunk.text)
        }
        break
      case 'block-end':
        if (chunk.block?.type === 'tool-call') return null
        if (chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
          blockEndTexts.push(chunk.block.text)
        }
        break
      case 'finish':
        finishKind = chunk.reason?.kind ?? 'error'
        break
      default:
        break
    }
  }

  if (finishKind !== 'stop') return null

  const assembled = deltaByBlock.size > 0
    ? [...deltaByBlock.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join('')
    : blockEndTexts.join('')

  return parseSuggestionOutput(assembled)
}

/**
 * Create the stateful Host suggestion service with per-(sessionId, turn) single-flight & idempotency guarantees.
 * @param {any} ctx
 * @param {Record<string, unknown> | undefined} rawConfig
 */
export function createSuggestionCoordinator(ctx, rawConfig = {}) {
  let config = resolveHostConfig(rawConfig)
  /** @type {Map<string, { sessionId: string, turn: number, suggestion: string | null }>} */
  const settled = new Map()
  /** @type {Map<string, { sessionId: string, turn: number, abortController: AbortController, invalidated: boolean, promise: Promise<{ status: string, turn: number | null, suggestion: string | null, reason?: string }> }>} */
  const inflight = new Map()
  /** @type {Map<string, number>} Latest turn observed completing live per session (enables background-turn backfill without firing on cold historical sessions). */
  const liveCompletedTurns = new Map()
  let disposed = false

  function recordSettled(key, entry) {
    if (settled.has(key)) settled.delete(key)
    settled.set(key, entry)
    while (settled.size > MAX_SETTLED_ENTRIES) {
      const oldest = settled.keys().next().value
      if (oldest === undefined) break
      settled.delete(oldest)
    }
  }

  function markLiveTurnCompleted(sessionId, turn) {
    if (disposed || typeof sessionId !== 'string' || typeof turn !== 'number') return
    if (liveCompletedTurns.has(sessionId)) liveCompletedTurns.delete(sessionId)
    liveCompletedTurns.set(sessionId, turn)
    while (liveCompletedTurns.size > MAX_SETTLED_ENTRIES) {
      const oldest = liveCompletedTurns.keys().next().value
      if (oldest === undefined) break
      liveCompletedTurns.delete(oldest)
    }
  }

  function clearLiveTurnCompleted(sessionId) {
    liveCompletedTurns.delete(sessionId)
  }

  function abortSessionInflight(sessionId) {
    clearLiveTurnCompleted(sessionId)
    for (const [key, active] of inflight.entries()) {
      if (active.sessionId === sessionId) {
        active.invalidated = true
        active.abortController.abort(new Error('SESSION_INVALIDATED'))
        inflight.delete(key)
      }
    }
  }

  function purgeSession(sessionId) {
    abortSessionInflight(sessionId)
    clearLiveTurnCompleted(sessionId)
    for (const [key, entry] of settled.entries()) {
      if (entry.sessionId === sessionId) settled.delete(key)
    }
  }

  function dispose() {
    disposed = true
    for (const active of inflight.values()) {
      active.invalidated = true
      active.abortController.abort(new Error('PLUGIN_DISPOSED'))
    }
    inflight.clear()
    settled.clear()
    liveCompletedTurns.clear()
  }

  /**
   * Request or retrieve the single suggestion for a session's latest completed turn.
   * @param {string} sessionId
   * @param {number | undefined} expectedTurn
   * @param {{ requireLiveCompletion?: boolean }} [options]
   */
  async function suggest(sessionId, expectedTurn, options = {}) {
    if (disposed || typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { status: 'ineligible', turn: null, suggestion: null, reason: 'invalid-session' }
    }

    const agents = getService(ctx, 'agents')
    const agent = agents?.get?.(sessionId)
    const idleCheck = checkAgentIdle(ctx, agent)
    if (!idleCheck.ok) {
      return { status: 'ineligible', turn: null, suggestion: null, reason: idleCheck.reason }
    }

    let events
    try {
      events = agent.session.snapshotEvents()
    } catch {
      return { status: 'ineligible', turn: null, suggestion: null, reason: 'unreadable-session' }
    }

    const extracted = extractTurnContext(events, config.maxInputBytes)
    if (!extracted.eligible) {
      return { status: 'ineligible', turn: extracted.turn, suggestion: null, reason: extracted.reason }
    }

    const { turn, promptInput } = extracted
    if (expectedTurn !== undefined && expectedTurn !== null && expectedTurn !== turn) {
      return { status: 'stale', turn, suggestion: null, reason: 'turn-mismatch' }
    }

    const cacheKey = `${sessionId}:${String(turn)}`
    const cached = settled.get(cacheKey)
    if (cached !== undefined) {
      return {
        status: cached.suggestion !== null ? 'ready' : 'none',
        turn,
        suggestion: cached.suggestion,
      }
    }

    const runningCall = inflight.get(cacheKey)
    if (runningCall !== undefined) {
      return await runningCall.promise
    }

    if (options.requireLiveCompletion === true && liveCompletedTurns.get(sessionId) !== turn) {
      return { status: 'ineligible', turn, suggestion: null, reason: 'historical-turn' }
    }

    // The assistant asked the human to perform a manual UI check and report back: there is no valid
    // next user message to predict yet, and a ghost suggestion would preempt the manual verification.
    if (extracted.assistantAwaitsHumanAction === true) {
      recordSettled(cacheKey, { sessionId, turn, suggestion: null })
      return { status: 'none', turn, suggestion: null, reason: 'assistant-awaits-human-action' }
    }

    const llm = getService(ctx, 'llm')
    const route = resolveModelRoute(ctx, agent, config)
    if (!llm || route === null) {
      recordSettled(cacheKey, { sessionId, turn, suggestion: null })
      return { status: 'none', turn, suggestion: null, reason: 'no-llm-route' }
    }

    const abortController = new AbortController()
    /** @type {{ sessionId: string, turn: number, abortController: AbortController, invalidated: boolean, promise: any }} */
    const record = {
      sessionId,
      turn,
      abortController,
      invalidated: false,
      promise: null,
    }

    const timer = setTimeout(() => {
      abortController.abort(new Error('SUGGESTION_TIMEOUT'))
    }, config.timeoutMs)
    timer.unref?.()

    record.promise = (async () => {
      let suggestion = null
      try {
        suggestion = await runSuggestionLlmCall(llm, route, promptInput, config, abortController.signal)
      } catch {
        // Swallows LLM timeout, abort, or provider failure: suggestion generation must never fail the composer.
        suggestion = null
      } finally {
        clearTimeout(timer)
        if (inflight.get(cacheKey) === record) {
          inflight.delete(cacheKey)
        }
      }

      if (disposed || record.invalidated) {
        return { status: 'stale', turn, suggestion: null, reason: 'invalidated' }
      }

      // Re-verify session and turn state after async LLM completion.
      const currentAgent = getService(ctx, 'agents')?.get?.(sessionId)
      if (!checkAgentIdle(ctx, currentAgent).ok) {
        return { status: 'stale', turn, suggestion: null, reason: 'session-advanced' }
      }
      let latestEvents
      try {
        latestEvents = currentAgent.session.snapshotEvents()
      } catch {
        return { status: 'stale', turn, suggestion: null, reason: 'session-closed' }
      }
      const latestCheck = extractTurnContext(latestEvents, config.maxInputBytes)
      if (!latestCheck.eligible || latestCheck.turn !== turn) {
        return { status: 'stale', turn: latestCheck.turn, suggestion: null, reason: 'turn-advanced' }
      }

      recordSettled(cacheKey, { sessionId, turn, suggestion })
      return {
        status: suggestion !== null ? 'ready' : 'none',
        turn,
        suggestion,
      }
    })()

    inflight.set(cacheKey, record)
    return await record.promise
  }

  function updateConfig(nextConfig) {
    const resolved = resolveHostConfig(nextConfig)
    config = resolved
    settled.clear()
    return resolved
  }

  return {
    get config() {
      return config
    },
    updateConfig,
    suggest,
    markLiveTurnCompleted,
    clearLiveTurnCompleted,
    abortSessionInflight,
    purgeSession,
    dispose,
    /** Read-only inspection counts for tests. */
    stats: () => ({ settled: settled.size, inflight: inflight.size, liveCompleted: liveCompletedTurns.size, disposed }),
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

async function readBoundedJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.byteLength
    if (total > MAX_REQUEST_BODY_BYTES) {
      req.resume?.()
      return { error: 'payload-too-large', status: 413 }
    }
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks, total).toString('utf8')
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'invalid-json-object', status: 400 }
    }
    return { value: parsed }
  } catch {
    // Swallows JSON.parse syntax errors on untrusted HTTP request body.
    return { error: 'malformed-json', status: 400 }
  }
}

/**
 * Create the HTTP route handler registered on `ctx.webServer`.
 * @param {any} ctx
 * @param {ReturnType<typeof createSuggestionCoordinator>} coordinator
 */
export function createSuggestRouteHandler(ctx, coordinator) {
  return async function handleSuggestRequest(req, res) {
    const connection = getService(ctx, 'connection')
    if (connection && typeof connection.requestRejection === 'function') {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        sendJson(res, rejection, { code: 'unauthorized', message: 'request rejected' })
        return
      }
    }

    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('allow', 'POST')
      res.end()
      return
    }

    const mediaType = String(req.headers?.['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== 'application/json') {
      sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' })
      return
    }

    let bodyResult
    try {
      bodyResult = await readBoundedJsonBody(req)
    } catch {
      // Swallows mid-stream client disconnect errors.
      sendJson(res, 400, { code: 'bad-request', message: 'unreadable request body' })
      return
    }

    if ('error' in bodyResult) {
      sendJson(res, bodyResult.status, { code: bodyResult.error })
      return
    }

    const { sessionId, expectedTurn, requireLiveCompletion } = bodyResult.value
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      sendJson(res, 400, { code: 'bad-request', message: 'sessionId must be a non-empty string' })
      return
    }
    if (expectedTurn !== undefined && expectedTurn !== null
      && (typeof expectedTurn !== 'number' || !Number.isInteger(expectedTurn) || expectedTurn < 0)) {
      sendJson(res, 400, { code: 'bad-request', message: 'expectedTurn must be a non-negative integer when provided' })
      return
    }

    const outcome = await coordinator.suggest(sessionId, expectedTurn ?? undefined, {
      requireLiveCompletion: requireLiveCompletion === true,
    })
    sendJson(res, 200, outcome)
  }
}

async function listModelsWithTimeout(llm, providerId) {
  if (typeof llm?.listModels !== 'function') return []
  let timer = null
  try {
    const models = await Promise.race([
      Promise.resolve(llm.listModels(providerId)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('CATALOG_TIMEOUT')), CATALOG_PROVIDER_TIMEOUT_MS)
        timer.unref?.()
      }),
    ])
    if (!Array.isArray(models)) return []
    return models
      .filter(m => m && typeof m.id === 'string' && m.id.trim() !== '')
      .map(m => ({
        id: m.id,
        name: typeof m.name === 'string' && m.name.trim() !== '' ? m.name : m.id,
      }))
  } catch {
    return []
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

async function listProviderCatalog(ctx) {
  const llm = getService(ctx, 'llm')
  const rawProviders = typeof llm?.listProviders === 'function' ? llm.listProviders() : []
  if (!Array.isArray(rawProviders) || rawProviders.length === 0) return []

  const validProviders = rawProviders.filter(
    p => p && typeof p.id === 'string' && p.id.trim() !== '',
  )
  return await Promise.all(
    validProviders.map(async (p) => {
      const models = await listModelsWithTimeout(llm, p.id)
      return {
        id: p.id,
        name: typeof p.name === 'string' && p.name.trim() !== '' ? p.name : p.id,
        models,
      }
    }),
  )
}

function serializeResolvedConfig(resolved) {
  return {
    maxInputBytes: resolved.maxInputBytes,
    maxOutputTokens: resolved.maxOutputTokens,
    timeoutMs: resolved.timeoutMs,
    provider: resolved.provider ?? null,
    model: resolved.model ?? null,
  }
}

/**
 * Create the authenticated `GET` / `POST` configuration & model-catalog route handler
 * registered on `ctx.webServer` at `/api/next-step-suggestion/config`.
 *
 * @param {any} ctx
 * @param {ReturnType<typeof createSuggestionCoordinator>} coordinator
 */
export function createConfigRouteHandler(ctx, coordinator) {
  return async function handleConfigRequest(req, res) {
    const connection = getService(ctx, 'connection')
    if (connection && typeof connection.requestRejection === 'function') {
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        sendJson(res, rejection, { code: 'unauthorized', message: 'request rejected' })
        return
      }
    }

    if (req.method === 'GET') {
      const entry = ctx?.fiber?.entry
      const editor = getService(ctx, 'configEditor')
      const editable = Boolean(
        entry !== undefined
        && typeof editor?.edit === 'function'
        && (typeof editor.entries !== 'function' || editor.entries().includes(entry)),
      )
      const providers = await listProviderCatalog(ctx)
      const defaultSelection = getService(ctx, 'agentDefaultModel')?.currentSelection?.()
      const defaultRoute = defaultSelection
        && typeof defaultSelection.provider === 'string' && defaultSelection.provider.length > 0
        && typeof defaultSelection.model === 'string' && defaultSelection.model.length > 0
        ? { provider: defaultSelection.provider, model: defaultSelection.model }
        : null

      sendJson(res, 200, {
        config: serializeResolvedConfig(coordinator.config),
        defaults: DEFAULT_HOST_CONFIG,
        maxTimeoutMs: MAX_TIMEOUT_MS,
        editable,
        providers,
        defaultRoute,
      })
      return
    }

    if (req.method !== 'POST') {
      res.statusCode = 405
      res.setHeader('allow', 'GET, POST')
      res.end()
      return
    }

    const mediaType = String(req.headers?.['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
    if (mediaType !== 'application/json') {
      sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' })
      return
    }

    let bodyResult
    try {
      bodyResult = await readBoundedJsonBody(req)
    } catch {
      sendJson(res, 400, { code: 'bad-request', message: 'unreadable request body' })
      return
    }

    if ('error' in bodyResult) {
      sendJson(res, bodyResult.status, { code: bodyResult.error })
      return
    }

    const rawBody = bodyResult.value
    const candidate = {}
    for (const [k, v] of Object.entries(rawBody)) {
      if ((k === 'provider' || k === 'model') && v === null) continue
      candidate[k] = v
    }

    let resolved
    try {
      resolved = resolveHostConfig(candidate)
    } catch (err) {
      sendJson(res, 400, {
        code: 'invalid-config',
        message: err instanceof Error ? err.message : String(err),
      })
      return
    }

    const entry = ctx?.fiber?.entry
    const editor = getService(ctx, 'configEditor')
    if (entry === undefined || typeof editor?.edit !== 'function') {
      sendJson(res, 409, {
        code: 'config-editor-unavailable',
        message: 'Configuration cannot be saved in this profile',
      })
      return
    }

    const persistedRaw = {
      maxInputBytes: resolved.maxInputBytes,
      maxOutputTokens: resolved.maxOutputTokens,
      timeoutMs: resolved.timeoutMs,
      ...(resolved.provider !== undefined && resolved.model !== undefined
        ? { provider: resolved.provider, model: resolved.model }
        : {}),
    }

    try {
      await editor.edit(entry, () => ({ ...persistedRaw }))
    } catch (err) {
      sendJson(res, 409, {
        code: 'save-rejected',
        message: err instanceof Error ? err.message : String(err),
      })
      return
    }

    coordinator.updateConfig(persistedRaw)
    sendJson(res, 200, {
      ok: true,
      config: serializeResolvedConfig(resolved),
    })
  }
}
