// Shared ErrCode → HTTP status for /tvine/api and agent HTTP.
import type { ErrCode } from '../core/types.js'

const STATUS: Partial<Record<ErrCode, number>> = {
  expired_sid: 401, rate_limited: 429, internal: 500, human_only: 403, unknown_action: 404,
}
const DOMAIN_STATUS: Record<string, number> = { forbidden: 403, not_found: 404 }

export function httpStatusOf(code: ErrCode, reason?: string): number {
  if (code === 'domain') return DOMAIN_STATUS[reason ?? ''] ?? 400
  return STATUS[code] ?? 400
}
