# Cache framework

## What it is

Tvine's cache: named caches configured in `settings.caches`, each on a
backend (`memory`, `redis`, `file`, `dummy`), with `get / set / add / getOrSet / incr / delete…`, versions, tag
invalidation, and a per-action result cache (`rules.cache`). Values are JSON: Dates and
bigints round-trip, class instances come back as plain objects. Source: `packages/tvine/warp/src/cache/index.ts`.

## Install / enable

Nothing to install: `caches.default` exists with the memory backend. Configure more in settings:

```ts
// config/settings.ts
export default defineSettings({
  redis: { default: { url: 'redis://localhost:6379' } },
  caches: {
    default: { backend: 'redis', timeout: 600 },
    local: { backend: 'memory', maxEntries: 5000 },
  },
})
```

Each named cache is completed from the defaults below.

## Import

```ts
import { cache, caches, Cache } from 'tvine'
```

`cache` is `caches.default` (looked up on each call). `caches.get('local')` or `caches.local` reach another one;
an alias that is not configured throws.

## Backends

| `backend` | Store | Notes |
|---|---|---|
| `'memory'` (default) | per process, LRU | drops the least recently used entry past `maxEntries` |
| `'redis'` | `settings.redis[redis]` | shared; keys are `<redis prefix>cache:<alias>:<key>`; `incr` is atomic |
| `'file'` | one file per key in `location` | needs `location`; past `maxEntries` deletes the oldest third; `incr` is not atomic across processes |
| `'dummy'` | nothing | `get` always misses, `set` does nothing, `incr` throws |

## API (`Cache`)

Timeouts are **seconds**: omitted = the cache's `timeout`, `null` = forever, `0` = do not store. `version` defaults
to the cache's `version`. The stored key is `<keyPrefix>:<version>:<key>`.

| Method | Returns | Meaning |
|---|---|---|
| `get(key, default?, version?)` | value or `default` | |
| `lookup(key, version?)` | `{ hit, v? }` | tells a stored `null` apart from a miss |
| `has(key, version?)` | `boolean` | |
| `set(key, value, timeout?, version?)` | `void` | `timeout 0` deletes |
| `add(key, value, timeout?, version?)` | `boolean` | only when absent; true when stored |
| `getOrSet(key, valueOrFn, timeout?, version?)` | value | a function is called (and awaited) only on a miss |
| `delete(key, version?)` | `boolean` | |
| `touch(key, timeout?, version?)` | `boolean` | new expiry |
| `incr(key, delta = 1, version?)` / `decr(...)` | `number` | the key must exist (else throws `cache key "…" not found`) and hold a number |
| `getMany(keys, version?)` | `Record<key, value>` | hits only |
| `setMany(data, timeout?, version?)` | `string[]` (always `[]`) | |
| `deleteMany(keys, version?)` | `void` | |
| `incrVersion(key, delta = 1, version?)` / `decrVersion` | new version | moves the value to another version |
| `clear()` | `void` | deletes this cache's keys (its `keyPrefix`), not the whole store |
| `tags(['product:12'])` | `Cache` | entries written through it die when a tag is invalidated |
| `invalidateTags(tags)` | `void` | |
| `keyFor(...parts)` / `Cache.keyFor(...)` | `string` | a stable key: strings / numbers / booleans as-is, objects hashed (sorted keys) |
| `makeKey(key, version?)` | `string` | the full stored key |

## Per-action caching: `rules.cache`

```ts
defineAction(name, params, handler, { readOnly: true, cache: { timeout, varyOn?, cache?, tags? } })
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `timeout` | seconds > 0 | — | required |
| `varyOn` | `string[]` | `['user']` | parts of the key: `'user'` (a signed-out caller is keyed by its session), `'session'`, `'query'` (the query string), or a header name |
| `cache` | alias | `'default'` | which cache |
| `tags` | `string[]` | — | `cache.invalidateTags([...])` drops these results |

The key is built from the action id, its params and `varyOn`. Errors (and redirects) are never stored. A cache
that fails is skipped and logged; the handler runs. Boot errors: `cache` without `readOnly: true`, with
`secretResult`, or a bad `varyOn` entry. A signed-in user without an id is never cached when `varyOn` has `'user'`.

## Settings: `settings.caches.<alias>`

| Key | Type | Default | Meaning |
|---|---|---|---|
| `backend` | `'memory' \| 'redis' \| 'file' \| 'dummy'` | `'memory'` | |
| `redis` | alias | `'default'` | `settings.redis` connection (backend `redis`) |
| `location` | `string` | — | directory (backend `file`, required) |
| `timeout` | seconds or `null` | `300` | default timeout; `null` = forever |
| `keyPrefix` | `string` (≤ 64) | `''` | |
| `version` | integer | `1` | |
| `maxEntries` | integer > 0 | `300` | memory and file only |

A redis cache whose connection is not configured fails at boot.

## Examples

### 1. Cache an expensive query

```ts
import { cache } from 'tvine'

const best = await cache.getOrSet('catalog:bestsellers', () =>
  Product.objects.filter({ published: true }).order('-sold').all(10), 120)
```

### 2. Cache a product page action, drop it on edit

```ts
export const detail = defineAction('detail', z.object({ id: z.number().int() }), async ({ id }) => Product.get(id), {
  readOnly: true, cache: { timeout: 300, varyOn: ['query'], tags: ['products'] },   // same for every user
})

export const rename = defineAction('rename', z.object({ id: z.number().int(), name: z.string() }), async ({ id, name }) => {
  await Product.update(id, { name })
  await cache.invalidateTags(['products'])
})
```

### 3. A counter

```ts
await cache.add(`views:${id}`, 0, null)   // create once, keep forever
await cache.incr(`views:${id}`)
```

### 4. Tag one product's entries

```ts
const c = cache.tags([`product:${id}`])
await c.set(`price:${id}:EUR`, price)
await cache.invalidateTags([`product:${id}`])   // every entry written through c is now a miss
```

## Gotchas

- Timeouts are seconds here, but milliseconds almost everywhere else in Tvine settings.
- `memory` and `file` caches are per process / per host: two servers do not see each other's entries or tag
  invalidations. Use `redis` when you run more than one process.
- `varyOn` without `'user'` shares one result between all users: only for public data.
- `incr` on a missing key throws; seed it with `add` first.
- `clear()` only clears this cache's `keyPrefix`; with an empty prefix that is every key of this cache.

## See also

- [../actions.md](../actions.md): `readOnly`, `rules.*`
- [../../../settings-and-env.md](../../../settings-and-env.md): `settings.redis`
- [admin.md](admin.md): model charts are cached 60 s in the default cache
