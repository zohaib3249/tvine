'use client'
import { useEffect, useState } from 'react'
import { Dialog } from '../widgets/dialog.js'
import { HumanOnly } from '../widget/humanOnly.js'
import { setConfirmHandler, type ConfirmAsk } from '../api/core.js'

// rules.confirm in the browser (BACKLOG #2): <WeftRoot> mounts this; api.* and <Form> ask it (askConfirm) and it
// answers with the Dialog widget: the server's message, the params summary, Cancel / Confirm.
export function ConfirmHost() {
  const [ask, setAsk] = useState<{ a: ConfirmAsk; done(ok: boolean): void } | undefined>()
  useEffect(() => {
    setConfirmHandler((a) => new Promise<boolean>((done) => setAsk({ a, done })))
    return () => setConfirmHandler(undefined)
  }, [])
  const answer = (ok: boolean) => { ask?.done(ok); setAsk(undefined) }
  if (!ask) return null
  return (
    <Dialog name="tvine-confirm" label={ask.a.message} open onOpenChange={(o) => { if (!o) answer(false) }} slots={{ trigger: { style: { display: 'none' } } }}>
      <p data-part="message">{ask.a.message}</p>
      {Object.keys(ask.a.summary).length > 0 && (
        <dl data-part="summary">{Object.entries(ask.a.summary).map(([k, v]) => [<dt key={`k${k}`}>{k}</dt>, <dd key={`v${k}`}>{typeof v === 'string' ? v : JSON.stringify(v)}</dd>])}</dl>
      )}
      {/* only a human's own click confirms: scripts / WebMCP / in-tab agents are stopped (by 'human' or not) */}
      <HumanOnly reason="Confirm this action">
        <button type="button" data-part="cancel" onClick={() => answer(false)}>Cancel</button>
        <button type="button" data-part="confirm" autoFocus onClick={() => answer(true)}>Confirm</button>
      </HumanOnly>
    </Dialog>
  )
}
