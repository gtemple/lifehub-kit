from django.contrib import admin
from django.contrib.auth import views as auth
from django.urls import path, re_path
from django.views.generic import RedirectView

from hub import views

urlpatterns = [
    path('', views.app, name='home'),
    re_path(r'^(?:inbox|cleanup|settings|layout|states|server|resources|more|approvals/\d+)/?$', views.app),
    path('classic/', views.home),
    path('api/tiles/<slug:name>/', views.tile),
    path('api/items/', views.api_items),
    path('api/ask/', views.ask),
    path('api/brief/', views.brief_write),
    path('api/inbox/', views.inbox_page),
    path('api/cleanup/', views.cleanup_view),
    path('api/cleanup/scan/', views.cleanup_scan),
    path('api/cleanup/apply/', views.cleanup_apply),
    path('api/emails/<int:pk>/<slug:action>/', views.email_action),
    path('api/settings/', views.settings_view),
    path('api/connections/', views.connections_view),
    path('api/tasks/', views.task_save),
    path('api/tasks/<int:pk>/', views.task_save),
    path('api/waiting/<int:pk>/', views.waiting_dismiss),
    path('api/search/', views.search),
    path('api/server/', views.server_state),
    path('api/server/act/', views.server_act),
    path('api/server/logs/', views.server_logs),
    path('api/prices/', views.watch_save),
    path('api/prices/find/', views.watch_find),
    path('api/prices/<int:pk>/', views.watch_save),
    path('api/learn/', views.learn_page),
    path('api/learn/write/', views.learn_write),
    path('api/learn/<int:pk>/<slug:action>/', views.learn_action),
    path('api/notes/', views.note_save),
    path('api/notes/<int:pk>/', views.note_save),
    path('api/approvals/<int:pk>/', views.approval_detail),
    path('api/approvals/<int:pk>/decide/', views.decide),
    path('api/approvals/<int:pk>/save/', views.save_draft),
    path('api/approvals/<int:pk>/rewrite/', views.rewrite),
    path('api/approvals/<int:pk>/undo/', views.undo),
    path('login/', auth.LoginView.as_view(), name='login'),
    path('logout/', auth.LogoutView.as_view(), name='logout'),
    path('admin/', admin.site.urls),
    path('favicon.ico', RedirectView.as_view(url='/static/sun.ico')),
]
