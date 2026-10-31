import { defineModel, field, type Infer } from '@tvine/warp'

export const Note = defineModel('note', {
  id: field.id(),
  title: field.text({ searchable: true }),
  body: field.text({ default: '' }),
  pinned: field.bool({ default: false }),
  words: field.int({ default: 0 }),   // filled in by the countWords background task
})
export type Note = Infer<typeof Note>
