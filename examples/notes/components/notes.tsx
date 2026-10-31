'use client'
import { useRouter } from 'next/navigation'
import { HumanOnly } from 'tvine/weft'
import { Button } from 'tvine/widgets'
import { api, type ApiResult } from 'tvine/api'

function useDone() {
  const router = useRouter()
  return (r: ApiResult) => { if (!r.ok) alert(r.message); router.refresh() }
}

// Plain HTML form: Weft makes it agent-controllable without extra code.
export function AddNote() {
  const done = useDone()
  return (
    <form name="add-note" onSubmit={async (e) => {
      e.preventDefault()
      const f = new FormData(e.currentTarget); e.currentTarget.reset()
      done(await api.notes.add({ title: String(f.get('title')), body: String(f.get('body')) }))
    }}>
      <input name="title" placeholder="Title" required />
      <textarea name="body" placeholder="Write something" />
      <button type="submit">Add note</button>
    </form>
  )
}

export function NoteButtons({ id }: { id: number }) {
  const done = useDone()
  return (
    <>
      <Button name="pin" onClick={async () => done(await api.notes.pin({ id }))}>Pin</Button>
      {/* rules.confirm: api.* shows the confirm dialog and resends with the token by itself */}
      <Button name="remove" onClick={async () => done(await api.notes.remove({ id }))}>Delete</Button>
    </>
  )
}

// The wrapper keeps agents off the button; humanOnly on the action is the real guard.
export function ClearAll() {
  const done = useDone()
  return (
    <HumanOnly reason="Deleting every note">
      <Button name="clear-all" onClick={async () => { if (confirm('Delete ALL notes?')) done(await api.notes.clearAll({})) }}>Delete all notes</Button>
    </HumanOnly>
  )
}
