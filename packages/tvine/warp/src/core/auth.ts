// request.user plumbing (docs/design/contrib/auth.md §4–5). Core knows no User model: an installed auth app
// (tvine.auth's hooks.ts ready()) registers a backend per server Settings. Resolution order:
// settings.auth.user (BYO override) → backend.fromRequest (bearer token) → backend.fromSession.
import { ANONYMOUS, type ActionCtx, type Request, type Session, type Settings, type Sid, type TvineUser } from './types.js'

export interface AuthBackend {
  fromRequest(request: Request): Promise<TvineUser | null>            // credentials on the request itself (Authorization)
  fromSession(request: Request, session: Session): Promise<TvineUser | null>
}

const backends = new WeakMap<Settings, AuthBackend>()
export function setAuthBackend(settings: Settings, backend: AuthBackend | undefined): void {
  if (backend) backends.set(settings, backend); else backends.delete(settings)
}
export const authBackend = (settings: Settings): AuthBackend | undefined => backends.get(settings)

// per request: 'fixed' = decided by the BYO resolver or a token (no session can change it); else the sid it was resolved for
const state = new WeakMap<Request, 'fixed' | Sid>()

// buildRequest: BYO resolver, then request-borne credentials. A token user is an agent (programs hold tokens).
export async function userOfRequest(request: Request, settings: Settings): Promise<void> {
  const own = await settings.auth?.user?.(request)
  if (own) { request.user = own; state.set(request, 'fixed'); return }
  const u = await backends.get(settings)?.fromRequest(request)
  if (u) {
    request.user = u
    request.agent = { ...request.agent, is: true }
    state.set(request, 'fixed')
  }
}

// Where the request's session becomes known (dispatch, route guards, currentRequest()): the session's user.
// Idempotent per (request, sid); a fixed user is never replaced.
export async function authenticate(settings: Settings, request: Request, session: Session | undefined): Promise<void> {
  const b = backends.get(settings)
  if (!b || !session) return
  const s = state.get(request)
  if (s === 'fixed' || s === session.sid) return
  state.set(request, session.sid)
  request.user = (await b.fromSession(request, session)) ?? ANONYMOUS
}

// ---- session rotation (fixation) ------------------------------------------------------------------
// cycleSession(ctx): after this action commits, dispatch gives the session a new sid (SessionStore.rotate);
// the old sid and its cookies stop resolving. Rolled back → nothing happens.
const cycling = new WeakSet<Session>()
export function cycleSession(ctx: Pick<ActionCtx, 'session'>): void { cycling.add(ctx.session) }
export const wantsCycle = (staged: Session): boolean => cycling.has(staged)

// the session a request's command rotated to (transports hand out its new sid / cookie)
const rotations = new WeakMap<Request, Session>()
const aliases = new WeakMap<Request, Request>()   // dispatch's agent-marked copy → the request the transport holds
export function aliasRequest(copy: Request, original: Request): void { aliases.set(copy, original) }
export function markRotated(request: Request, session: Session): void {
  for (let r: Request | undefined = request; r; r = aliases.get(r)) rotations.set(r, session)
}
export const rotatedSession = (request: Request): Session | undefined => rotations.get(request)
