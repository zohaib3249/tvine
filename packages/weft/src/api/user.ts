'use client'
// The signed-in user for client components: a server component reads it with currentUser() and passes it down
// (<UserProvider user={await currentUser()}>); useUser() reads it. Data only (CurrentUser), never a session id.
import { createContext, createElement, useContext, type ReactNode } from 'react'
import type { CurrentUser } from './core.js'

const Ctx = createContext<CurrentUser | null>(null)
export function UserProvider({ user, children }: { user: CurrentUser | null; children?: ReactNode }) {
  return createElement(Ctx.Provider, { value: user }, children)
}
export const useUser = (): CurrentUser | null => useContext(Ctx)
