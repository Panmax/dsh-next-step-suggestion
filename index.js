/**
 * Host entry for `dsh-next-step-suggestion`.
 */

import {
  CONFIG_ROUTE_PATH,
  createConfigRouteHandler,
  createSuggestionCoordinator,
  createSuggestRouteHandler,
  HostConfigSchema,
  SUGGEST_ROUTE_PATH,
} from './src/host.js'

export const name = 'next-step-suggestion'
export const inject = ['webServer', 'connection', 'agents', 'llm']
export const Config = HostConfigSchema

/**
 * Mount background next-step suggestion routes and lifecycle listeners.
 * @param {any} ctx - Host Cordis context.
 * @param {Record<string, unknown> | undefined} config - Optional plugin configuration.
 */
export function apply(ctx, config) {
  const coordinator = createSuggestionCoordinator(ctx, config)
  const routeHandler = createSuggestRouteHandler(ctx, coordinator)
  const configRouteHandler = createConfigRouteHandler(ctx, coordinator)

  ctx.effect(() => () => {
    coordinator.dispose()
  }, 'next-step-suggestion: coordinator lifecycle')

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || session?.header?.origin === 'subagent') return
    if (event?.type === 'turn/start') {
      coordinator.abortSessionInflight(sessionId)
      return
    }
    if (event?.type === 'turn/end') {
      if (event.data?.reason?.kind === 'completed' && typeof event.data.turn === 'number') {
        coordinator.markLiveTurnCompleted(sessionId, event.data.turn)
      } else {
        coordinator.clearLiveTurnCompleted(sessionId)
      }
    }
  })

  ctx.on('agent/status', (payload) => {
    if (payload?.status === 'running' && typeof payload?.agent?.id === 'string') {
      coordinator.abortSessionInflight(payload.agent.id)
      // Also abort any in-flight suggestion on ancestor sessions when a subagent starts running.
      const visited = new Set([payload.agent.id])
      let header = payload.agent.session?.header
      while (header?.origin === 'subagent' && typeof header.parentSession === 'string' && !visited.has(header.parentSession)) {
        const parentId = header.parentSession
        visited.add(parentId)
        coordinator.abortSessionInflight(parentId)
        header = ctx.agents?.get?.(parentId)?.session?.header
      }
    }
  })

  ctx.on('session/disposed', (session) => {
    if (typeof session?.id === 'string') {
      coordinator.purgeSession(session.id)
    }
  })

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: SUGGEST_ROUTE_PATH,
      handler: routeHandler,
    }),
    `next-step-suggestion: POST ${SUGGEST_ROUTE_PATH}`,
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: CONFIG_ROUTE_PATH,
      handler: configRouteHandler,
    }),
    `next-step-suggestion: GET/POST ${CONFIG_ROUTE_PATH}`,
  )
}
