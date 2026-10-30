'use client'
// WebMCP adapter: registers read_page + do with the browser's model-context API.
// The httpOnly session cookie is the agent's session: never read or sent from JS.

type McTool = {
  name: string
  description: string
  inputSchema: object
  execute: (args: any) => Promise<{ content: { type: 'text'; text: string }[] }>
}
type ModelContext = {
  registerTool?: (t: McTool, o?: { signal: AbortSignal }) => unknown
  unregisterTool?: (name: string) => unknown
  provideContext?: (c: { tools: McTool[] }) => unknown
}

let warned = false

// The ONE place that knows the (churning) WebMCP API shape. Returns an unregister fn.
function provideTools(tools: McTool[]): () => void {
  const g = globalThis as any
  const mc: ModelContext | undefined = g.document?.modelContext ?? g.navigator?.modelContext
  if (!mc) {
    if (!warned && process.env.NODE_ENV !== 'production') {
      warned = true
      console.info('[tvine] WebMCP (modelContext) not available; adapter is a no-op')
    }
    return () => {}
  }
  const ac = new AbortController()
  if (mc.registerTool) {
    // Current API: removal is by aborting the signal given at registration.
    for (const t of tools) {
      try {
        Promise.resolve(mc.registerTool(t, { signal: ac.signal })).catch(devWarn)
      } catch (e) { devWarn(e) }
    }
    // Fallback for older builds that ignore the signal but have unregisterTool.
    ac.signal.addEventListener('abort', () => tools.forEach((t) => { try { mc.unregisterTool?.(t.name) } catch {} }))
    return () => ac.abort() // idempotent
  }
  // Oldest shape. NOTE: this fallback's unregister clears ALL page tools, not just ours.
  mc.provideContext?.({ tools })
  return () => { mc.provideContext?.({ tools: [] }) }
}

function devWarn(e: unknown) {
  if (!warned && process.env.NODE_ENV !== 'production') {
    warned = true
    console.info('[tvine] WebMCP registration failed', e)
  }
}

// randomUUID is undefined on non-secure contexts (plain http).
export function newId(): string {
  const c = (globalThis as any).crypto
  if (c?.randomUUID) return c.randomUUID()
  const b: Uint8Array = c.getRandomValues(new Uint8Array(16))
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
}

export function registerWebMcp(opts: { header?: string } = {}): () => void {
  const header = opts.header ?? 'x-tvine'
  const url = () => { const l = (globalThis as any).location; return l.pathname + l.search }
  const send = async (init: RequestInit & { headers: Record<string, string> }) => {
    let text: string
    try {
      const res = await fetch(url(), { ...init, headers: { [header]: '1', ...init.headers }, credentials: 'same-origin' })
      text = await res.text()
    } catch (e) {
      // Thrown messages never reach the agent; return the error as a value.
      text = `err internal "network error: ${(e instanceof Error ? e.message : String(e)).replace(/"/g, "'")}"`
    }
    return { content: [{ type: 'text' as const, text }] }
  }
  return provideTools([
    {
      name: 'read_page',
      description:
        'Read the current page as a structured agent snapshot (JSON). Call this first, before do, and again after actions to see the new state. Responses carry structured ok/err lines.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => send({ headers: { accept: 'application/tvine+json' } }),
    },
    {
      name: 'do',
      description:
        'Run an action on the current page. Call read_page first to see available actions and their params. Retries with the same cmdId are safe. Responses carry structured ok/err lines.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          params: { type: 'object' },
          cmdId: { type: 'string', description: 'optional idempotency key' },
        },
        required: ['action'],
      },
      execute: ({ action, params, cmdId }: { action: string; params?: object; cmdId?: string }) =>
        send({
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/tvine+json' },
          body: JSON.stringify({ action, params, cmdId: cmdId ?? newId() }),
        }),
    },
  ])
}
