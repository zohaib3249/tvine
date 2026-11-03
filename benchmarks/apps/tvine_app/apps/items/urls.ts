import { path } from 'tvine'
import { ping, page, cached, ItemDetail, ItemCreate } from './views.ts'

export const appName = 'items'
export const urlpatterns = [
  path('ping', ping),
  path('items', page),
  path('items', ItemCreate),
  path('items/<int:id>', ItemDetail),
  path('cached/<int:id>', cached),
]
