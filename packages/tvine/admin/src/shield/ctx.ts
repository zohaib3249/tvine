'use client'
import { createContext, useContext } from 'react'
import { toast } from '../../../weft/dist/widgets/index.js'
import type { ApiResult } from '../../../weft/dist/api/client.js'
import type { Call } from '../data.js'
import type { User } from '../types.js'
import type { ShieldSettings } from './types.js'

export type Query = Record<string, string>
export type ShieldCtx = {
  call: Call; base: string; user: User; query: Query
  navigate(to: string): void
  setQuery(q: Query): void                 // replaceState, no remount: filters keep the page and its scroll
  settings?: ShieldSettings; setSettings(s: ShieldSettings): void
}
export const Ctx = createContext<ShieldCtx | null>(null)
export const useShield = () => useContext(Ctx)!

// one write: toast on success / failure, returns the data (undefined on failure)
export async function write<T>(call: Call, id: string, params: unknown, ok?: string): Promise<T | undefined> {
  const r: ApiResult<any> = await call(id, params)
  if (!r.ok) { toast({ kind: 'error', title: 'Not saved', description: r.message }); return undefined }
  if (ok) toast({ kind: 'success', title: ok })
  return (r.data ?? true) as T
}
