'use client'
import { createContext, startTransition, useActionState, useContext, useEffect, type ComponentType, type FormEvent, type ReactNode } from 'react'
import { submitForm } from './submit.js'
import type { FormResult } from './dispatcher.js'

type Spec = { name: string; type: string }

const Ctx = createContext<{ errors?: Record<string, string>; pending: boolean }>({ pending: false })

// FormData is all strings; coerce to the schema's types so the human Command equals the
// agent Command for the same values (number → Number, boolean → checkbox present).
function toParams(fd: FormData, specs: Spec[]): Record<string, unknown> {
  const out: Record<string, unknown> = Object.fromEntries(fd)
  for (const { name, type } of specs) {
    const v = out[name]
    if (type === 'boolean') out[name] = v != null && v !== 'false'
    else if (type === 'number' && typeof v === 'string') { if (v === '') delete out[name]; else out[name] = Number(v) }
  }
  return out
}

export function FormClient({ action, bind, specs, disabled, className, children }: {
  action: string; bind: string; specs: Spec[]; disabled?: boolean; className?: string; children: ReactNode
}) {
  const [state, run, pending] = useActionState(
    (_: FormResult, fd: FormData) => submitForm({ action, bind: bind || undefined, params: toParams(fd, specs) }),
    { ok: true },
  )
  useEffect(() => { if (state.goto) window.location.assign(state.goto) }, [state])
  // onSubmit + preventDefault: React skips its auto form-reset, so typed values survive an
  // error re-render. `action={run}` keeps the pre-hydration (no-JS) server-action path.
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (disabled) return
    const fd = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter)
    startTransition(() => run(fd))
  }
  return (
    <form action={disabled ? undefined : run} onSubmit={onSubmit} className={className}>
      <Ctx value={{ errors: state.errors, pending }}>{children}</Ctx>
      {!state.ok && state.message && <p data-tvine-message="">{state.message}</p>}
    </form>
  )
}

// `error` must be a component (a client component under RSC): functions can't cross the
// server→client boundary, so a plain render-prop function is not an option here.
export function FieldError({ name, error: E }: { name: string; error?: ComponentType<{ message: string }> }) {
  const message = useContext(Ctx).errors?.[name]
  if (!message) return null
  return E ? <E message={message} /> : <p data-tvine-error="">{message}</p>
}
