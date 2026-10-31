import { z } from 'zod'
import { action, defineAction, DomainError, ListView, type ViewCtx } from '@tvine/warp'
import { Note } from './models.ts'
import { countWords } from './tasks.ts'

const addParams = z.object({ title: z.string().trim().min(1).max(200), body: z.string().max(10_000).default('') })
const idParam = z.object({ id: z.number().int() })

// notes.list (readOnly: ?q= search, ?sort=, cursor pages) + three @action methods: notes.add, notes.pin, notes.remove
export class NoteList extends ListView<Note> {
  model = Note
  ordering = ['id', 'title']
  getQueryset() { return Note.objects.order('-pinned', '-id') }

  @action(addParams)
  async add({ title, body }: z.infer<typeof addParams>, _ctx: ViewCtx) {
    const note = await Note.create({ title, body })
    const job = await countWords.delay({ id: note.id })   // queued after this request commits
    return { note, job }
  }

  @action(idParam)
  async pin({ id }: z.infer<typeof idParam>) {
    const note = await Note.get(id)
    if (!note) throw new DomainError('not_found', `note ${id} not found`, 'id')
    await Note.objects.filter({ id }).update({ pinned: !note.pinned })
    return { id, pinned: !note.pinned }
  }

  // Sensitive: the first call runs nothing and answers confirm_required + a one-time token.
  @action(idParam, { rules: { confirm: { message: 'Delete this note for good?' }, destructive: true } })
  async remove({ id }: z.infer<typeof idParam>) {
    return { deleted: await Note.objects.filter({ id }).delete() }
  }
}

// Very sensitive: only a human may run it. Agents get human_only on every path (MCP, do, HTTP, in-tab).
export const clearAll = defineAction('clearAll', z.object({}), async () => ({ deleted: await Note.objects.delete() }),
  { humanOnly: 'Deleting every note', destructive: true })
