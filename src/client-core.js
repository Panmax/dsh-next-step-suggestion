/**
 * Pure client-side multi-session state machine, key arbitration, theme-token styles, and locale
 * dictionaries for `dsh-next-step-suggestion`.
 */

export const PLUGIN_ID = 'dsh-next-step-suggestion'
export const LOCALE_NS = 'next-step-suggestion'
export const SUGGEST_ENDPOINT = '/api/next-step-suggestion/suggest'

export const LOCALES = {
  zh: {
    'tab.hint': 'Tab',
    'accept.label': '采纳下一步建议',
    'preview.aria': '下一步建议：{text}，按 Tab 或点击徽章接受，按 Esc 关闭',
  },
  en: {
    'tab.hint': 'Tab',
    'accept.label': 'Accept next-step suggestion',
    'preview.aria': 'Next-step suggestion: {text}. Press Tab or click badge to accept, or Esc to dismiss.',
  },
  ja: {
    'tab.hint': 'Tab',
    'accept.label': '次のステップの提案を採用',
    'preview.aria': '次のステップの提案: {text}（Tabまたはクリックで採用、Escで閉じる）',
  },
  es: {
    'tab.hint': 'Tab',
    'accept.label': 'Aceptar sugerencia siguiente',
    'preview.aria': 'Sugerencia siguiente: {text}. Pulsa Tab o haz clic para aceptar, o Esc para cerrar.',
  },
  fr: {
    'tab.hint': 'Tab',
    'accept.label': 'Accepter la suggestion suivante',
    'preview.aria': 'Suggestion suivante : {text}. Appuyez sur Tab ou cliquez pour accepter, ou Échap pour fermer.',
  },
  de: {
    'tab.hint': 'Tab',
    'accept.label': 'Vorschlag übernehmen',
    'preview.aria': 'Nächster Schritt: {text}. Tab oder Klick zum Übernehmen, Esc zum Schließen.',
  },
  ru: {
    'tab.hint': 'Tab',
    'accept.label': 'Принять предложение',
    'preview.aria': 'Следующий шаг: {text}. Нажмите Tab или кнопку, чтобы принять, или Esc, чтобы скрыть.',
  },
  pt: {
    'tab.hint': 'Tab',
    'accept.label': 'Aceitar próxima sugestão',
    'preview.aria': 'Próxima sugestão: {text}. Pressione Tab ou clique para aceitar, ou Esc para fechar.',
  },
}

/**
 * Theme-token-only CSS rules. Hides the native composer placeholder only while an active
 * ghost suggestion is rendered inside an editable, decorator-free composer card, and hides
 * the ghost suggestion immediately if IME composition starts, the editor becomes disabled,
 * or inline quote/reference chips appear.
 */
export const SUGGESTION_CSS = `
[data-composer-card]:has([data-next-step-suggestion-active]):not(:has([data-composer-input][aria-disabled="true"])):not(:has([data-composer-input][contenteditable="false"])):not(:has([data-composer-quote], [data-composer-chip], [data-composer-command], [data-lexical-decorator])) [data-composer-placeholder] {
  visibility: hidden !important;
}
[data-composer-card]:has([data-composer-composing], [data-composer-input][aria-disabled="true"], [data-composer-input][contenteditable="false"], [data-composer-quote], [data-composer-chip], [data-composer-command], [data-lexical-decorator]) [data-next-step-suggestion-active] {
  visibility: hidden !important;
  pointer-events: none !important;
}
[data-composer-card]:has([data-composer-composing], [data-composer-input][aria-disabled="true"], [data-composer-input][contenteditable="false"], [data-composer-quote], [data-composer-chip], [data-composer-command], [data-lexical-decorator]) [data-next-step-suggestion-active] .dsh-nss-kbd {
  pointer-events: none !important;
}
.dsh-nss-ghost {
  position: absolute;
  z-index: 2;
  left: 0;
  right: 4px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px 0 14px;
  box-sizing: border-box;
  pointer-events: none;
  user-select: none;
  font-family: var(--dsw-font-family);
  font-size: inherit;
  line-height: inherit;
  color: var(--dsw-alias-label-caption);
  overflow: hidden;
}
.dsh-nss-text {
  min-width: 0;
  flex: 0 1 auto;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
.dsh-nss-kbd {
  appearance: none;
  margin: 0;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--dsw-radius-sm, 4px);
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-specific-selector);
  color: var(--dsw-alias-label-tertiary);
  font-family: inherit;
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
  pointer-events: auto;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}
@media (hover: hover) {
  .dsh-nss-kbd:hover {
    background: var(--dsw-alias-interactive-bg-hover);
    border-color: var(--dsw-alias-border-l4);
    color: var(--dsw-alias-label-secondary);
  }
}
@media (pointer: coarse) {
  .dsh-nss-kbd {
    height: 24px;
    padding: 0 8px;
    font-size: 12px;
    line-height: 22px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-nss-kbd {
    transition: none;
  }
}
`

const UNKNOWN_TURN_KEY = -1
const MAX_TRACKED_SESSIONS = 100

/**
 * Check whether a session's draft/execution state is clean for requesting or keeping a suggestion
 * (independent of whether the session is currently foreground or a popup is temporarily open).
 * @param {Record<string, any> | null} env
 * @returns {boolean}
 */
export function isSessionDraftClean(env) {
  if (!env || typeof env.sessionId !== 'string' || env.sessionId === '') return false
  if (env.running) return false
  if (env.hasError) return false
  if (env.submissionPending) return false
  if (env.phase !== 'plain') return false
  if (env.draft !== '') return false
  if (env.hasAttachments) return false
  if (env.hasInlineDecorators) return false
  if (env.composing) return false
  return true
}

/**
 * Check whether the composer surface is foreground, editable, authorized for prompting,
 * and not hidden beneath a `conversation.composer` takeover card.
 * @param {Record<string, any> | null} env
 * @returns {boolean}
 */
export function isComposerInteractive(env) {
  if (!env?.foreground) return false
  if (env.editorEditable === false) return false
  if (env.promptAllowed === false) return false
  if (env.composerTakenOver) return false
  if (env.planActive) return false
  if (env.goalActive) return false
  return true
}

/**
 * Check whether an environment snapshot is both interactive and clean to request or display a suggestion.
 * @param {Record<string, any> | null} env
 * @returns {boolean}
 */
export function isSnapshotCleanForSuggestion(env) {
  return isComposerInteractive(env) && isSessionDraftClean(env)
}

/**
 * Create the deterministic multi-session suggestion state machine.
 * Preserves unconsumed suggestions per session across session switches while preventing cross-session
 * leaks, and backfills suggestions when returning to a session whose turn finished in the background.
 *
 * @param {{
 *   fetchSuggestion: (
 *     sessionId: string,
 *     expectedTurn: number | undefined,
 *     signal: AbortSignal,
 *     options?: { requireLiveCompletion?: boolean },
 *   ) => Promise<{ status?: string, turn?: number | null, suggestion?: string | null } | null>,
 *   onChange?: () => void,
 * }} deps
 */
export function createClientSuggestionMachine(deps) {
  const { fetchSuggestion, onChange = () => {} } = deps

  let disposed = false
  /** @type {Record<string, any> | null} */
  let currentEnv = null
  /** @type {string | null} */
  let activeSessionId = null
  /** @type {Set<() => void>} */
  const subscribers = new Set()

  /**
   * @typedef {{
   *   sawRunning: boolean,
   *   baselineDraftRev: number | null,
   *   epochInvalidated: boolean,
   *   activeSuggestion: { turn: number | null, text: string } | null,
   *   activeRequestSeq: number,
   *   activeAbort: AbortController | null,
   *   requestedTurns: Set<number>,
   *   dismissedTurns: Set<number>,
   *   lastEnv: Record<string, any> | null,
   * }} SessionSlot
   */
  /** @type {Map<string, SessionSlot>} */
  const slots = new Map()

  function notify() {
    if (disposed) return
    onChange()
    for (const listener of subscribers) {
      listener()
    }
  }

  /**
   * Subscribe to state changes (supports plugin-scoped machine shared across mounted/remounted slot views).
   * @param {() => void} listener
   * @returns {() => void}
   */
  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {}
    subscribers.add(listener)
    return () => {
      subscribers.delete(listener)
    }
  }

  /**
   * @param {string} sessionId
   * @returns {SessionSlot}
   */
  function slotOf(sessionId) {
    let slot = slots.get(sessionId)
    if (slot) {
      // Refresh LRU order.
      slots.delete(sessionId)
      slots.set(sessionId, slot)
      return slot
    }
    slot = {
      sawRunning: false,
      baselineDraftRev: null,
      epochInvalidated: true,
      activeSuggestion: null,
      activeRequestSeq: 0,
      activeAbort: null,
      requestedTurns: new Set(),
      dismissedTurns: new Set(),
      lastEnv: null,
    }
    slots.set(sessionId, slot)
    while (slots.size > MAX_TRACKED_SESSIONS) {
      const oldestKey = slots.keys().next().value
      if (oldestKey === undefined) break
      const evicted = slots.get(oldestKey)
      evicted?.activeAbort?.abort()
      slots.delete(oldestKey)
    }
    return slot
  }

  function cancelSlotInflight(slot) {
    slot.activeRequestSeq += 1
    if (slot.activeAbort !== null) {
      slot.activeAbort.abort()
      slot.activeAbort = null
    }
  }

  /**
   * Permanently invalidate a session's current completed turn suggestion (on typing, Tab accept, Esc, or new turn).
   * @param {string | null | undefined} targetSessionId
   */
  function invalidateSessionTurn(targetSessionId = activeSessionId) {
    if (!targetSessionId) return
    const slot = slots.get(targetSessionId)
    if (!slot) return

    const hadSuggestion = slot.activeSuggestion !== null
    if (slot.activeSuggestion !== null && typeof slot.activeSuggestion.turn === 'number') {
      slot.dismissedTurns.add(slot.activeSuggestion.turn)
    }
    const envTurn = slot.lastEnv && typeof slot.lastEnv.turnHint === 'number' ? slot.lastEnv.turnHint : null
    if (envTurn !== null) {
      slot.dismissedTurns.add(envTurn)
    } else {
      slot.dismissedTurns.add(UNKNOWN_TURN_KEY)
    }

    slot.epochInvalidated = true
    slot.activeSuggestion = null
    cancelSlotInflight(slot)
    if (hadSuggestion) notify()
  }

  function invalidateCurrentTurn() {
    invalidateSessionTurn(currentEnv?.sessionId ?? activeSessionId)
  }

  /**
   * Record that a session was observed running in the sidebar session list (even while another session is open),
   * clearing any stale cached suggestion for that session and arming backfill when the user switches into it.
   * @param {string} sessionId
   */
  function noteSessionRunning(sessionId) {
    if (disposed || typeof sessionId !== 'string' || sessionId === '') return
    const slot = slotOf(sessionId)
    const hadSuggestion = slot.activeSuggestion !== null
    slot.sawRunning = true
    slot.baselineDraftRev = null
    slot.epochInvalidated = true
    slot.activeSuggestion = null
    slot.dismissedTurns.delete(UNKNOWN_TURN_KEY)
    cancelSlotInflight(slot)
    if (hadSuggestion && activeSessionId === sessionId) notify()
  }

  function startSuggestionFetch(sessionId, slot, env, { requireLiveCompletion }) {
    const turnHint = typeof env.turnHint === 'number' ? env.turnHint : undefined
    const turnKey = turnHint ?? UNKNOWN_TURN_KEY

    if (slot.requestedTurns.has(turnKey) || slot.dismissedTurns.has(turnKey)) {
      return
    }
    slot.requestedTurns.add(turnKey)

    slot.baselineDraftRev = env.draftRev
    slot.epochInvalidated = false

    const reqSeq = ++slot.activeRequestSeq
    const abortController = new AbortController()
    slot.activeAbort = abortController

    let requestPromise
    try {
      requestPromise = Promise.resolve(
        fetchSuggestion(sessionId, turnHint, abortController.signal, { requireLiveCompletion }),
      )
    } catch (err) {
      requestPromise = Promise.reject(err)
    }

    void requestPromise
      .then((result) => {
        if (disposed || reqSeq !== slot.activeRequestSeq || abortController.signal.aborted) return
        slot.activeAbort = null
        if (slot.epochInvalidated) return

        const latestEnv = slot.lastEnv
        if (latestEnv !== null && !isSessionDraftClean(latestEnv)) {
          invalidateSessionTurn(sessionId)
          return
        }
        // Check same-visit draft mutation while this session remained mounted.
        if (latestEnv !== null && activeSessionId === sessionId
          && slot.baselineDraftRev !== null && latestEnv.draftRev !== slot.baselineDraftRev) {
          invalidateSessionTurn(sessionId)
          return
        }

        if (!result || result.status !== 'ready' || typeof result.suggestion !== 'string') {
          if (typeof result?.turn === 'number') {
            slot.requestedTurns.add(result.turn)
          }
          return
        }

        const text = result.suggestion.trim()
        if (text === '') return

        const resolvedTurn = typeof result.turn === 'number' ? result.turn : (turnHint ?? null)
        if (resolvedTurn !== null) {
          slot.requestedTurns.add(resolvedTurn)
          if (slot.dismissedTurns.has(resolvedTurn)) return
        } else if (slot.dismissedTurns.has(UNKNOWN_TURN_KEY)) {
          return
        }

        slot.activeSuggestion = {
          turn: resolvedTurn,
          text,
        }
        notify()
      })
      .catch(() => {
        // Swallows transport/abort failures: composer continues unaffected.
        if (reqSeq === slot.activeRequestSeq) {
          slot.activeAbort = null
        }
      })
  }

  /**
   * Synchronize the latest composer/session snapshot into the state machine.
   * @param {Record<string, any>} nextEnv
   */
  function sync(nextEnv) {
    if (disposed || !nextEnv || typeof nextEnv.sessionId !== 'string' || nextEnv.sessionId === '') return
    const sessionId = nextEnv.sessionId
    const prevEnv = currentEnv
    const switchedSession = sessionId !== activeSessionId

    currentEnv = nextEnv
    activeSessionId = sessionId

    const slot = slotOf(sessionId)
    const prevSlotEnv = slot.lastEnv
    slot.lastEnv = nextEnv

    // 1. Agent is running: arm foreground completion detector for this session & clear stale suggestion.
    if (nextEnv.running) {
      const hadSuggestion = slot.activeSuggestion !== null
      slot.sawRunning = true
      slot.baselineDraftRev = null
      slot.epochInvalidated = true
      slot.activeSuggestion = null
      slot.dismissedTurns.delete(UNKNOWN_TURN_KEY)
      cancelSlotInflight(slot)
      if (hadSuggestion || switchedSession) notify()
      return
    }

    // 2. Switched into an idle session: re-anchor `baselineDraftRev` to the newly mounted SessionInputShell
    //    when its draft is clean, or invalidate if the session now carries an unsent draft/error.
    if (switchedSession) {
      if (!isSessionDraftClean(nextEnv)) {
        invalidateSessionTurn(sessionId)
        notify()
        return
      }

      // If a cached suggestion exists for an older turn than `turnHint`, drop the outdated cache.
      if (slot.activeSuggestion !== null
        && typeof nextEnv.turnHint === 'number'
        && typeof slot.activeSuggestion.turn === 'number'
        && slot.activeSuggestion.turn !== nextEnv.turnHint) {
        slot.activeSuggestion = null
        slot.epochInvalidated = true
      }

      if (slot.activeSuggestion !== null) {
        // Re-anchor baselineDraftRev because InputHub may recreate SessionInputShell (draftRev=0) on re-retain.
        slot.baselineDraftRev = nextEnv.draftRev
        slot.epochInvalidated = false
        notify()
        return
      }

      if (slot.activeAbort !== null) {
        // Request for this session is still in flight; re-anchor draftRev and wait for it.
        slot.baselineDraftRev = nextEnv.draftRev
        notify()
        return
      }

      // Backfill if this session completed a turn in the background (either `sawRunning` was armed before
      // switching away / via sidebar session list, or Host observed a live `turn/end` while another session was open).
      // Keep `sawRunning` intact if this initial mount frame is not yet interactive.
      if (isComposerInteractive(nextEnv) && !nextEnv.popupOpen) {
        const wasSawRunning = slot.sawRunning
        slot.sawRunning = false
        startSuggestionFetch(sessionId, slot, nextEnv, {
          requireLiveCompletion: !wasSawRunning,
        })
      }
      notify()
      return
    }

    // 3. Same session transitioned `running: true -> false` in place.
    if (slot.sawRunning && !nextEnv.running) {
      slot.sawRunning = false
      cancelSlotInflight(slot)
      slot.activeSuggestion = null

      if (!isSnapshotCleanForSuggestion(nextEnv) || nextEnv.popupOpen) {
        if (!isSessionDraftClean(nextEnv)) {
          if (typeof nextEnv.turnHint === 'number') slot.dismissedTurns.add(nextEnv.turnHint)
          else slot.dismissedTurns.add(UNKNOWN_TURN_KEY)
        }
        slot.baselineDraftRev = null
        slot.epochInvalidated = true
        return
      }

      startSuggestionFetch(sessionId, slot, nextEnv, {
        requireLiveCompletion: false,
      })
      return
    }

    const wasInteractive = prevSlotEnv ? isComposerInteractive(prevSlotEnv) : false
    const nowInteractive = isComposerInteractive(nextEnv)

    // 4. Same session remained idle: check if user edited draft (including type-then-delete via draftRev),
    //    inserted quote/reference chips, submitted, or hit an error; also re-render or backfill on interactivity transitions.
    if (!slot.epochInvalidated) {
      const draftMutated = slot.baselineDraftRev !== null && nextEnv.draftRev !== slot.baselineDraftRev
      if (draftMutated || !isSessionDraftClean(nextEnv)) {
        invalidateSessionTurn(sessionId)
        return
      }
      if ((prevEnv && Boolean(prevEnv.popupOpen) !== Boolean(nextEnv.popupOpen))
        || (prevSlotEnv && wasInteractive !== nowInteractive)) {
        notify()
      }
      return
    }

    // If user returned from Settings/Plugins panel, initial hydration, or cleared a temporary composer block/takeover
    // (`isComposerInteractive: false -> true`) to an idle session whose turn finished while non-interactive, backfill once.
    if (prevSlotEnv && !wasInteractive && nowInteractive
      && isSnapshotCleanForSuggestion(nextEnv) && !nextEnv.popupOpen
      && slot.activeSuggestion === null && slot.activeAbort === null) {
      const wasSawRunning = slot.sawRunning
      slot.sawRunning = false
      startSuggestionFetch(sessionId, slot, nextEnv, {
        requireLiveCompletion: !wasSawRunning,
      })
    }
  }

  /**
   * Immediately invalidate on raw user edit intent (`beforeinput`, `compositionstart`, `paste`, `drop`),
   * even if the user later deletes the typed text back to empty.
   * @param {string | undefined} [sessionId]
   */
  function notifyUserEditIntent(sessionId = currentEnv?.sessionId ?? activeSessionId ?? undefined) {
    if (disposed || !sessionId) return
    const slot = slots.get(sessionId)
    if (!slot || slot.epochInvalidated) return
    invalidateSessionTurn(sessionId)
  }

  /**
   * Whether the gray ghost preview should currently render and accept Tab/click for the given environment.
   * @param {Record<string, any> | null} [liveEnv]
   * @returns {boolean}
   */
  function isPreviewVisible(liveEnv = currentEnv) {
    const env = liveEnv ?? currentEnv
    if (disposed || env === null || typeof env.sessionId !== 'string' || env.sessionId === '') return false
    const slot = slots.get(env.sessionId)
    if (!slot || slot.epochInvalidated || slot.activeSuggestion === null) return false
    if (!isSnapshotCleanForSuggestion(env)) return false
    if (env.popupOpen) return false
    if (typeof env.turnHint === 'number'
      && typeof slot.activeSuggestion.turn === 'number'
      && slot.activeSuggestion.turn !== env.turnHint) {
      return false
    }
    // Enforce same-visit `draftRev` match once synced onto this session.
    if (activeSessionId === env.sessionId
      && slot.baselineDraftRev !== null
      && env.draftRev !== slot.baselineDraftRev) {
      return false
    }
    return true
  }

  /**
   * Current visible suggestion text, or null when hidden/absent.
   * @param {Record<string, any> | null} [liveEnv]
   * @returns {string | null}
   */
  function getVisibleSuggestion(liveEnv = currentEnv) {
    if (!isPreviewVisible(liveEnv)) return null
    const env = liveEnv ?? currentEnv
    return slots.get(env.sessionId)?.activeSuggestion?.text ?? null
  }

  /**
   * Accept the currently visible suggestion into the composer draft without submitting.
   * Shared by `Tab` keydown and direct `Tab` badge click/tap.
   *
   * @param {{
   *   acceptDraft: (text: string) => void,
   *   focusEditor?: () => void,
   *   liveEnv?: Record<string, any> | null,
   * }} context
   * @returns {boolean} true if accepted
   */
  function acceptSuggestion(context) {
    if (disposed || !context || typeof context.acceptDraft !== 'function') return false
    const env = context.liveEnv ?? currentEnv
    if (!isPreviewVisible(env)) return false
    const slot = slots.get(env.sessionId)
    if (!slot || slot.activeSuggestion === null) return false

    const acceptedText = slot.activeSuggestion.text
    invalidateSessionTurn(env.sessionId)
    context.acceptDraft(acceptedText)
    context.focusEditor?.()
    return true
  }

  /**
   * Arbitrate a bubble-phase `keydown` event on the composer card.
   * Only consumes `Tab` (accept) or `Escape` (dismiss) when preview is visible,
   * the composer editor holds focus, and no prior handler/popup claimed the event.
   *
   * @param {KeyboardEvent | Record<string, any>} event
   * @param {{
   *   isEditorFocused: boolean,
   *   acceptDraft: (text: string) => void,
   *   focusEditor?: () => void,
   *   liveEnv?: Record<string, any> | null,
   * }} context
   * @returns {boolean} true if consumed
   */
  function handleKeyDown(event, context) {
    if (disposed || !event || !context) return false
    if (event.defaultPrevented) return false
    if (event.isComposing || event.keyCode === 229) return false
    const env = context.liveEnv ?? currentEnv
    if (!isPreviewVisible(env)) return false
    if (!context.isEditorFocused) return false

    const noModifiers = !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
    if (!noModifiers) return false

    const slot = slots.get(env.sessionId)
    if (!slot || slot.activeSuggestion === null) return false

    if (event.key === 'Tab' || event.key === 'ArrowRight') {
      const isArrow = event.key === 'ArrowRight'
      // ArrowRight only triggers if composer is empty (draftRev snapshot vs null)
      // and selection is at the end (prevent accidental trigger while editing).
      if (isArrow && (env.draft !== '' || !context.isEditorFocused)) return false

      event.preventDefault?.()
      event.stopPropagation?.()
      return acceptSuggestion(context)
    }

    if (event.key === 'Escape') {
      event.preventDefault?.()
      event.stopPropagation?.()
      invalidateSessionTurn(env.sessionId)
      return true
    }

    return false
  }

  function dispose() {
    disposed = true
    for (const slot of slots.values()) {
      cancelSlotInflight(slot)
      slot.activeSuggestion = null
    }
    slots.clear()
    subscribers.clear()
    currentEnv = null
    activeSessionId = null
  }

  return {
    subscribe,
    sync,
    noteSessionRunning,
    notifyUserEditIntent,
    isPreviewVisible,
    getVisibleSuggestion,
    acceptSuggestion,
    handleKeyDown,
    invalidateCurrentTurn,
    dispose,
  }
}
