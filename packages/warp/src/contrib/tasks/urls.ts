// include('tvine.tasks.urls'): a job's status and revoke (docs/design/conventions/urls.md).
import { path } from '../../urls.js'
import { revoke, status } from './views.js'

export const appName = 'tasks'
export const urlpatterns = [
  path('jobs/<uuid:jobId>/', status, { name: 'job-detail' }),
  path('jobs/<uuid:jobId>/revoke/', revoke, { name: 'job-revoke' }),
]
