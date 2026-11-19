/**
 * Bounded turn-context extraction and model output sanitization for next-step suggestions.
 */

export const SUGGESTION_SYSTEM_PROMPT = [
  'Predict one concise, directly sendable next message that the human user is most likely to send to the coding agent after its latest reply.',
  'Rules:',
  '1. Write strictly from the USER perspective addressing the agent (an imperative instruction or concrete follow-up request), NEVER from the assistant perspective and NEVER an offer or question from the assistant like "Would you like me to..." or "I can...".',
  '2. Match the natural language of the user messages in the conversation (for example, Chinese for Chinese conversations, English for English conversations).',
  '3. Base the suggestion on the work just completed: prioritize concrete follow-ups mentioned in the latest reply (such as running regression tests, verifying a build, checking edge cases, committing, or pushing); if the requested change itself is complete, suggest the single most natural concrete verification or next engineering step.',
  '4. Keep it brief and specific on a single line (about 8-32 CJK characters or 4-16 words), plain text only: no quotes, no Markdown formatting, no bullet markers, no leading slash commands, and no explanation.',
  '5. Output ONLY the exact token NONE when the exchange is a closing pleasantry (e.g. thanks/goodbye), pure small talk, when the assistant is still waiting on a background subagent, background job, or async task to finish on its own (NEVER suggest "continue waiting" or "wait for result"), or when there is no plausible concrete follow-up instruction.',
  '6. NEVER suggest that the agent perform actions only a human can do in a browser or UI (hard refresh, clicking controls, switching sessions, visually observing the interface). When the assistant asks the human to perform such a manual step and report back, output ONLY NONE: the human has not reported a result yet, so there is no valid next message to predict.',
  '7. NEVER claim the human already did something ("已硬刷新", "I refreshed", "已测试") unless a human message in the conversation actually states it.',
].join('\n')

const SYSTEM_REMINDER_RE = /<system-reminder>[\s\S]*?<\/system-reminder>/giu
const WRAPPING_MARKERS_RE = /^(?:(?:"([\s\S]+)")|(?:'([\s\S]+)')|(?:“([\s\S]+)ˮ)|(?:“([\s\S]+)”)|(?:「([\s\S]+)」)|(?:`([^`]+)`)|(?:\*{1,3}([^*\n]+)\*{1,3}))$/u
const LEADING_LIST_MARKER_RE = /^(?:[-*•]\s+|\d+[.)]\s+)/u
const ASSISTANT_VOICE_RE = /^(?:需要我|要我|是否需要我|要不要我|我可以帮|我可以继续|请问还需要|would you like me to|do you want me to|shall i\b|should i\b|i can help|let me know if\b|feel free to\b)/iu
const WAITING_PSEUDO_PROMPT_RE = /^(?:继续等待|等待(?:子代理|子智能体|后台|任务|脚本|审查|结果)|先等(?:待|子代理|后台|一下)|请等待|(?:continue|keep)\s+waiting\b|wait\s+for\s+(?:the\s+)?(?:subagent|agent|background|job|task|review|result)\b)/iu
// Human-only browser/UI actions may never be delegated back to the agent as a suggestion.
// This is a defense-in-depth output filter only; the semantic decision is made by the suggestion LLM.
// It targets suggestions that *directly instruct* a manual UI action (or claim one was just done), so
// test-writing suggestions such as "给切走再切回的场景补回归测试" and "Write a Playwright test that can
// click the Save button" still pass.
const MANUAL_UI_ACTION_PATTERN = [
  '硬刷新',
  '刷新(?:一下)?(?:页面|浏览器|界面)',
  '切走.{0,4}切回(?!\\s*(?:的)?(?:场景|测试|用例))',
  '切走\\s*[/／]\\s*切回(?!\\s*(?:的)?(?:场景|测试|用例))',
  '点击.{0,10}(?:按钮|链接|页面|图标)',
  '观察(?:界面|页面)',
  '肉眼(?:看|检查|确认)',
  'hard[-\\s]?refresh',
  'refresh\\s+the\\s+(?:page|browser)',
  'switch\\s+(?:away|back)(?:\\s+and\\s+back)?(?!\\s+(?:scenario|test|case))',
  'click\\s+(?:the|on)\\s+\\S+',
  'visually\\s+(?:check|verify|inspect)',
  'observe\\s+the\\s+(?:ui|page|interface)',
].join('|')
const DIRECT_MANUAL_ACTION_RE = new RegExp(
  `^(?:(?:请(?:你)?|麻烦(?:你)?|劳烦|please|kindly)\\s*)?(?:${MANUAL_UI_ACTION_PATTERN})`,
  'iu',
)
const COMPLETED_MANUAL_CLAIM_RE = /^(?:已(?:经)?(?:硬刷新|刷新(?:了)?(?:页面|浏览器|界面))|我(?:已经)?(?:硬刷新|刷新(?:了)?(?:页面|浏览器|界面))|(?:i\s+(?:have\s+|'ve\s+)?)?(?:hard[-\s]?refreshed|refreshed\s+the\s+(?:page|browser)))/iu
const VERIFY_REQUEST_RE = /(?:验证|确认|再试|检查|看看|verify|check|test|confirm|again)/iu
const NONE_TOKENS = new Set(['none', 'n/a', 'null', 'nil', '无', '暂无', '没有', '不需要'])

/**
 * Strip injected `<system-reminder>` blocks and normalize surrounding whitespace.
 * @param {string} text
 * @returns {string}
 */
export function stripSystemReminders(text) {
  if (typeof text !== 'string' || text.length === 0) return ''
  return text.replace(SYSTEM_REMINDER_RE, '').trim()
}

/**
 * Extract plain text from a message content block array, ignoring reasoning, images, files, and tool calls.
 * @param {readonly unknown[] | undefined} content
 * @returns {string}
 */
export function extractTextBlocks(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      const cleaned = stripSystemReminders(block.text)
      if (cleaned.length > 0) parts.push(cleaned)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Keep head and tail characters when truncating long text so end-of-reply next-step cues survive.
 * @param {string} text
 * @param {number} headChars
 * @param {number} tailChars
 * @returns {string}
 */
export function clipHeadTail(text, headChars, tailChars) {
  const maxChars = headChars + tailChars
  if (text.length <= maxChars) return text
  if (headChars <= 0) return `…${text.slice(text.length - tailChars)}`
  if (tailChars <= 0) return `${text.slice(0, headChars)}…`
  return `${text.slice(0, headChars)}\n…\n${text.slice(text.length - tailChars)}`
}

/**
 * Clamp a UTF-8 string to at most `maxBytes` bytes by trimming from the front or middle.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
function clampUtf8Tail(text, maxBytes) {
  if (maxBytes <= 0) return ''
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const candidate = `…${text.slice(mid)}`
    if (Buffer.byteLength(candidate, 'utf8') <= maxBytes) {
      hi = mid
    } else {
      lo = mid + 1
    }
  }
  const sliced = `…${text.slice(lo)}`
  return Buffer.byteLength(sliced, 'utf8') <= maxBytes ? sliced : ''
}

/**
 * Inspect a session's event snapshot and build bounded recent context for the latest completed turn.
 * Never includes system prompts, developer messages, reasoning blocks, or raw tool arguments/results.
 *
 * @param {readonly Record<string, any>[]} events
 * @param {number} maxInputBytes
 * @returns {{ eligible: true, turn: number, promptInput: string } | { eligible: false, turn: number | null, reason: string }}
 */
export function extractTurnContext(events, maxInputBytes) {
  if (!Array.isArray(events) || events.length === 0) {
    return { eligible: false, turn: null, reason: 'empty-session' }
  }

  let lastStartIdx = -1
  let lastEndIdx = -1
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev === undefined || ev === null) continue
    if (lastEndIdx === -1 && ev.type === 'turn/end') {
      lastEndIdx = i
    }
    if (lastStartIdx === -1 && ev.type === 'turn/start') {
      lastStartIdx = i
    }
    if (lastStartIdx !== -1 && lastEndIdx !== -1) break
  }

  if (lastStartIdx === -1) {
    return { eligible: false, turn: null, reason: 'no-turn' }
  }
  const startTurn = events[lastStartIdx]?.data?.turn
  if (typeof startTurn !== 'number') {
    return { eligible: false, turn: null, reason: 'invalid-turn' }
  }
  if (lastEndIdx === -1 || lastEndIdx < lastStartIdx) {
    return { eligible: false, turn: startTurn, reason: 'turn-in-progress' }
  }

  const endData = events[lastEndIdx]?.data
  if (endData?.turn !== startTurn) {
    return { eligible: false, turn: startTurn, reason: 'turn-mismatch' }
  }

  const endKind = endData?.reason?.kind
  if (endKind !== 'completed') {
    return { eligible: false, turn: startTurn, reason: typeof endKind === 'string' ? endKind : 'non-completed' }
  }

  // Ensure no newer events after turn/end reopened activity.
  for (let i = lastEndIdx + 1; i < events.length; i++) {
    const ev = events[i]
    if (ev?.type === 'turn/start' || ev?.type === 'step/start') {
      return { eligible: false, turn: startTurn, reason: 'turn-superseded' }
    }
  }

  // Collect bounded summary within the completed turn [lastStartIdx, lastEndIdx].
  let latestAssistantText = ''
  let sawInterruptedAssistant = false
  /** @type {Map<string, number>} */
  const toolCounts = new Map()
  let toolErrorCount = 0
  let ranTests = false
  let ranGitCommit = false
  let ranGitPush = false
  let editedFiles = false

  for (let i = lastStartIdx; i <= lastEndIdx; i++) {
    const ev = events[i]
    if (!ev || typeof ev !== 'object') continue
    if (ev.type === 'assistant/message') {
      if (ev.data?.interrupted === true) {
        sawInterruptedAssistant = true
        continue
      }
      const text = extractTextBlocks(ev.data?.message?.content)
      if (text.length > 0) {
        latestAssistantText = text
        sawInterruptedAssistant = false
      }
    } else if (ev.type === 'tool/call') {
      const toolName = ev.data?.name
      if (typeof toolName === 'string' && toolName.length > 0) {
        if (toolCounts.size < 12 || toolCounts.has(toolName)) {
          toolCounts.set(toolName, (toolCounts.get(toolName) ?? 0) + 1)
        }
        if (toolName === 'edit' || toolName === 'write' || toolName === 'str_replace_editor' || toolName === 'fs-sandbox' || toolName === 'tool-fs') {
          editedFiles = true
        } else if (toolName === 'bash' || toolName === 'pwsh' || toolName === 'terminal') {
          const rawArgs = ev.data?.arguments
          let cmd = ''
          if (typeof rawArgs === 'string') {
            try {
              const parsed = JSON.parse(rawArgs)
              if (typeof parsed?.command === 'string') cmd = parsed.command
            } catch {
              // Ignore truncated/malformed tool-call JSON on historical events rather than scanning non-command fields.
            }
          } else if (rawArgs && typeof rawArgs === 'object' && typeof rawArgs.command === 'string') {
            cmd = rawArgs.command
          }
          if (cmd.length > 0) {
            if (/\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b|node\s+--test\b|pytest\b|vitest\b|jest\b|cargo\s+test\b|go\s+test\b)/iu.test(cmd)) {
              ranTests = true
            }
            if (/\bgit\s+commit\b/iu.test(cmd)) ranGitCommit = true
            if (/\bgit\s+push\b/iu.test(cmd)) ranGitPush = true
          }
        }
      }
    } else if (ev.type === 'tool/result') {
      if (ev.data?.message?.isError === true || ev.data?.error !== undefined) {
        toolErrorCount += 1
      }
    }
  }

  if (sawInterruptedAssistant || latestAssistantText.length === 0) {
    return { eligible: false, turn: startTurn, reason: 'no-final-assistant-text' }
  }

  // Collect at most the 2 most recent human-authored user messages up to lastEndIdx.
  const recentUserTexts = []
  for (let i = lastEndIdx; i >= 0 && recentUserTexts.length < 2; i--) {
    const ev = events[i]
    if (ev?.type !== 'user/message') continue
    const msg = ev.data
    if (msg?.source?.kind !== 'user') continue
    const text = extractTextBlocks(msg.content)
    if (text.length > 0) {
      recentUserTexts.unshift(text)
    }
  }

  if (recentUserTexts.length === 0) {
    return { eligible: false, turn: startTurn, reason: 'no-human-prompt' }
  }

  const toolsUsed = [...toolCounts.entries()].slice(0, 8).map(([tool, count]) => ({ tool, count }))
  const currentUserPrompt = clipHeadTail(recentUserTexts[recentUserTexts.length - 1], 450, 450)
  const previousUserPrompt = recentUserTexts.length > 1 ? clipHeadTail(recentUserTexts[0], 220, 220) : undefined
  const assistantReply = clipHeadTail(latestAssistantText, 650, 1750)

  const toolFeatures = {
    ranTests,
    ranGitCommit,
    ranGitPush,
    editedFiles,
  }

  const buildPayload = (prevUser, currUser, reply) => {
    const envelope = {
      ...(prevUser ? { previousUserPrompt: prevUser } : {}),
      userPrompt: currUser,
      ...(toolsUsed.length > 0 ? { toolsUsed } : {}),
      ...(toolErrorCount > 0 ? { toolErrorsInTurn: toolErrorCount } : {}),
      toolFeatures,
      assistantFinalReply: reply,
    }
    return `Recent completed turn summary (JSON):\n${JSON.stringify(envelope)}`
  }

  let promptInput = buildPayload(previousUserPrompt, currentUserPrompt, assistantReply)
  if (Buffer.byteLength(promptInput, 'utf8') > maxInputBytes) {
    promptInput = buildPayload(undefined, clipHeadTail(currentUserPrompt, 250, 250), clipHeadTail(assistantReply, 300, 900))
  }
  if (Buffer.byteLength(promptInput, 'utf8') > maxInputBytes) {
    const bareOverhead = Buffer.byteLength(buildPayload(undefined, '', ''), 'utf8') + 64
    const remaining = Math.max(64, maxInputBytes - bareOverhead)
    const userBudget = Math.floor(remaining * 0.3)
    const replyBudget = remaining - userBudget
    promptInput = buildPayload(
      undefined,
      clampUtf8Tail(currentUserPrompt, userBudget),
      clampUtf8Tail(assistantReply, replyBudget),
    )
  }
  if (Buffer.byteLength(promptInput, 'utf8') > maxInputBytes) {
    return { eligible: false, turn: startTurn, reason: 'context-budget-exceeded' }
  }

  return {
    eligible: true,
    turn: startTurn,
    promptInput,
  }
}

/**
 * Sanitize and validate raw LLM output into a single-line user prompt suggestion, or null when none applies.
 * @param {string} rawText
 * @returns {string | null}
 */
export function parseSuggestionOutput(rawText) {
  if (typeof rawText !== 'string') return null
  if (rawText.includes('```')) return null

  const firstLine = rawText
    .split(/\r?\n/u)
    .map(line => line.trim())
    .find(line => line.length > 0)

  if (firstLine === undefined) return null

  let candidate = firstLine.replace(LEADING_LIST_MARKER_RE, '').trim()
  const match = WRAPPING_MARKERS_RE.exec(candidate)
  if (match !== null) {
    const unwrapped = match.slice(1).find(group => group !== undefined)
    if (unwrapped !== undefined) candidate = unwrapped.trim()
  }

  candidate = candidate.replace(/\s+/gu, ' ').trim()
  if (candidate.length === 0) return null
  if (NONE_TOKENS.has(candidate.toLowerCase())) return null
  if (candidate.startsWith('/')) return null
  if (candidate.length < 2 || candidate.length > 120) return null
  if (/<\/?[a-z][^>]*>/iu.test(candidate)) return null
  if (ASSISTANT_VOICE_RE.test(candidate)) return null
  if (WAITING_PSEUDO_PROMPT_RE.test(candidate)) return null
  if (DIRECT_MANUAL_ACTION_RE.test(candidate)) return null
  if (COMPLETED_MANUAL_CLAIM_RE.test(candidate) && VERIFY_REQUEST_RE.test(candidate)) return null

  return candidate
}
