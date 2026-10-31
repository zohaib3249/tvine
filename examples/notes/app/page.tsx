import { connection } from 'next/server'
import { Page } from '@tvine/weft'
import { Card } from '@tvine/weft/widgets'
import { api, must } from '@tvine/weft/api'
import { AddNote, ClearAll, NoteButtons } from '../components/notes.tsx'

type NoteRow = { id: number; title: string; body: string; pinned: boolean; words: number }

// A server component: data comes from api.notes.list (the ListView), never from the model.
export default async function Notes() {
  await connection()
  const notes = must(await api.notes.list({})).items as NoteRow[]   // list rows are untyped: say their shape
  return (
    <Page name="notes" title="Notes">
      <h1>Notes</h1>
      <AddNote />
      <ul>
        {notes.map((n) => (
          <li key={n.id}>
            <Card entity={`note:${n.id}`} label={n.title} data={{ title: n.title, pinned: n.pinned, words: n.words }}>
              <strong>{n.pinned ? '[pinned] ' : ''}{n.title}</strong> <small>{n.words} words</small>
              <p>{n.body}</p>
              <NoteButtons id={n.id} />
            </Card>
          </li>
        ))}
      </ul>
      <ClearAll />
    </Page>
  )
}
