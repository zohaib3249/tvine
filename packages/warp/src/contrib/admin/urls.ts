// include('tvine.admin.urls'): the admin API as REST routes (Django URLs #38) — every route runs the same
// action through dispatch as /tvine/api/admin.*. Custom getUrls() views come first, under <app>/<model>/.
import { path } from '../../urls.js'
import { site } from './sites.js'
import * as v from './views.js'

export const appName = 'admin'
export const urlpatterns = [
  ...site.customUrls(),
  path('api/site/', v.siteAction, { name: 'site' }),
  path('api/recent/', v.recent, { name: 'recent' }),
  path('api/search/', v.search, { name: 'search' }),
  path('api/prefs/', v.prefs, { name: 'prefs', methods: ['POST'] }),
  path('api/<str:model>/meta/', v.meta, { name: 'meta' }),
  path('api/<str:model>/autocomplete/', v.autocomplete, { name: 'autocomplete' }),
  path('api/<str:model>/', v.list, { name: 'changelist' }),
  path('api/<str:model>/', v.create, { name: 'changelist', methods: ['POST'] }),
  path('api/<str:model>/delete/', v.remove, { name: 'delete', methods: ['POST'] }),
  path('api/<str:model>/delete/preview/', v.deletePreview, { name: 'delete-preview', methods: ['POST'] }),
  path('api/<str:model>/action/', v.action, { name: 'action', methods: ['POST'] }),
  path('api/<str:model>/list-edit/', v.listEdit, { name: 'list-edit', methods: ['POST'] }),
  path('api/<str:model>/<str:pk>/', v.get, { name: 'change' }),
  path('api/<str:model>/<str:pk>/', v.update, { name: 'change', methods: ['POST'] }),
  path('api/<str:model>/<str:pk>/history/', v.history, { name: 'history' }),
]
