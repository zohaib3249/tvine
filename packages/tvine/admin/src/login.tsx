'use client'
import { useState, type ReactNode } from 'react'
import type { Call } from './data.js'
import type { User } from './types.js'
import { ErrorBox, PlainForm, Region } from './ui.js'

// shared by /admin and the /shield panel (title + mark + id + a note under the title)
export function Login({ error, user, call, onDone, title = 'Administration', mark = 'A', id = 'admin:login', note }: {
  error?: { code: string; message: string; reason?: string }; user: User | null; call: Call; onDone(): void
  title?: string; mark?: ReactNode; id?: string; note?: ReactNode
}) {
  const [u, setU] = useState(''), [pw, setPw] = useState(''), [err, setErr] = useState<string>()
  const [busy, setBusy] = useState(false)
  const signedInNotStaff = user && !user.isStaff
  return (
    <div className="grid h-full place-items-center overflow-auto p-4">
      <Region id={id} label={`${title} sign in`} className="tva-card w-full max-w-sm p-6 sm:p-8">
        <div className="mb-6 flex items-center gap-2.5"><span className="grid size-9 place-items-center rounded-lg bg-brand font-bold text-brand-fg">{mark}</span><h1 className="text-lg font-semibold">{title}</h1></div>
        {note && <div className="mb-4 text-sm text-muted">{note}</div>}
        {signedInNotStaff && id === 'admin:login' && <p role="alert" className="mb-4 rounded-md bg-warn/10 p-3 text-sm text-warn">You are signed in as {user.username}, but you are not authorized to access the admin. Sign in with a staff account.</p>}
        {error && !signedInNotStaff && error.code !== 'expired_sid' && user && <div className="mb-4"><ErrorBox error={error} /></div>}
        {err && <p role="alert" className="mb-4 rounded-md bg-danger/10 p-3 text-sm text-danger">{err}</p>}
        <PlainForm className="flex flex-col gap-4" onSubmit={async (e) => {
          e.preventDefault(); setBusy(true)
          const r = await call('auth.login', { username: u, password: pw })
          setBusy(false)
          if (r.ok) onDone(); else setErr(r.message || 'Please enter the correct username and password for a staff account.')
        }}>
          <label className="flex flex-col gap-1.5 text-[13px] font-medium">Username<input agentId="username" autoComplete="username" required value={u} onChange={(e) => setU(e.target.value)} className="tva-input" /></label>
          <label className="flex flex-col gap-1.5 text-[13px] font-medium">Password<input agentId="password" type="password" autoComplete="current-password" required value={pw} onChange={(e) => setPw(e.target.value)} className="tva-input" /></label>
          <button type="submit" agentId="login" disabled={busy} className="tva-btn tva-btn-primary mt-1 h-10">{busy ? 'Signing in…' : 'Log in'}</button>
        </PlainForm>
      </Region>
    </div>
  )
}

