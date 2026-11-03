from django.urls import path
from benchapp import views
urlpatterns = [
    path('api/ping', views.ping),
    path('api/items/<int:item_id>', views.get_item),
    path('api/items', views.items),
    path('api/cached/<int:item_id>', views.cached),
]
