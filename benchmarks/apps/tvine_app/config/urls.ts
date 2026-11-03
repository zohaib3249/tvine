import { include, path } from 'tvine'
export const urlpatterns = [path('api/', include('items.urls'))]
