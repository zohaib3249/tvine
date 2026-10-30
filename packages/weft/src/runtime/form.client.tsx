'use client'
import { createContext, startTransition, useActionState, useContext, useEffect, type ComponentType, type FormEvent, type ReactNode } from 'react'
import { submitForm } from './submit.js'
import type { FormResult } from './dispatcher.js'

export type Spec = { name: string; type: string; required: boolean; array: boolean }

const Ctx = createContext<{ errors?: Record<string, string>; pending: boolean }>({ pending: false })

// FormData is all strings; coerce to the schema's types so the human Command equals the
// agent Command for the same values (number → Number, boolean → checkbox present).
// Empty optional fields are omitted ('' would fail e.g. z.string().email().optional()).
function toParams(fd: FormData, specs: Spec[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const byName = new Map(specs.map((s) => [s.name, s]))
  for (const name of new Set(fd.keys())) {
    const all = fd.getAll(name)
    if (byName.get(name)?.array) { out[name] = all; continue }
    if (all.length > 1 && process.env.NODE_ENV !== 'production') {
      console.warn(`tvine: form field "${name}" submitted more than once; last value wins (make the schema param an array to keep all)`)
    }
    out[name] = all[all.length - 1]
  }
  for (const { name, type, required } of specs) {
    const v = out[name]
    if (type === 'boolean') out[name] = v != null && v !== 'false'
    else if (v === '' && !required) delete out[name]
    else if (type === 'number' && typeof v === 'string' && v !== '') out[name] = Number(v)
  }
  return out
}

export function FormClient({ action, bind, specs, disabled, id, className, children }: {
  action: string; bind: string; specs: Spec[]; disabled?: boolean; id?: string; className?: string; children: ReactNode
}) {
  const [state, run, pending] = useActionState(
    (_: FormResult, fd: FormData) => submitForm({ action, bind: bind || undefined, params: toParams(fd, specs) }),
    { ok: true },
  )
  useEffect(() => { if (state.goto) window.location.assign(state.goto) }, [state])
  // onSubmit + preventDefault: React skips its auto form-reset, so typed values survive an
  // error re-render. `action={run}` lets Next serialize the server action for pre-hydration
  // submits; plain react-dom SSR (no Next) renders a `javascript:throw` placeholder instead.
  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (disabled) return
    const fd = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter)
    startTransition(() => run(fd))
  }
  return (
    <form action={disabled ? undefined : run} onSubmit={onSubmit} id={id} className={className}>
      {/* Native fieldset disables every control inside, including ones in components the scope walk can't see. */}
      <Ctx value={{ errors: state.errors, pending }}>{disabled ? <fieldset disabled>{children}</fieldset> : children}</Ctx>
      {!state.ok && state.message && <p data-tvine-message="">{state.message}</p>}
    </form>
  )
}

// Renders null outside a Form (default context has no errors).
// `error` must be a component (a client component under RSC): functions can't cross the
// server→client boundary, so a plain render-prop function is not an option here.
export function FieldError({ name, error: E }: { name: string; error?: ComponentType<{ message: string }> }) {
  const message = useContext(Ctx).errors?.[name]
  if (!message) return null
  return E ? <E message={message} /> : <p data-tvine-error="">{message}</p>
}
