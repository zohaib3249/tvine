import os
SECRET_KEY = 'bench-not-secret-' + 'x' * 40
DEBUG = False
ALLOWED_HOSTS = ['127.0.0.1', 'localhost']
ROOT_URLCONF = 'urls'
INSTALLED_APPS = ['benchapp']
MIDDLEWARE = ['django.middleware.security.SecurityMiddleware', 'django.middleware.common.CommonMiddleware']
APPEND_SLASH = False
DATABASES = {'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': os.environ.get('DB', os.path.join(os.path.dirname(__file__), 'app.db')),
                         'OPTIONS': {'init_command': 'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;'}, 'CONN_MAX_AGE': None}}
USE_TZ = True
TIME_ZONE = 'UTC'
DEFAULT_AUTO_FIELD = 'django.db.models.AutoField'
LOGGING = {'version': 1, 'disable_existing_loggers': True, 'root': {'level': 'WARNING'}}
