/**
 * Browser client entry logic for `dsh-next-step-suggestion`.
 * Bundled with `src/client-core.js` into root `client.js` for `window.__ModuleLoader__`.
 */

import {
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
        const translate = typeof t === 'function' ? t : ((key, vars) => {
          const template = LOCALES.en[key] ?? key
          return vars?.text ? template.replace('{text}', vars.text) : template
        })
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
