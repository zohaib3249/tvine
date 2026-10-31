import { path } from 'tvine'
import { NoteList } from './views.ts'

export const appName = 'notes'
export const urlpatterns = [
  path('notes/', NoteList, { name: 'notes' }),                        // GET → notes.list
  path('notes/<int:id>/pin/', NoteList.action('pin'), { name: 'pin' }),
]
