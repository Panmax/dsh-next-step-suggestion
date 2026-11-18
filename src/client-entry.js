/**
 * Browser client entry logic for `dsh-next-step-suggestion`.
 * Bundled with `src/client-core.js` into root `client.js` for `window.__ModuleLoader__`.
 */

import {
  CONFIG_ENDPOINT,
  createClientSuggestionMachine,
  LOCALES,
  LOCALE_NS,
  PLUGIN_ID,
  SUGGEST_ENDPOINT,
  SUGGESTION_CSS,
} from './client-core.js'

const NOOP_SUBSCRIBE = () => () => {}
const FALSE_SNAPSHOT = () => false
const NULL_SNAPSHOT = () => null

function subscribePopupOpen(store) {
  if (!store || typeof store.subscribe !== 'function' || typeof store.getSnapshot !== 'function') {
    return [NOOP_SUBSCRIBE, FALSE_SNAPSHOT]
  }
  return [
    fn => store.subscribe(fn),
    () => Boolean(store.getSnapshot()?.open),
  ]
}

function hasOtherOverlayElements(anchorEl) {
  if (!anchorEl) return false
  const card = anchorEl.closest?.('[data-composer-card]')
  if (!card) return false
  // Only match interactive menu/popup/dialog surfaces inside the composer card;
  // ignore inert <style> elements injected into [data-composer-overlay] by other plugins (e.g. dsh-context)
  // and ignore unrelated DOM extensions outside the composer card.
  return Boolean(
    card.querySelector?.('[data-trigger-menu], [role="listbox"], [role="menu"], [role="dialog"], [aria-modal="true"]'),
  )
}

function findEditorElement(card) {
  if (!card || typeof card.querySelector !== 'function') return null
  return (
    card.querySelector('[data-composer-input]')
    ?? card.querySelector('[data-input-scroll] [contenteditable]')
    ?? null
  )
}

function isEditorElementEditable(editorEl) {
  if (!editorEl) return false
  if (editorEl.getAttribute?.('aria-disabled') === 'true') return false
  if (editorEl.hasAttribute?.('disabled')) return false
  const ceAttr = editorEl.getAttribute?.('contenteditable')
  if (ceAttr === 'false') return false
  if (typeof editorEl.isContentEditable === 'boolean' && !editorEl.isContentEditable && ceAttr === undefined) {
    return false
  }
  return true
}

function hasDomInlineDecorators(card) {
  if (!card || typeof card.querySelector !== 'function') return false
  return Boolean(
    card.querySelector('[data-composer-quote], [data-composer-chip], [data-composer-command], [data-lexical-decorator]'),
  )
}

function isComposerTakenOver(card) {
  if (!card || typeof card.closest !== 'function') return false
  const fallbackAnchor = card.closest('[data-chain-overlay-fallback="conversation.composer"]')
  if (!fallbackAnchor) return false
  if (fallbackAnchor.style?.display === 'none') return true
  if (fallbackAnchor.hidden === true || fallbackAnchor.getAttribute?.('aria-hidden') === 'true') return true
  return false
}

function readComposerDomGates(anchorEl) {
  const card = anchorEl?.closest?.('[data-composer-card]') ?? null
  const editorEl = findEditorElement(card)
  return {
    card,
    editorEl,
    domOverlayOpen: hasOtherOverlayElements(anchorEl),
    composing: Boolean(editorEl?.hasAttribute?.('data-composer-composing')),
    editorEditable: card ? isEditorElementEditable(editorEl) : false,
    hasDomDecorators: hasDomInlineDecorators(card),
    composerTakenOver: isComposerTakenOver(card),
  }
}

function domGateSignature(anchorEl) {
  const g = readComposerDomGates(anchorEl)
  return `${Number(g.domOverlayOpen)}:${Number(g.composing)}:${Number(g.editorEditable)}:${Number(g.hasDomDecorators)}:${Number(g.composerTakenOver)}`
}

const CUSTOM_MODEL_SENTINEL = '__custom__'
let configCardInstanceSeq = 0

function parsePositiveIntInput(raw) {
  const trimmed = String(raw ?? '').trim()
  if (!/^\d+$/u.test(trimmed)) return null
  const num = Number(trimmed)
  return Number.isSafeInteger(num) && num > 0 ? num : null
}

function makeTranslator(t) {
  return typeof t === 'function'
    ? t
    : ((key, vars) => {
        const template = LOCALES.en[key] ?? key
        return vars?.text ? template.replace('{text}', vars.text) : template
      })
}

/**
 * Build the Cordis client plugin definition given `React` from the browser module table.
 * @param {any} React
 * @param {{ fetchImpl?: typeof fetch }} [options]
 */
export function createClientPlugin(React, options = {}) {
  const h = React.createElement
  const fetchFn = options.fetchImpl ?? ((...args) => globalThis.fetch(...args))

  function requestSuggestionFromHost(sessionId, expectedTurn, signal, reqOptions) {
    return fetchFn(SUGGEST_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        ...(typeof expectedTurn === 'number' ? { expectedTurn } : {}),
        ...(reqOptions?.requireLiveCompletion === true ? { requireLiveCompletion: true } : {}),
      }),
      signal,
    }).then((res) => {
      if (!res || !res.ok) return null
      return res.json()
    })
  }

  function fetchConfigFromHost(signal) {
    return fetchFn(CONFIG_ENDPOINT, {
      method: 'GET',
      credentials: 'same-origin',
      signal,
    }).then(async (res) => {
      if (!res || !res.ok) {
        if (res?.status === 404) {
          const notReadyErr = new Error('HTTP 404')
          notReadyErr.code = 'ROUTE_NOT_READY'
          throw notReadyErr
        }
        let message = ''
        try {
          const errBody = await res?.json?.()
          if (typeof errBody?.message === 'string') message = errBody.message
        } catch {
          // Ignore non-JSON error body.
        }
        throw new Error(message || `HTTP ${res?.status ?? 'error'}`)
      }
      return res.json()
    })
  }

  function saveConfigToHost(payload) {
    return fetchFn(CONFIG_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(async (res) => {
      if (!res || !res.ok) {
        const errData = await res?.json?.().catch(() => null)
        throw new Error(typeof errData?.message === 'string' && errData.message !== '' ? errData.message : `HTTP ${res?.status ?? 'error'}`)
      }
      return res.json()
    })
  }

  return {
    name: 'next-step-suggestion',
    inject: ['slots', 'locale'],
    apply(ctx) {
      // Plugin-scoped state machine survives session-slot unmount/remount across session switches
      // and disposes cleanly when the plugin itself is disabled or hot-reloaded.
      const machine = createClientSuggestionMachine({
        fetchSuggestion: requestSuggestionFromHost,
      })

      ctx.effect(() => () => {
        machine.dispose()
      }, 'next-step-suggestion: machine')

      // Observe global sidebar session list so background-running sessions arm `sawRunning` even if never opened yet.
      ctx.effect(() => {
        const listStore = (ctx.get?.('sessions') ?? ctx.sessions)?.list
        if (!listStore || typeof listStore.subscribe !== 'function' || typeof listStore.getSnapshot !== 'function') {
          return () => {}
        }
        const scanRunningSessions = () => {
          const byId = listStore.getSnapshot()?.byId
          if (!byId || typeof byId !== 'object') return
          for (const [id, row] of Object.entries(byId)) {
            if (row && row.running === true) {
              machine.noteSessionRunning(id)
            }
          }
        }
        scanRunningSessions()
        return listStore.subscribe(scanRunningSessions)
      }, 'next-step-suggestion: background session observer')

      ctx.effect(
        () => ctx.locale.register(LOCALE_NS, LOCALES),
        'next-step-suggestion: dictionaries',
      )

      ctx.effect(() => {
        if (typeof document === 'undefined' || !document.head) return () => {}
        const styleEl = document.createElement('style')
        styleEl.setAttribute('data-dsh-plugin', PLUGIN_ID)
        styleEl.textContent = SUGGESTION_CSS
        document.head.appendChild(styleEl)
        return () => {
          styleEl.remove()
        }
      }, 'next-step-suggestion: styles')

      function NextStepOverlay(props) {
        const {
          sessionId,
          useSession,
          useInput,
          inputActions,
          useProjection,
          usePanelInfo,
          useAccess,
          t,
        } = props

        const anchorRef = React.useRef(null)
        const inputActionsRef = React.useRef(inputActions)
        inputActionsRef.current = inputActions

        const [, forceRender] = React.useReducer(c => c + 1, 0)
        const [topOffset, setTopOffset] = React.useState(8)

        React.useEffect(() => machine.subscribe(() => {
          forceRender()
        }), [])

        // Subscribe to optional trigger & command popup stores for this session.
        const sessionStores = React.useMemo(() => {
          const sessionsSvc = ctx.get?.('sessions') ?? ctx.sessions
          const actx = sessionId && sessionsSvc?.scope ? sessionsSvc.scope(sessionId) : undefined
          const triggerMenu = actx ? (ctx.get?.('inputTriggers') ?? ctx.inputTriggers)?.sessionOf?.(actx)?.menu : undefined
          const commandPopup = actx ? (ctx.get?.('commandUi') ?? ctx.commandUi)?.popupFor?.(actx)?.state : undefined
          return { triggerMenu, commandPopup }
        }, [sessionId])

        const [subTrigger, snapTrigger] = subscribePopupOpen(sessionStores.triggerMenu)
        const triggerOpen = React.useSyncExternalStore(subTrigger, snapTrigger, FALSE_SNAPSHOT)

        const [subPopup, snapPopup] = subscribePopupOpen(sessionStores.commandPopup)
        const commandPopupOpen = React.useSyncExternalStore(subPopup, snapPopup, FALSE_SNAPSHOT)

        // Read panel foreground state (fallback to ctx.layout.panelInfo when hook prop absent).
        const layoutPanelStore = (ctx.get?.('layout') ?? ctx.layout)?.panelInfo
        const panelIdFromHook = typeof usePanelInfo === 'function'
          ? usePanelInfo(info => info?.activePanelId ?? null)
          : undefined
        const panelIdFromStore = React.useSyncExternalStore(
          layoutPanelStore?.subscribe ? fn => layoutPanelStore.subscribe(fn) : NOOP_SUBSCRIBE,
          layoutPanelStore?.getSnapshot ? () => layoutPanelStore.getSnapshot()?.activePanelId ?? null : NULL_SNAPSHOT,
          NULL_SNAPSHOT,
        )
        const activePanelId = panelIdFromHook !== undefined ? panelIdFromHook : panelIdFromStore

        const promptAllowed = typeof useAccess === 'function' ? useAccess('session/prompt') !== false : true

        const running = (typeof useSession === 'function' ? useSession(s => s?.running) : false) ?? false
        const promptError = (typeof useSession === 'function' ? useSession(s => s?.promptError) : null) ?? null
        const pendingCount = (typeof useSession === 'function' ? useSession(s => s?.pendingSubmissions?.length ?? 0) : 0) ?? 0
        const subagent = (typeof useSession === 'function' ? useSession(s => s?.subagent) : null) ?? null
        const removed = (typeof useSession === 'function' ? useSession(s => s?.removed) : false) ?? false

        // `conversationContinuation` projects `null` when healthy and a numeric `SessionSeq` when retryable failure exists.
        const retryableFailure = (typeof useProjection === 'function'
          ? useProjection('conversationContinuation')
          : null) ?? null
        const turnOutline = typeof useProjection === 'function'
          ? useProjection('turnOutline')
          : undefined
        const turnHint = Array.isArray(turnOutline) && turnOutline.length > 0
          ? turnOutline[turnOutline.length - 1]?.turn
          : undefined

        const input = typeof useInput === 'function' ? useInput(s => s) : undefined
        const draft = input?.draft ?? ''
        const draftRev = input?.draftRev ?? 0
        const hasAttachments = (input?.attachmentIds?.length ?? 0) > 0
        const hasStructuredDecorators = (input?.occurrences?.length ?? 0) > 0 || (input?.quotes?.length ?? 0) > 0
        const phase = input?.phase ?? 'plain'
        const queueLen = input?.queue?.length ?? 0

        const rawPlan = typeof useProjection === 'function' ? useProjection('plan') : undefined
        const planActive = Boolean(
          rawPlan && typeof rawPlan === 'object'
            ? (rawPlan.pending ? !rawPlan.active : rawPlan.active)
            : rawPlan === true,
        )
        const goal = typeof useProjection === 'function' ? useProjection('goal') : undefined
        const goalActive = Boolean(goal?.goal?.phase === 'active')

        const subagentCatalog = typeof useProjection === 'function' ? useProjection('subagentCatalog') : undefined
        const sessionsListStore = (ctx.get?.('sessions') ?? ctx.sessions)?.list
        const hasSubagentEntries = Array.isArray(subagentCatalog) && subagentCatalog.length > 0
        const subscribeSessionsList = React.useMemo(
          () => (sessionsListStore?.subscribe && hasSubagentEntries
            ? fn => sessionsListStore.subscribe(fn)
            : NOOP_SUBSCRIBE),
          [sessionsListStore, hasSubagentEntries],
        )
        const hasRunningSubagent = React.useSyncExternalStore(
          subscribeSessionsList,
          () => {
            if (!hasSubagentEntries) return false
            if (subagentCatalog.some(entry => entry?.activity === 'running')) return true
            const byId = sessionsListStore?.getSnapshot?.()?.byId
            if (!byId || typeof byId !== 'object') return false
            return subagentCatalog.some(entry => entry?.id && byId[entry.id]?.running === true)
          },
          FALSE_SNAPSHOT,
        )

        const jobsStateStore = (ctx.get?.('jobs') ?? ctx.jobs)?.state
        const hasSessionId = Boolean(sessionId)
        const subscribeJobsState = React.useMemo(
          () => (jobsStateStore?.subscribe && hasSessionId
            ? fn => jobsStateStore.subscribe(fn)
            : NOOP_SUBSCRIBE),
          [jobsStateStore, hasSessionId],
        )
        const hasRunningJob = React.useSyncExternalStore(
          subscribeJobsState,
          () => {
            if (!sessionId) return false
            const rows = jobsStateStore?.getSnapshot?.()?.rows?.[sessionId]
            return Array.isArray(rows) && rows.some(j => j && (j.status === 'running' || j.status === 'stopping'))
          },
          FALSE_SNAPSHOT,
        )
        const backgroundWorkRunning = hasRunningSubagent || hasRunningJob

        const buildEnvForAnchor = (anchorNode) => {
          const domGates = readComposerDomGates(anchorNode)
          return {
            sessionId: typeof sessionId === 'string' ? sessionId : '',
            foreground: activePanelId === null && !removed && subagent === null && input !== undefined && inputActions !== undefined,
            promptAllowed,
            editorEditable: domGates.editorEditable,
            composerTakenOver: domGates.composerTakenOver,
            planActive,
            goalActive,
            backgroundWorkRunning,
            running,
            hasError: promptError !== null || retryableFailure !== null,
            submissionPending: pendingCount > 0 || queueLen > 0,
            draft,
            draftRev,
            hasAttachments,
            hasInlineDecorators: hasStructuredDecorators || domGates.hasDomDecorators,
            phase,
            popupOpen: triggerOpen || commandPopupOpen || domGates.domOverlayOpen,
            composing: domGates.composing,
            turnHint,
          }
        }

        const envSnapshot = buildEnvForAnchor(anchorRef.current)
        const envRef = React.useRef(envSnapshot)
        envRef.current = envSnapshot

        const buildEnvRef = React.useRef(buildEnvForAnchor)
        buildEnvRef.current = buildEnvForAnchor

        const applyAcceptedDraft = (acceptedText) => {
          const actions = inputActionsRef.current
          if (!actions || typeof actions.setDraft !== 'function') return
          actions.setDraft(acceptedText)
          actions.persistDraft?.()
        }

        const focusComposerEditor = () => {
          const card = anchorRef.current?.closest?.('[data-composer-card]')
          const editor = findEditorElement(card)
          if (!editor || !isEditorElementEditable(editor)) return
          const active = card?.ownerDocument?.activeElement ?? (typeof document !== 'undefined' ? document.activeElement : null)
          if (active !== editor && typeof editor.focus === 'function') {
            try {
              editor.focus({ preventScroll: true })
            } catch {
              editor.focus()
            }
          }
        }

        // Synchronize committed DOM + React environment snapshot after commit.
        React.useEffect(() => {
          const committedEnv = buildEnvRef.current(anchorRef.current)
          envRef.current = committedEnv
          machine.sync(committedEnv)
        })

        React.useLayoutEffect(() => {
          const anchor = anchorRef.current
          const card = anchor?.closest?.('[data-composer-card]')
          if (!card) return undefined
          const scrollBox = card.querySelector?.('[data-input-scroll]')
          const updateOffset = () => {
            if (scrollBox && typeof scrollBox.offsetTop === 'number') {
              setTopOffset(scrollBox.offsetTop)
            }
          }
          updateOffset()
          if (typeof ResizeObserver === 'function' && scrollBox) {
            const ro = new ResizeObserver(updateOffset)
            ro.observe(card)
            return () => { ro.disconnect() }
          }
          return undefined
        }, [sessionId])

        // Observe DOM-only composer gate transitions (`blocked` toggling `contenteditable` / `aria-disabled`,
        // inline quote/chip decorator portals, or `conversation.composer` chain takeover `display: none`).
        React.useEffect(() => {
          if (typeof MutationObserver !== 'function') return undefined
          const anchor = anchorRef.current
          const card = anchor?.closest?.('[data-composer-card]')
          if (!card) return undefined

          const fallbackAnchor = card.closest?.('[data-chain-overlay-fallback="conversation.composer"]') ?? null
          let lastSig = domGateSignature(anchor)

          const onDomMutated = () => {
            const nextSig = domGateSignature(anchor)
            if (nextSig !== lastSig) {
              lastSig = nextSig
              forceRender()
            }
          }

          const observer = new MutationObserver(onDomMutated)
          observer.observe(card, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['contenteditable', 'aria-disabled', 'disabled', 'data-composer-composing', 'role', 'aria-modal'],
          })
          if (fallbackAnchor) {
            observer.observe(fallbackAnchor, {
              attributes: true,
              attributeFilter: ['style', 'hidden', 'aria-hidden'],
            })
          }
          return () => {
            observer.disconnect()
          }
        }, [sessionId])

        React.useEffect(() => {
          const anchor = anchorRef.current
          const card = anchor?.closest?.('[data-composer-card]')
          if (!card) return undefined

          const onEditIntent = () => {
            machine.notifyUserEditIntent(envRef.current.sessionId)
          }

          const onKeyDown = (ev) => {
            const liveEnv = buildEnvRef.current(anchorRef.current)
            envRef.current = liveEnv
            if (liveEnv.popupOpen) return
            const editor = findEditorElement(card)
            const active = card.ownerDocument?.activeElement ?? (typeof document !== 'undefined' ? document.activeElement : null)
            const isEditorFocused = Boolean(
              editor && active && (active === editor || (typeof editor.contains === 'function' && editor.contains(active))),
            )
            machine.handleKeyDown(ev, {
              isEditorFocused,
              liveEnv,
              acceptDraft: applyAcceptedDraft,
            })
          }

          card.addEventListener('beforeinput', onEditIntent, true)
          card.addEventListener('compositionstart', onEditIntent, true)
          card.addEventListener('paste', onEditIntent, true)
          card.addEventListener('drop', onEditIntent, true)
          card.addEventListener('keydown', onKeyDown, false)

          return () => {
            card.removeEventListener('beforeinput', onEditIntent, true)
            card.removeEventListener('compositionstart', onEditIntent, true)
            card.removeEventListener('paste', onEditIntent, true)
            card.removeEventListener('drop', onEditIntent, true)
            card.removeEventListener('keydown', onKeyDown, false)
          }
        }, [sessionId])

        const onAcceptBadgeMouseDown = (ev) => {
          // Keep current editor focus intact on mouse press without suppressing synthetic click on touch.
          ev?.preventDefault?.()
          ev?.stopPropagation?.()
        }

        const onAcceptBadgeClick = (ev) => {
          ev?.preventDefault?.()
          ev?.stopPropagation?.()
          const liveEnv = buildEnvRef.current(anchorRef.current)
          envRef.current = liveEnv
          if (liveEnv.popupOpen) return
          machine.acceptSuggestion({
            liveEnv,
            acceptDraft: applyAcceptedDraft,
            focusEditor: focusComposerEditor,
          })
        }

        const suggestionText = machine.getVisibleSuggestion(envSnapshot)
        const translate = makeTranslator(t)
        const acceptLabel = translate('accept.label')

        return h(
          'div',
          {
            ref: anchorRef,
            'data-nss-anchor': '',
            style: { position: 'static', width: 0, height: 0 },
          },
          suggestionText === null
            ? null
            : h(
                'div',
                {
                  className: 'dsh-nss-ghost',
                  'data-next-step-suggestion-active': '',
                  style: { top: `${String(topOffset)}px` },
                  'aria-label': translate('preview.aria', { text: suggestionText }),
                },
                h('span', { className: 'dsh-nss-text' }, suggestionText),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-nss-kbd',
                    'data-nss-accept': '',
                    tabIndex: -1,
                    'aria-label': acceptLabel,
                    title: acceptLabel,
                    onMouseDown: onAcceptBadgeMouseDown,
                    onClick: onAcceptBadgeClick,
                  },
                  translate('tab.hint'),
                ),
              ),
        )
      }

      function BundleConfigCard(props) {
        if (props?.view === 'summary') return null
        const translate = makeTranslator(props?.t)
        const idPrefixRef = React.useRef(null)
        if (idPrefixRef.current === null) {
          configCardInstanceSeq += 1
          idPrefixRef.current = `dsh-nss-cfg-${configCardInstanceSeq}`
        }
        const idPrefix = idPrefixRef.current
        const customModelInputRef = React.useRef(null)
        const pendingCustomFocusRef = React.useRef(false)

        const [loadState, setLoadState] = React.useState('loading')
        const [loadError, setLoadError] = React.useState('')
        const [reloadSeq, setReloadSeq] = React.useState(0)
        const [editable, setEditable] = React.useState(true)
        const [defaults, setDefaults] = React.useState({ maxInputBytes: 6000, maxOutputTokens: 4096, timeoutMs: 30000 })
        const [maxTimeoutMs, setMaxTimeoutMs] = React.useState(300000)
        const [providers, setProviders] = React.useState([])
        const [baseline, setBaseline] = React.useState(null)
        const [draft, setDraft] = React.useState({
          routeMode: 'session',
          provider: '',
          model: '',
          useCustomModel: false,
          maxInputBytes: '6000',
          maxOutputTokens: '4096',
          timeoutMs: '30000',
        })
        const [advancedOpen, setAdvancedOpen] = React.useState(false)
        const [saving, setSaving] = React.useState(false)
        const [feedback, setFeedback] = React.useState(null)

        React.useEffect(() => {
          const ac = new AbortController()
          setLoadState('loading')
          setLoadError('')

          fetchConfigFromHost(ac.signal)
            .then((data) => {
              if (ac.signal.aborted || !data || typeof data !== 'object') return
              const cfg = data.config ?? {}
              const defs = {
                maxInputBytes: data.defaults?.maxInputBytes ?? 6000,
                maxOutputTokens: data.defaults?.maxOutputTokens ?? 4096,
                timeoutMs: data.defaults?.timeoutMs ?? 30000,
              }
              const provs = Array.isArray(data.providers) ? data.providers : []
              const hasPinned = typeof cfg.provider === 'string' && cfg.provider !== ''
                && typeof cfg.model === 'string' && cfg.model !== ''
              const initialProvider = hasPinned
                ? cfg.provider
                : (data.defaultRoute?.provider ?? provs[0]?.id ?? '')
              const matchedProv = provs.find(p => p.id === initialProvider)
              const initialModel = hasPinned
                ? cfg.model
                : (matchedProv?.models?.[0]?.id ?? data.defaultRoute?.model ?? '')
              const inCatalog = Boolean(matchedProv?.models?.some(m => m.id === initialModel))
              const useCustomModel = hasPinned
                ? !inCatalog
                : (!matchedProv || !Array.isArray(matchedProv.models) || matchedProv.models.length === 0)

              const resolvedInputBytes = cfg.maxInputBytes ?? defs.maxInputBytes
              const resolvedOutputTokens = cfg.maxOutputTokens ?? defs.maxOutputTokens
              const resolvedTimeoutMs = cfg.timeoutMs ?? defs.timeoutMs

              setEditable(data.editable !== false)
              setDefaults(defs)
              if (typeof data.maxTimeoutMs === 'number' && data.maxTimeoutMs > 0) {
                setMaxTimeoutMs(data.maxTimeoutMs)
              }
              setProviders(provs)
              setBaseline({
                routeMode: hasPinned ? 'custom' : 'session',
                provider: hasPinned ? cfg.provider : '',
                model: hasPinned ? cfg.model : '',
                maxInputBytes: resolvedInputBytes,
                maxOutputTokens: resolvedOutputTokens,
                timeoutMs: resolvedTimeoutMs,
              })
              setDraft({
                routeMode: hasPinned ? 'custom' : 'session',
                provider: initialProvider,
                model: initialModel,
                useCustomModel,
                maxInputBytes: String(resolvedInputBytes),
                maxOutputTokens: String(resolvedOutputTokens),
                timeoutMs: String(resolvedTimeoutMs),
              })
              if (resolvedInputBytes !== defs.maxInputBytes
                || resolvedOutputTokens !== defs.maxOutputTokens
                || resolvedTimeoutMs !== defs.timeoutMs) {
                setAdvancedOpen(true)
              }
              setLoadState('ready')
            })
            .catch((err) => {
              if (ac.signal.aborted) return
              if (err?.code === 'ROUTE_NOT_READY') {
                setLoadError(translate('cfg.routeNotReady'))
              } else {
                setLoadError(err instanceof Error && err.message ? err.message : translate('cfg.loadError'))
              }
              setLoadState('error')
            })

          return () => { ac.abort() }
        }, [reloadSeq])

        React.useEffect(() => {
          if (pendingCustomFocusRef.current) {
            pendingCustomFocusRef.current = false
            customModelInputRef.current?.focus?.()
          }
        }, [draft.useCustomModel])

        if (loadState === 'loading') {
          return h(
            'div',
            { className: 'dsh-nss-cfg-root', 'data-nss-config-card': 'loading' },
            h('h4', { className: 'dsh-nss-cfg-title' }, translate('cfg.title')),
            h('div', { className: 'dsh-nss-cfg-card' }, h('p', { className: 'dsh-nss-cfg-hint' }, translate('cfg.loading'))),
          )
        }

        if (loadState === 'error') {
          return h(
            'div',
            { className: 'dsh-nss-cfg-root', 'data-nss-config-card': 'error' },
            h('h4', { className: 'dsh-nss-cfg-title' }, translate('cfg.title')),
            h(
              'div',
              { className: 'dsh-nss-cfg-card' },
              h('p', { className: 'dsh-nss-cfg-error', role: 'alert' }, loadError || translate('cfg.loadError')),
              h(
                'div',
                { className: 'dsh-nss-cfg-buttons' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-nss-cfg-btn',
                    'data-nss-cfg-retry': '',
                    onClick: () => { setReloadSeq(n => n + 1) },
                  },
                  translate('cfg.retry'),
                ),
              ),
            ),
          )
        }

        const parsedInputBytes = parsePositiveIntInput(draft.maxInputBytes)
        const parsedOutputTokens = parsePositiveIntInput(draft.maxOutputTokens)
        const parsedTimeoutMs = parsePositiveIntInput(draft.timeoutMs)
        const limitsValid = parsedInputBytes !== null
          && parsedOutputTokens !== null
          && parsedTimeoutMs !== null
          && parsedTimeoutMs <= maxTimeoutMs

        const trimmedProvider = draft.provider.trim()
        const trimmedModel = draft.model.trim()
        const routeValid = draft.routeMode === 'session' || (trimmedProvider.length > 0 && trimmedModel.length > 0)
        const formValid = limitsValid && routeValid

        const isDirty = baseline !== null && (
          baseline.routeMode !== draft.routeMode
          || (draft.routeMode === 'custom' && (baseline.provider !== trimmedProvider || baseline.model !== trimmedModel))
          || baseline.maxInputBytes !== parsedInputBytes
          || baseline.maxOutputTokens !== parsedOutputTokens
          || baseline.timeoutMs !== parsedTimeoutMs
        )

        const isAtDefaults = draft.routeMode === 'session'
          && parsedInputBytes === defaults.maxInputBytes
          && parsedOutputTokens === defaults.maxOutputTokens
          && parsedTimeoutMs === defaults.timeoutMs

        const currentProv = providers.find(p => p.id === draft.provider) ?? null
        const hasCatalogModels = Boolean(currentProv && Array.isArray(currentProv.models) && currentProv.models.length > 0)
        const providerOptions = [...providers]
        if (draft.provider !== '' && !providerOptions.some(p => p.id === draft.provider)) {
          providerOptions.unshift({ id: draft.provider, name: draft.provider, models: [] })
        }

        const updateDraft = (patch) => {
          setFeedback(null)
          setDraft(prev => ({ ...prev, ...patch }))
        }

        const onSelectRouteMode = (mode) => {
          if (mode === 'custom') {
            const fallbackProvId = draft.provider || providers[0]?.id || ''
            const prov = providers.find(p => p.id === fallbackProvId)
            const fallbackModel = draft.model || prov?.models?.[0]?.id || ''
            const inCat = Boolean(prov?.models?.some(m => m.id === fallbackModel))
            updateDraft({
              routeMode: 'custom',
              provider: fallbackProvId,
              model: fallbackModel,
              useCustomModel: !prov || prov.models.length === 0 || !inCat,
            })
          } else {
            updateDraft({ routeMode: 'session' })
          }
        }

        const onProviderChange = (nextProvId) => {
          const prov = providers.find(p => p.id === nextProvId)
          const firstModel = prov?.models?.[0]?.id ?? ''
          updateDraft({
            provider: nextProvId,
            model: firstModel,
            useCustomModel: !prov || !Array.isArray(prov.models) || prov.models.length === 0,
          })
        }

        const onModelSelectChange = (val) => {
          if (val === CUSTOM_MODEL_SENTINEL) {
            const wasCatalogModel = Boolean(currentProv?.models?.some(m => m.id === draft.model))
            pendingCustomFocusRef.current = true
            updateDraft({
              useCustomModel: true,
              ...(wasCatalogModel ? { model: '' } : {}),
            })
          } else {
            updateDraft({ useCustomModel: false, model: val })
          }
        }

        const onResetDefaults = () => {
          updateDraft({
            routeMode: 'session',
            maxInputBytes: String(defaults.maxInputBytes),
            maxOutputTokens: String(defaults.maxOutputTokens),
            timeoutMs: String(defaults.timeoutMs),
          })
        }

        const onSave = () => {
          if (!editable || saving || !formValid || !isDirty) return
          setSaving(true)
          setFeedback(null)
          const payload = {
            maxInputBytes: parsedInputBytes,
            maxOutputTokens: parsedOutputTokens,
            timeoutMs: parsedTimeoutMs,
            provider: draft.routeMode === 'custom' ? trimmedProvider : null,
            model: draft.routeMode === 'custom' ? trimmedModel : null,
          }
          saveConfigToHost(payload)
            .then((res) => {
              const saved = res?.config ?? payload
              const savedCustom = typeof saved.provider === 'string' && saved.provider !== ''
                && typeof saved.model === 'string' && saved.model !== ''
              setBaseline({
                routeMode: savedCustom ? 'custom' : 'session',
                provider: savedCustom ? saved.provider : '',
                model: savedCustom ? saved.model : '',
                maxInputBytes: saved.maxInputBytes,
                maxOutputTokens: saved.maxOutputTokens,
                timeoutMs: saved.timeoutMs,
              })
              setFeedback({ kind: 'saved', text: translate('cfg.saved') })
            })
            .catch((err) => {
              setFeedback({
                kind: 'error',
                text: err instanceof Error && err.message ? err.message : translate('cfg.loadError'),
              })
            })
            .finally(() => {
              setSaving(false)
            })
        }

        const validationMessage = !routeValid
          ? translate('cfg.invalidRoute')
          : (!limitsValid ? translate('cfg.invalidLimits') : null)

        const controlsDisabled = !editable || saving

        return h(
          'div',
          { className: 'dsh-nss-cfg-root', 'data-nss-config-card': 'ready' },
          h('h4', { className: 'dsh-nss-cfg-title' }, translate('cfg.title')),
          h(
            'div',
            { className: 'dsh-nss-cfg-card' },
            !editable
              ? h('p', { className: 'dsh-nss-cfg-hint', role: 'status' }, translate('cfg.readOnly'))
              : null,
            h(
              'fieldset',
              { className: 'dsh-nss-cfg-group', disabled: controlsDisabled },
              h('legend', { className: 'dsh-nss-cfg-legend' }, translate('cfg.routeLabel')),
              h(
                'label',
                { className: 'dsh-nss-cfg-radio' },
                h('input', {
                  type: 'radio',
                  name: 'dsh-nss-route-mode',
                  'data-nss-cfg-mode': 'session',
                  checked: draft.routeMode === 'session',
                  onChange: () => onSelectRouteMode('session'),
                }),
                h(
                  'span',
                  { className: 'dsh-nss-cfg-radio-copy' },
                  h('span', null, translate('cfg.routeSession')),
                  h('span', { className: 'dsh-nss-cfg-hint' }, translate('cfg.routeSessionHint')),
                ),
              ),
              h(
                'label',
                { className: 'dsh-nss-cfg-radio' },
                h('input', {
                  type: 'radio',
                  name: 'dsh-nss-route-mode',
                  'data-nss-cfg-mode': 'custom',
                  checked: draft.routeMode === 'custom',
                  onChange: () => onSelectRouteMode('custom'),
                }),
                h(
                  'span',
                  { className: 'dsh-nss-cfg-radio-copy' },
                  h('span', null, translate('cfg.routeCustom')),
                  h('span', { className: 'dsh-nss-cfg-hint' }, translate('cfg.routeCustomHint')),
                ),
              ),
            ),
            draft.routeMode === 'custom'
              ? h(
                  'div',
                  { className: 'dsh-nss-cfg-grid', 'data-nss-cfg-route-fields': '' },
                  h(
                    'div',
                    { className: 'dsh-nss-cfg-field' },
                    h('label', { htmlFor: `${idPrefix}-provider` }, translate('cfg.provider')),
                    providerOptions.length > 0
                      ? h(
                          'select',
                          {
                            id: `${idPrefix}-provider`,
                            className: 'dsh-nss-cfg-control',
                            'data-nss-cfg-provider-select': '',
                            disabled: controlsDisabled,
                            value: draft.provider,
                            onChange: ev => onProviderChange(ev.target.value),
                          },
                          ...providerOptions.map(p =>
                            h('option', { key: p.id, value: p.id }, p.name && p.name !== p.id ? `${p.name} (${p.id})` : p.id),
                          ),
                        )
                      : h('input', {
                          id: `${idPrefix}-provider`,
                          type: 'text',
                          className: 'dsh-nss-cfg-control',
                          'data-nss-cfg-provider-input': '',
                          disabled: controlsDisabled,
                          value: draft.provider,
                          placeholder: translate('cfg.providerPlaceholder'),
                          onChange: ev => updateDraft({ provider: ev.target.value }),
                        }),
                  ),
                  h(
                    'div',
                    { className: 'dsh-nss-cfg-field' },
                    h('label', { htmlFor: `${idPrefix}-model` }, translate('cfg.model')),
                    hasCatalogModels
                      ? h(
                          'select',
                          {
                            id: `${idPrefix}-model`,
                            className: 'dsh-nss-cfg-control',
                            'data-nss-cfg-model-select': '',
                            disabled: controlsDisabled,
                            value: draft.useCustomModel ? CUSTOM_MODEL_SENTINEL : draft.model,
                            onChange: ev => onModelSelectChange(ev.target.value),
                          },
                          ...currentProv.models.map(m =>
                            h('option', { key: m.id, value: m.id }, m.name && m.name !== m.id ? `${m.name} (${m.id})` : m.id),
                          ),
                          h('option', { key: CUSTOM_MODEL_SENTINEL, value: CUSTOM_MODEL_SENTINEL }, translate('cfg.modelCustomOption')),
                        )
                      : null,
                    !hasCatalogModels || draft.useCustomModel
                      ? h('input', {
                          id: hasCatalogModels ? `${idPrefix}-model-custom` : `${idPrefix}-model`,
                          ref: customModelInputRef,
                          type: 'text',
                          className: 'dsh-nss-cfg-control',
                          'data-nss-cfg-model-input': '',
                          'aria-label': translate('cfg.modelPlaceholder'),
                          disabled: controlsDisabled,
                          value: draft.model,
                          placeholder: translate('cfg.modelPlaceholder'),
                          onChange: ev => updateDraft({ model: ev.target.value }),
                        })
                      : null,
                  ),
                )
              : null,
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-nss-cfg-adv-toggle',
                'data-nss-cfg-adv-toggle': '',
                'aria-expanded': advancedOpen,
                onClick: () => { setAdvancedOpen(open => !open) },
              },
              `${advancedOpen ? '▾' : '▸'} ${translate('cfg.advancedToggle')} (${draft.timeoutMs} ms · ${draft.maxInputBytes} B · ${draft.maxOutputTokens} tok)`,
            ),
            advancedOpen
              ? h(
                  'div',
                  { className: 'dsh-nss-cfg-grid', 'data-nss-cfg-adv-fields': '' },
                  h(
                    'div',
                    { className: 'dsh-nss-cfg-field' },
                    h('label', { htmlFor: `${idPrefix}-timeout` }, translate('cfg.timeoutMs')),
                    h('input', {
                      id: `${idPrefix}-timeout`,
                      type: 'number',
                      min: 1,
                      max: maxTimeoutMs,
                      step: 1000,
                      className: 'dsh-nss-cfg-control',
                      'data-nss-cfg-timeout': '',
                      disabled: controlsDisabled,
                      value: draft.timeoutMs,
                      onChange: ev => updateDraft({ timeoutMs: ev.target.value }),
                    }),
                  ),
                  h(
                    'div',
                    { className: 'dsh-nss-cfg-field' },
                    h('label', { htmlFor: `${idPrefix}-input-bytes` }, translate('cfg.maxInputBytes')),
                    h('input', {
                      id: `${idPrefix}-input-bytes`,
                      type: 'number',
                      min: 1,
                      step: 500,
                      className: 'dsh-nss-cfg-control',
                      'data-nss-cfg-input-bytes': '',
                      disabled: controlsDisabled,
                      value: draft.maxInputBytes,
                      onChange: ev => updateDraft({ maxInputBytes: ev.target.value }),
                    }),
                  ),
                  h(
                    'div',
                    { className: 'dsh-nss-cfg-field' },
                    h('label', { htmlFor: `${idPrefix}-output-tokens` }, translate('cfg.maxOutputTokens')),
                    h('input', {
                      id: `${idPrefix}-output-tokens`,
                      type: 'number',
                      min: 1,
                      step: 256,
                      className: 'dsh-nss-cfg-control',
                      'data-nss-cfg-output-tokens': '',
                      disabled: controlsDisabled,
                      value: draft.maxOutputTokens,
                      onChange: ev => updateDraft({ maxOutputTokens: ev.target.value }),
                    }),
                  ),
                )
              : null,
            h(
              'div',
              { className: 'dsh-nss-cfg-actions' },
              validationMessage !== null
                ? h('p', { className: 'dsh-nss-cfg-error', role: 'alert' }, validationMessage)
                : feedback !== null
                  ? h(
                      'p',
                      {
                        className: feedback.kind === 'error' ? 'dsh-nss-cfg-error' : 'dsh-nss-cfg-status',
                        role: feedback.kind === 'error' ? 'alert' : 'status',
                      },
                      feedback.text,
                    )
                  : h('span', null),
              h(
                'div',
                { className: 'dsh-nss-cfg-buttons' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-nss-cfg-btn',
                    'data-nss-cfg-reset': '',
                    disabled: controlsDisabled || isAtDefaults,
                    onClick: onResetDefaults,
                  },
                  translate('cfg.reset'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsh-nss-cfg-btn dsh-nss-cfg-btn-primary',
                    'data-nss-cfg-save': '',
                    disabled: controlsDisabled || !formValid || !isDirty,
                    onClick: onSave,
                  },
                  saving ? translate('cfg.saving') : translate('cfg.save'),
                ),
              ),
            ),
          ),
        )
      }

      ctx.effect(
        () => ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.bundle.config',
              key: PLUGIN_ID,
              locale: LOCALE_NS,
            },
            BundleConfigCard,
          ),
        ),
        'next-step-suggestion: bundle config registration',
      )

      ctx.effect(
        () => ctx.slots.inject('conversation.input.overlay', () =>
          ctx.slots.register(
            {
              name: 'conversation.input.overlay',
              id: 'next-step-suggestion',
              order: 20,
              locale: LOCALE_NS,
            },
            NextStepOverlay,
          ),
        ),
        'next-step-suggestion: slot registration',
      )
    },
  }
}
