/**
 * Pure client-side state machine, key arbitration, theme-token styles, and locale dictionaries
 * for `dsh-next-step-suggestion`.
 */

export const PLUGIN_ID = 'dsh-next-step-suggestion'
export const LOCALE_NS = 'next-step-suggestion'
export const SUGGEST_ENDPOINT = '/api/next-step-suggestion/suggest'

export const LOCALES = {
  zh: {
    'tab.hint': 'Tab',
    'preview.aria': '下一步建议：{text}，按 Tab 接受，按 Esc 关闭',
  },
  en: {
    'tab.hint': 'Tab',
    'preview.aria': 'Next-step suggestion: {text}. Press Tab to accept or Esc to dismiss.',
  },
  ja: {
    'tab.hint': 'Tab',
    'preview.aria': '次のステップの提案: {text}（Tabで採用、Escで閉じる）',
  },
  es: {
    'tab.hint': 'Tab',
    'preview.aria': 'Sugerencia siguiente: {text}. Pulsa Tab para aceptar o Esc para cerrar.',
  },
  fr: {
    'tab.hint': 'Tab',
    'preview.aria': 'Suggestion suivante : {text}. Appuyez sur Tab pour accepter ou Échap pour fermer.',
  },
  de: {
    'tab.hint': 'Tab',
    'preview.aria': 'Nächster Schritt: {text}. Tab zum Übernehmen, Esc zum Schließen.',
  },
  ru: {
    'tab.hint': 'Tab',
    'preview.aria': 'Следующий шаг: {text}. Нажмите Tab, чтобы принять, или Esc, чтобы скрыть.',
  },
  pt: {
    'tab.hint': 'Tab',
    'preview.aria': 'Próxima sugestão: {text}. Pressione Tab para aceitar ou Esc para fechar.',
  },
}

/**
 * Theme-token-only CSS rules. Hides the native composer placeholder only while an active
 * ghost suggestion is rendered inside the same composer card, and hides the ghost suggestion
 * immediately if IME composition starts.
 */
export const SUGGESTION_CSS = `
[data-composer-card]:has([data-next-step-suggestion-active]) [data-composer-placeholder] {
  visibility: hidden !important;
}
[data-composer-card]:has([data-composer-composing]) [data-next-step-suggestion-active] {
  visibility: hidden !important;
}
.dsh-nss-ghost {
  position: absolute;
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
}
.dsh-nss-kbd {
  flex: none;
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--dsw-radius-sm, 4px);
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-specific-selector);
  color: var(--dsw-alias-label-tertiary);
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
}
`

/**
 * Check whether an environment snapshot is currently eligible to request or display a suggestion
 * (ignoring whether a suggestion string has arrived yet).
 * @param {Record<string, any> | null} env
 * @returns {boolean}
 */
export function isSnapshotCleanForSuggestion(env) {
  if (!env || typeof env.sessionId !== 'string' || env.sessionId === '') return false
  if (!env.foreground) return false
  if (env.running) return false
  if (env.hasError) return false
  if (env.submissionPending) return false
  if (env.phase !== 'plain') return false
  if (env.draft !== '') return false
  if (env.hasAttachments) return false
  if (env.composing) return false
  return true
}

/**
 * Create the deterministic per-composer suggestion state machine.
 *
 * @param {{
 *   fetchSuggestion: (sessionId: string, expectedTurn: number | undefined, signal: AbortSignal) => Promise<{ status?: string, turn?: number | null, suggestion?: string | null } | null>,
 *   onChange?: () => void,
 * }} deps
 */
export function createClientSuggestionMachine(deps) {
  const { fetchSuggestion, onChange = () => {} } = deps

  let disposed = false
  /** @type {Record<string, any> | null} */
  let currentEnv = null
  /** @type {string | null} */
  let trackedSessionId = null
  let sawRunningInSession = false

  /** Monotonic request token guarding against late async responses. */
  let activeRequestSeq = 0
  /** @type {AbortController | null} */
  let activeAbort = null

  /** Baseline `draftRev` captured when the turn completed; any increment permanently invalidates this turn. */
  let baselineDraftRev = null
  let epochInvalidated = true

  /** @type {{ sessionId: string, turn: number | null, text: string } | null} */
  let activeSuggestion = null

  /** Per-session sets of turns already requested or explicitly dismissed/invalidated. */
  /** @type {Map<string, Set<number>>} */
  const requestedTurnsBySession = new Map()
  /** @type {Map<string, Set<number>>} */
  const dismissedTurnsBySession = new Map()

  function notify() {
    if (!disposed) onChange()
  }

  function turnSetOf(map, sessionId) {
    let set = map.get(sessionId)
    if (!set) {
      set = new Set()
      map.set(sessionId, set)
      if (map.size > 100) {
        const oldest = map.keys().next().value
        if (oldest !== undefined) map.delete(oldest)
      }
    }
    return set
  }

  function cancelInflight() {
    activeRequestSeq += 1
    if (activeAbort !== null) {
      activeAbort.abort()
      activeAbort = null
    }
  }

  /**
   * Permanently invalidate the current completed turn's suggestion (on typing, Esc, session switch, or new turn).
   */
  function invalidateCurrentTurn() {
    const hadSuggestion = activeSuggestion !== null
    if (activeSuggestion !== null && typeof activeSuggestion.turn === 'number') {
      turnSetOf(dismissedTurnsBySession, activeSuggestion.sessionId).add(activeSuggestion.turn)
    } else if (currentEnv && typeof currentEnv.sessionId === 'string' && typeof currentEnv.turnHint === 'number') {
      turnSetOf(dismissedTurnsBySession, currentEnv.sessionId).add(currentEnv.turnHint)
    }
    epochInvalidated = true
    activeSuggestion = null
    cancelInflight()
    if (hadSuggestion) notify()
  }

  /**
   * Synchronize the latest composer/session snapshot into the state machine.
   * @param {Record<string, any>} nextEnv
   */
  function sync(nextEnv) {
    if (disposed || !nextEnv) return
    const prevEnv = currentEnv
    currentEnv = nextEnv

    // 1. Session switch: reset session tracking and discard any pending/visible suggestion immediately.
    if (nextEnv.sessionId !== trackedSessionId) {
      const hadVisible = activeSuggestion !== null
      cancelInflight()
      activeSuggestion = null
      trackedSessionId = nextEnv.sessionId ?? null
      sawRunningInSession = Boolean(nextEnv.running)
      baselineDraftRev = null
      epochInvalidated = true
      if (hadVisible) notify()
      return
    }

    // 2. Agent started or continues running: arm turn-completion detector and clear any stale suggestion.
    if (nextEnv.running) {
      const hadVisible = activeSuggestion !== null
      sawRunningInSession = true
      baselineDraftRev = null
      epochInvalidated = true
      activeSuggestion = null
      cancelInflight()
      if (hadVisible) notify()
      return
    }

    // 3. Detect transition `running: true -> false` in the foreground session.
    if (sawRunningInSession && !nextEnv.running) {
      sawRunningInSession = false
      cancelInflight()
      activeSuggestion = null

      if (!isSnapshotCleanForSuggestion(nextEnv) || nextEnv.popupOpen) {
        baselineDraftRev = null
        epochInvalidated = true
        return
      }

      const sessionId = nextEnv.sessionId
      const turnHint = typeof nextEnv.turnHint === 'number' ? nextEnv.turnHint : undefined
      if (turnHint !== undefined) {
        if (turnSetOf(requestedTurnsBySession, sessionId).has(turnHint)
          || turnSetOf(dismissedTurnsBySession, sessionId).has(turnHint)) {
          baselineDraftRev = null
          epochInvalidated = true
          return
        }
        turnSetOf(requestedTurnsBySession, sessionId).add(turnHint)
      }

      baselineDraftRev = nextEnv.draftRev
      epochInvalidated = false

      const reqSeq = ++activeRequestSeq
      const reqDraftRev = nextEnv.draftRev
      const abortController = new AbortController()
      activeAbort = abortController

      let requestPromise
      try {
        requestPromise = Promise.resolve(fetchSuggestion(sessionId, turnHint, abortController.signal))
      } catch (err) {
        requestPromise = Promise.reject(err)
      }

      void requestPromise
        .then((result) => {
          if (disposed || reqSeq !== activeRequestSeq || abortController.signal.aborted) return
          activeAbort = null
          if (epochInvalidated || currentEnv === null) return
          if (currentEnv.sessionId !== sessionId) return
          if (!isSnapshotCleanForSuggestion(currentEnv)) {
            invalidateCurrentTurn()
            return
          }
          if (currentEnv.draftRev !== reqDraftRev) {
            invalidateCurrentTurn()
            return
          }
          if (!result || result.status !== 'ready' || typeof result.suggestion !== 'string') {
            return
          }
          const text = result.suggestion.trim()
          if (text === '') return
          const resolvedTurn = typeof result.turn === 'number' ? result.turn : (turnHint ?? null)
          if (resolvedTurn !== null) {
            turnSetOf(requestedTurnsBySession, sessionId).add(resolvedTurn)
            if (turnSetOf(dismissedTurnsBySession, sessionId).has(resolvedTurn)) return
          }
          activeSuggestion = {
            sessionId,
            turn: resolvedTurn,
            text,
          }
          notify()
        })
        .catch(() => {
          // Swallows transport/abort failures: composer continues unaffected.
          if (reqSeq === activeRequestSeq) {
            activeAbort = null
          }
        })
      return
    }

    // 4. While waiting for an async suggestion or displaying one, any user edit, submission,
    //    panel switch away from foreground, or error permanently invalidates this turn's suggestion.
    if (!epochInvalidated) {
      const draftMutated = baselineDraftRev !== null && nextEnv.draftRev !== baselineDraftRev
      if (draftMutated || !isSnapshotCleanForSuggestion(nextEnv)) {
        invalidateCurrentTurn()
        return
      }
      // If popupOpen toggled, visibility changes without destroying the underlying suggestion unless edited.
      if (prevEnv && Boolean(prevEnv.popupOpen) !== Boolean(nextEnv.popupOpen) && activeSuggestion !== null) {
        notify()
      }
    }
  }

  /**
   * Immediately invalidate on raw user edit intent (`beforeinput`, `compositionstart`, `paste`, `drop`),
   * even if the user later deletes the typed text back to empty.
   */
  function notifyUserEditIntent() {
    if (disposed || epochInvalidated) return
    invalidateCurrentTurn()
  }

  /**
   * Whether the gray ghost preview should currently render and accept Tab.
   * Accepts an optional live snapshot from the current render pass to prevent 1-frame tearing.
   * @param {Record<string, any> | null} [liveEnv]
   * @returns {boolean}
   */
  function isPreviewVisible(liveEnv = currentEnv) {
    const env = liveEnv ?? currentEnv
    if (disposed || epochInvalidated || activeSuggestion === null || env === null) return false
    if (activeSuggestion.sessionId !== env.sessionId) return false
    if (!isSnapshotCleanForSuggestion(env)) return false
    if (env.popupOpen) return false
    if (baselineDraftRev !== null && env.draftRev !== baselineDraftRev) return false
    return true
  }

  /**
   * Current visible suggestion text, or null when hidden/absent.
   * @param {Record<string, any> | null} [liveEnv]
   * @returns {string | null}
   */
  function getVisibleSuggestion(liveEnv = currentEnv) {
    return isPreviewVisible(liveEnv) ? activeSuggestion.text : null
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
   * }} context
   * @returns {boolean} true if consumed
   */
  function handleKeyDown(event, context) {
    if (disposed || !event || !context) return false
    if (event.defaultPrevented) return false
    if (event.isComposing || event.keyCode === 229) return false
    if (!isPreviewVisible()) return false
    if (!context.isEditorFocused) return false

    const noModifiers = !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey
    if (!noModifiers) return false

    if (event.key === 'Tab') {
      const acceptedText = activeSuggestion.text
      event.preventDefault?.()
      event.stopPropagation?.()
      invalidateCurrentTurn()
      context.acceptDraft(acceptedText)
      return true
    }

    if (event.key === 'Escape') {
      event.preventDefault?.()
      event.stopPropagation?.()
      invalidateCurrentTurn()
      return true
    }

    return false
  }

  function dispose() {
    disposed = true
    activeSuggestion = null
    epochInvalidated = true
    cancelInflight()
    requestedTurnsBySession.clear()
    dismissedTurnsBySession.clear()
  }

  return {
    sync,
    notifyUserEditIntent,
    isPreviewVisible,
    getVisibleSuggestion,
    handleKeyDown,
    invalidateCurrentTurn,
    dispose,
  }
}
