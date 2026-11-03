// admin.ts: what /admin shows for notes.
import { admin, ModelAdmin } from 'tvine/contrib/admin'
import { Note } from './models.ts'

class NoteAdmin extends ModelAdmin {
  listDisplay = ['title', 'pinned', 'words']
  listFilter = ['pinned']
  searchFields = ['title']
  str(n: any) { return String(n.title) }
}
admin.site.register(Note, NoteAdmin)
