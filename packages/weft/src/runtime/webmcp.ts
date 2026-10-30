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
  registerTool?: (t: McTool) => unknown
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
  if (mc.registerTool) {
    tools.forEach((t) => mc.registerTool!(t))
    return () => tools.forEach((t) => mc.unregisterTool?.(t.name))
  }
  mc.provideContext?.({ tools })
  return () => { mc.provideContext?.({ tools: [] }) }
}

export function registerWebMcp(opts: { header?: string } = {}): () => void {
  const header = opts.header ?? 'x-tvine'
  const url = () => { const l = (globalThis as any).location; return l.pathname + l.search }
  const send = async (init: RequestInit & { headers: Record<string, string> }) => {
    const res = await fetch(url(), { ...init, headers: { [header]: '1', ...init.headers }, credentials: 'same-origin' })
    return { content: [{ type: 'text' as const, text: await res.text() }] }
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
          body: JSON.stringify({ action, params, cmdId: cmdId ?? crypto.randomUUID() }),
        }),
    },
  ])
}
