/**
 * Host entry for `dsh-next-step-suggestion`.
 */

import {
  createSuggestionCoordinator,
  createSuggestRouteHandler,
  SUGGEST_ROUTE_PATH,
} from './src/host.js'

export const name = 'next-step-suggestion'
export const inject = ['webServer', 'connection', 'agents', 'llm']

/**
 * Mount background next-step suggestion route and lifecycle listeners.
 * @param {any} ctx - Host Cordis context.
 * @param {Record<string, unknown> | undefined} config - Optional plugin configuration.
 */
export function apply(ctx, config) {
  const coordinator = createSuggestionCoordinator(ctx, config)
  const routeHandler = createSuggestRouteHandler(ctx, coordinator)

  ctx.effect(() => () => {
    coordinator.dispose()
  }, 'next-step-suggestion: coordinator lifecycle')

  ctx.on('agent/status', (payload) => {
    if (payload?.status === 'running' && typeof payload?.agent?.id === 'string') {
      coordinator.abortSessionInflight(payload.agent.id)
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
}
