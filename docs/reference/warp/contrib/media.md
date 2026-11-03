# Media: file and image uploads

## What it is

Tvine's media layer stores uploaded files and serves them back. `defineUpload` makes an upload action that checks
the real file type from its first bytes (not the name or the browser's claim), enforces a size cap, and writes the
file to a `Storage` (by default `DiskStorage` under `settings.media.dir`). The web server serves those files at
`settings.media.route`. Private files are only served with a signed, expiring link (`media.url`), optionally bound to
one user. Models keep only the storage key, in `field.file()` / `field.image()`. Source:
`packages/tvine/warp/src/media/index.ts`.

## Install / enable

Nothing to install. Defaults: files in `./media`, served at `/media`.

```ts
// config/settings.ts
media: { dir: './media', route: '/media', auditAccess: true }
```

## Import

```ts
import { defineUpload, DiskStorage, media, type Storage, type UploadOpts } from 'tvine'
```

## `defineUpload`

```ts
defineUpload(name: string, opts: UploadOpts & { rate?: { limit; windowMs } }): UploadDef   // an ActionDef
```

Export it from `apps/<app>/views.ts` like any action; its id is `<app>.<name>`.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `maxBytes` | `number` | — | required; larger files fail with `too_large` |
| `types` | `string[]` | — | required; allowed sniffed types, from: `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `application/pdf` |
| `uploadTo` | `string` | — | key folder(s), e.g. `'products'` or `'docs/2026'` (letters, digits, `_ -` joined by `/`) |
| `storage` | `Storage` | `DiskStorage(settings.media.dir, settings.media.route)` | where files go |
| `permissions` | `Permission[]` | — | as on any action |
| `rate` | `{ limit, windowMs }` | 5 / min | beats `apps/<app>/rules.ts`, which beats the 5 / min default |
| `public` | `boolean` | — | served with `Cache-Control: public` (CDNs may cache it) |
| `private` | `boolean` | — | never served without a signed link; not with `public` |

The action takes `{ file }`:

- **multipart**: a `POST` to a page URL with the `x-tvine` header (the page transport the weft forms and the
  file-upload widget use), text field `action=<app>.<name>` first and the `file` part last (nothing may follow it).
  The file is streamed to storage, never buffered whole. `/tvine/api/<id>` does not take multipart for uploads.
- **JSON** (any transport, incl. `/tvine/api`): `{ file: { base64: '…' } }`, at most 256 KB. A URL is refused
  (`url ingestion disabled`).

It returns `UploadedFile`: `{ field, key, url, type, size }`. `key` is `<uploadTo>/<random id>.<ext>`
(`products/V1StGXR8_Z5jdHi6B-myT.png`); save it in your model. For a private file, `url` is a signed link for the
uploader valid 1 h.

Errors: `unsupported_type` (sniffed type not in `types`, or unknown), `too_large`, `invalid_param`.

## Storing the key in a model

```ts
// apps/catalog/models.ts
image: field.image({ optional: true, uploadTo: 'products' }),   // the column holds the storage key
manual: field.file({ optional: true }),
```

The admin shows `image` fields as an image upload (`accept: image/*`) and `file` fields as `application/pdf,image/*`.

## `media.url` / `media.verify`

```ts
media.url(fileOrKey: string | { key }, { expiresIn?: seconds = 3600, user?: TvineUser | string | number, route? }): string
media.verify(key, token): string | null   // the bound user id ('' = anyone with the link), or null when bad / expired
```

`media.url` returns `<route>/<key>?t=<token>`. The token is signed with `settings.secret` and salted with the key, so
it opens that one file. With `user`, only that signed-in user can open it (others get 404).

## Serving (`settings.media.route`)

`GET` / `HEAD` `<route>/<key>`:

| File | Response |
|---|---|
| normal | `Cache-Control: private, max-age=31536000, immutable` |
| `public: true` | `Cache-Control: public, max-age=31536000, immutable` |
| `private: true` | needs a valid `?t=`; `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`; with `media.auditAccess` each read logs `media_private_access` |
| any non-image (PDF) | `Content-Disposition: attachment` (downloads, never opens inline) |
| missing, bad key, bad token | `404` (never 403: a bad link does not confirm the file exists) |

`Content-Type` comes from the stored metadata; `X-Content-Type-Options: nosniff` is always set.

## `Storage` and `DiskStorage`

```ts
interface Storage {
  put(key: string, data: Readable | Buffer, meta: { type: string; size: number; public?: boolean; private?: boolean }): Promise<void>
  url(key: string): string
  delete(key: string): Promise<void>
}
new DiskStorage(dir: string, routePrefix = '/media')
```

`DiskStorage` writes a temp file then renames it (no half files are visible) and keeps `<key>.json` next to the file
with `{ type, size, public?, private? }`. `delete(key)` removes both. The built-in route serves only `DiskStorage`
at `settings.media.dir`: files in another storage need their own serving. Other adapters (S3, …): Not covered (none
ship).

## Settings: `settings.media.*`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `dir` | `string` | `'./media'` | disk folder |
| `route` | `string` | `'/media'` | URL prefix |
| `auditAccess` | `boolean` | — | log a `media_private_access` security event per private read |

## Examples

### 1. Product photos

```ts
// apps/catalog/views.ts
import { defineUpload, isStaff } from 'tvine'

export const uploadPhoto = defineUpload('uploadPhoto', {
  maxBytes: 5_000_000, types: ['image/png', 'image/jpeg', 'image/webp'], uploadTo: 'products', public: true,
  permissions: [isStaff],
})
```

```bash
# multipart through the page transport; the reply carries the action's result { field, key, url, type, size }
curl -s -b jar -H 'x-tvine: 1' -F action=catalog.uploadPhoto -F file=@shoe.jpg http://localhost:3000/
```

Then save `key` with your own action: `Product.update(id, { image: key })`.

### 2. Private invoices, one link per customer

```ts
export const uploadInvoice = defineUpload('uploadInvoice', { maxBytes: 2_000_000, types: ['application/pdf'], uploadTo: 'invoices', private: true, permissions: [isStaff] })

export const invoiceLink = defineAction('invoiceLink', z.object({ orderId: z.number().int() }), async ({ orderId }, ctx) => {
  const o = await Order.get(orderId)
  if (!o || String(o.customerId) !== ctx.request.user.id) throw new DomainError('not_found', 'no such order')
  return { url: media.url(o.invoiceKey, { user: ctx.request.user, expiresIn: 600 }) }
}, { permissions: [isAuthenticated], readOnly: true })
```

### 3. Small avatar as base64 (JSON body)

```ts
// apps/accounts/views.ts exports uploadAvatar = defineUpload('uploadAvatar', { maxBytes: 200_000, types: ['image/png', 'image/jpeg'] })
await api.accounts.uploadAvatar({ file: { base64: dataUrl.split(',')[1] } })   // <= 256 KB
```

## Gotchas

- Only five types are recognised (PNG, JPEG, GIF, WebP, PDF). SVG, ZIP, CSV and Office files are refused.
- `defineUpload` returns the stored key; nothing links it to a row until you save it.
- Deleting a row does not delete its file; call `storage.delete(key)` yourself.
- A private file's upload response `url` expires after 1 h; build fresh links with `media.url` when showing it.
- JSON/base64 uploads cap at 256 KB whatever `maxBytes` says; use multipart for bigger files.

## See also

- [../models.md](../models.md): `field.file`, `field.image`, `uploadTo`
- [../actions.md](../actions.md): permissions and rates on actions
- [security.md](security.md): signing (the token behind `media.url`)
- [auth.md](auth.md): `auth.exportMyData` writes a private media file
