# Tvine reference

One topic per file, complete on its own: what it is, the import, signatures, every option (name, type, default,
meaning), examples and gotchas. Written from the source code. Read only the file you need, or start with an overview.

New to Tvine? Read the two overviews first: [warp/overview.md](warp/overview.md) (the backend) and
[weft/overview.md](weft/overview.md) (the frontend). The task-based guides (installation, tutorial, deploy) are one
folder up, in [../README.md](../README.md).

## Warp: the backend

| File | What it covers |
|---|---|
| [warp/overview.md](warp/overview.md) | Warp in one page: project layout, request flow, how actions become MCP tools |
| [warp/models.md](warp/models.md) | `defineModel`, model options, relations, the model API |
| [warp/fields.md](warp/fields.md) | Every field type and every field attribute |
| [warp/queryset.md](warp/queryset.md) | Every QuerySet method and lookup, Q / F / expressions, aggregates, paging, transactions |
| [warp/migrations.md](warp/migrations.md) | makemigrations / migrate, the migration file format, operations, fixtures |
| [warp/database.md](warp/database.md) | SQLite / Postgres / MySQL, `settings.db`, `DATABASE_URL` |
| [warp/actions.md](warp/actions.md) | `defineAction`, the handler context, every `rules` key (permissions, rate, humanOnly, confirm…) |
| [warp/views.md](warp/views.md) | Class views, ViewSets, `@action`, routers, all their options |
| [warp/serializers.md](warp/serializers.md) | Serializers and how they shape output |
| [warp/urls.md](warp/urls.md) | `urls.ts`, `path`, `include`, namespaces, `reverse` |
| [warp/middleware.md](warp/middleware.md) | Every built-in HTTP middleware and its options; writing your own; action middleware |
| [warp/request.md](warp/request.md) | The request object, sessions, how agents are detected, uploads |
| [warp/errors.md](warp/errors.md) | `DomainError` codes, redirects, how errors map to HTTP and MCP |
| [warp/settings.md](warp/settings.md) | Every settings key: type, default, meaning; environment variables; base / dev / prod / local |

### Built-in apps

| File | What it covers |
|---|---|
| [warp/contrib/auth.md](warp/contrib/auth.md) | Users, custom user model, backends, login, 2FA, API tokens, permissions and groups |
| [warp/contrib/admin.md](warp/contrib/admin.md) | Registering models, every ModelAdmin option, inlines, custom pages and widgets |
| [warp/contrib/tasks.md](warp/contrib/tasks.md) | `defineTask`, schedules, workers, brokers |
| [warp/contrib/cache.md](warp/contrib/cache.md) | Cache backends and API |
| [warp/contrib/email.md](warp/contrib/email.md) | Sending email, backends |
| [warp/contrib/media.md](warp/contrib/media.md) | File and image uploads, storage, access control |
| [warp/contrib/audit.md](warp/contrib/audit.md) | The audit log and security events |
| [warp/contrib/security.md](warp/contrib/security.md) | Signing, encryption, rate limits, humanOnly / confirm; bot protection is in [../shield.md](../shield.md) |

## Weft: the frontend

| File | What it covers |
|---|---|
| [weft/overview.md](weft/overview.md) | Weft in one page: export paths, setup, what agents see, the frontend boundary |
| [weft/widgets.md](weft/widgets.md) | Every widget: props, state, the agent controls it exposes, an example |
| [weft/forms.md](weft/forms.md) | The ways to build a form, field kinds, validation, uploads, HumanOnly, confirm |
| [weft/api-client.md](weft/api-client.md) | The typed `api.*` client, errors, users, agent marking |
| [weft/pages-and-regions.md](weft/pages-and-regions.md) | `Page`, `Region`, making custom components agent-readable, views and `expand`, live updates |
| [weft/agents-in-the-browser.md](weft/agents-in-the-browser.md) | Tab control (Allow / Stop), WebMCP, presence, testing with the inspector |
