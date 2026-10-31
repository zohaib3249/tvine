// Django ROOT_URLCONF: optional REST paths. Without it every action still answers at /tvine/api/<app>.<name>.
import { include, path } from '@tvine/warp'

export const urlpatterns = [path('api/', include('notes.urls'))]
