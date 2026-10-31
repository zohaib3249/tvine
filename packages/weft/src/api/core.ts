// @tvine/weft/api — the frontend's only data path (docs/design/frontend/v2/core/api-client.md).
// api.<app>.<name>(params) ↔ manifest action id `<app>.<name>`; never throws, returns an ApiResult.

export type ErrCode =
  | 'invalid_param' | 'unknown_action' | 'stale_bind' | 'stale_rev'
  | 'expired_sid' | 'rate_limited' | 'conflict' | 'domain' | 'internal' | 'human_only'

export type ApiResult<T = unknown> =
  | { ok: true; data: T; goto?: string }
  | { ok: false; code: ErrCode; reason?: string; field?: string; message: string; retryAfterMs?: number }

export interface ApiOpts { cmdId?: string; bind?: string; signal?: AbortSignal }
export interface ApiCall<P = Record<string, unknown>, R = unknown> {
  (params?: P, opts?: ApiOpts): Promise<ApiResult<R>>
  readonly id: string
}

// Filled by the generated tvine-api.d.ts (declare module '@tvine/weft/api' { interface ApiManifest {…} }).
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface ApiManifest {}
export type Api = keyof ApiManifest extends never ? Record<string, Record<string, ApiCall>> : ApiManifest

export type Transport = (id: string, params: unknown, opts: ApiOpts | undefined) => Promise<ApiResult>

export class ApiError extends Error {
  code: ErrCode; reason?: string; field?: string
  constructor(r: Extract<ApiResult, { ok: false }>) {
    super(r.message)
    this.name = 'ApiError'
    this.code = r.code; this.reason = r.reason; this.field = r.field
  }
}

// The data, or throw. { notFound: true }: reason not_found → Next's notFound() (a real 404).
export function must<T>(r: ApiResult<T>, o?: { notFound?: boolean }): T {
  if (r.ok) return r.data
  if (o?.notFound && r.reason === 'not_found') {
    // what next/navigation notFound() throws (Next 15+); weft does not depend on next
    throw Object.assign(new Error('NEXT_HTTP_ERROR_FALLBACK;404'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' })
  }
  throw new ApiError(r)
}

// Proxy: no runtime codegen. `then`/symbols/`$$…` are not app names (await, React probes).
const skip = (k: string | symbol): k is symbol => typeof k === 'symbol' || k === 'then' || k.startsWith('$$')
export function makeApi(t: Transport): Api {
  const apps = new Map<string, unknown>()
  return new Proxy({}, {
    get: (_, app) => {
      if (skip(app)) return undefined
      let a = apps.get(app)
      if (!a) {
        const calls = new Map<string, ApiCall>()
        apps.set(app, (a = new Proxy({}, {
          get: (__, name) => {
            if (skip(name)) return undefined
            const id = `${app}.${name}`
            let c = calls.get(id)
            if (!c) calls.set(id, (c = Object.assign((params?: unknown, opts?: ApiOpts) => t(id, params ?? {}, opts), { id }) as ApiCall))
            return c
          },
        })))
      }
      return a
    },
  }) as Api
}

export const network = (e: unknown): ApiResult => ({ ok: false, code: 'internal', reason: 'network', message: e instanceof Error ? e.message : String(e) })

// tvine.auth's safe user (auth.me): never the password hash or a session id.
export interface CurrentUser { id: string; username: string; email: string | null; isStaff: boolean; isSuperuser: boolean }

// currentUser() over a transport: auth.me through the same api path as every other call (never the ORM).
// null when signed out, when tvine.auth is not installed, or on any error.
export const currentUserVia = (t: Transport) => async (): Promise<CurrentUser | null> => {
  const r = await t('auth.me', {}, undefined)
  return r.ok ? (r.data as CurrentUser | null) : null
}
