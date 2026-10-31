// core/confirm — rules.confirm (BACKLOG #2), app opt-in only. Dispatch calls confirmGate() after validation and before
// the handler. No `$confirm` param: answer confirm_required + a signed, single-use token bound to sid + action +
// params hash + ~2 min expiry (nothing runs). With a valid token: the handler runs. by 'human': only a request that is
// not agent-marked (dispatch's asAgent, the same marking humanOnly uses) may confirm.
import { randomBytes } from 'node:crypto'
import { ev } from './events.js'
import { redactSecrets } from './redact.js'
import { hashParams } from '../security/idempotency.js'
import { signBind, verifyBind } from '../security/sign.js'
import type { ServerCtx } from './dispatch.js'
import type { ActionCtx, ActionDef, Event } from './types.js'

export const CONFIRM_TTL_MS = 120_000
const SUMMARY_MAX = 200   // chars per summarized value

// a short, redaction-safe view of the params for the confirm dialog / agent
function summary(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(redactSecrets(params) as Record<string, unknown>).map(([k, v]) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)
    return [k, s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX)}…` : v]
  }))
}

const refused = (why: string) => ev.err('domain', `confirmation refused (${why}); call again without $confirm for a new token`, { reason: 'confirm_invalid' })

export async function confirmGate(def: ActionDef, input: Record<string, unknown>, token: unknown, params: unknown, ctx: ActionCtx, server: ServerCtx): Promise<Event | undefined> {
  const rule = def.rules?.confirm
  if (!rule) return undefined
  const by = rule === true ? 'anyone' : rule.by ?? 'anyone'
  const agent = ctx.request.agent.is
  const h = hashParams({ a: def.id, p: input })
  if (token === undefined) {
    const m = rule === true ? undefined : rule.message
    const message = (typeof m === 'function' ? m(params, ctx) : m) ?? `Confirm ${def.id}?`
    const human = by === 'human' && agent
    const t = human ? undefined : signBind({ $confirm: def.id, s: ctx.sid, h, n: randomBytes(9).toString('base64url') }, ctx.settings, CONFIRM_TTL_MS)
    const how = human ? 'only the user can confirm this: ask the user to confirm in their browser'
      : `nothing ran yet. To confirm, repeat the same call with the same params plus $confirm = the confirm token (do: in params; ui: on the step); valid ${CONFIRM_TTL_MS / 1000}s, once`
    return ev.err('confirm_required', `${message} — ${how}`, { reason: 'confirm_required', confirm: { ...(t && { token: t }), message, summary: summary(input), expiresIn: CONFIRM_TTL_MS / 1000, by } })
  }
  if (by === 'human' && agent) return ev.err('human_only', 'only the user can confirm this: ask the user to confirm in their browser', { reason: 'human_only' })
  const v = typeof token === 'string' ? verifyBind(token, ctx.settings) : { ok: false as const }
  if (!v.ok || v.payload.$confirm !== def.id || v.payload.s !== ctx.sid || typeof v.payload.n !== 'string') return refused('invalid or expired token')
  if (v.payload.h !== h) return refused('params differ from the confirmed ones')
  // single-use: a shared store claims the nonce (SET NX + TTL, across servers); in memory the sid's commands run one
  // at a time (dispatch serial + session lock), so replay-then-remember is race-free there
  const key = `confirm:${v.payload.n}`, idem = server.idempotency
  if (idem.claim) return (await idem.claim(ctx.sid, key, CONFIRM_TTL_MS)) ? undefined : refused('token already used')
  if ((await idem.replay(ctx.sid, key, h)).hit !== false) return refused('token already used')
  await idem.remember(ctx.sid, key, h, [])
  return undefined
}
