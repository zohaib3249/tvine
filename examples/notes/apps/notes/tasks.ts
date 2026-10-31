import { z } from 'zod'
import { defineTask } from 'tvine/tasks'
import { Note } from './models.ts'

// Runs in `tvine worker` (or the web server's embedded worker), never in the request.
export const countWords = defineTask('countWords', async ({ id }) => {
  const note = await Note.get(id)
  if (!note) return { words: 0 }
  const words = note.body.split(/\s+/).filter(Boolean).length
  await Note.objects.filter({ id }).update({ words })
  return { words }
}, { args: z.object({ id: z.number().int() }) })
