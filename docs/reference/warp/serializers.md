# Serializers

A serializer decides two things for a class view: what a caller may send to `create` / `update` (a zod object)
and what each row looks like on the way out (a plain function). It is DRF's `ModelSerializer` reduced to those
two jobs. Without one, a view derives both from its model: input = the model's writable fields, output = every
field except `hidden` and `writeOnly` ones. A second, lighter tool, `apps/<app>/serializers.ts`, reshapes the
default output per model without writing a full serializer. Plain `defineAction` actions have no serializer:
their zod schema is the input and their return value is the output.

**Import:** `import { defineSerializer, type Serializer } from 'tvine'`

## Signature

```ts
interface Serializer<T> {
  input?: z.ZodObject<z.ZodRawShape>                  // create / update params
  readOnlyFields?: string[]                           // DRF read_only_fields
  output(obj: T, sctx: Record<string, unknown>): Record<string, unknown>
}
const defineSerializer = <T>(s: Serializer<T>): Serializer<T> => s   // identity, for typing
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `input` | `z.object({...})` | the model's create input (below) | The params of `create`; `update` uses `input.partial()` plus the lookup param. Must be a plain `z.object`: a refined / transformed object is a boot error ("must be a plain z.object(...)"); refine individual fields instead. |
| `readOnlyFields` | `string[]` | `[]` | Removed from the input. A caller sending one gets `invalid_param` with field code `read_only` ("`"x" is read-only`"). Added to the model's own read-only set. |
| `output` | `(obj, sctx) => object` | required | Builds the result for one row. `sctx` = `getSerializerContext(ctx)`: `{ request, user, view, action }`. |

The final input schema is `input.omit(readOnly).strict()`: unknown keys are rejected (field code `unknown`,
"unknown param"). Validation errors list every bad field (`errors[]`), see [errors.md](./errors.md).

## The default serializer (no `serializer` set)

| Part | Rule |
|---|---|
| Input fields | Every model field except: `id` / `uuid` primary keys, fields with `auto`, `autoNow` or `autoNowAdd`, fields with `readOnly`, fields with `hidden` (unless also `writeOnly`), and `m2m` fields (written through `Model.related()`). |
| Optional | A field that is `optional`, has a `default`, or is auto is optional in `create`. All fields are optional in `update`. |
| Output | The row object minus `hidden` and `writeOnly` fields. |
| Shaper | If `apps/<app>/serializers.ts` exports a shaper for this model, it is applied to that output. |

Field options (`readOnly`, `writeOnly`, `hidden`, `searchable`, `index`, `humanOnly`, defaults) live on the
model fields: see [models.md](./models.md).

## `apps/<app>/serializers.ts` (shapers)

```ts
// apps/catalog/serializers.ts
export const serializers = {
  Product: (row) => ({ ...row, priceLabel: `$${(row.price as { value: number }).value}` }),
}
```

| Point | Detail |
|---|---|
| Export | `serializers`: a record keyed by **model name** → `(row) => row`. |
| Applies to | The default serializer's output of class views in the same app. A view with its own `serializer` does not use it. |
| Loaded | At discovery, next to `views.ts` (`.ts` / `.js` / `.mjs`). |
| Agent snapshots | `serialize/envelope.ts` can apply shapers by node type, but no transport passes them in this release. Not covered. |

## Relation to zod and the model

| Thing | Comes from |
|---|---|
| `create` params | `serializer.input` (or the model's writable fields), minus `readOnlyFields`, strict |
| `update` params | `{ [lookupParam] }` + the same input `.partial()`, strict |
| `list` params | filters / `q` / `sort` / `cursor` or `page`, built from the view config (not the serializer) |
| Output type in `tvine-api.d.ts` | `Record<string, unknown>` for generated actions (`ViewOut`); `@action` methods are typed by their return type |
| Wire format | JSON (`api.*`, `/tvine/api`): a `Date` arrives as a string |
| Humans-only fields | A field with `humanOnly` refuses agent writes in `create` / `update` with `human_only` (setting it to the value it already has is allowed) |

Nested objects: there is no nested-serializer class. Build nested data in `output` (load related rows in
`getQueryset` with prefetch, then map them). Writable nested input: Not covered.

## Examples

### 1. Public product output

```ts
// apps/catalog/views.ts
import { defineSerializer, DetailView, ListView } from 'tvine'
import { Product } from './models.ts'

const publicProduct = defineSerializer<Product>({
  output: (p) => ({ id: p.id, name: p.name, price: p.price, inStock: p.stock > 0 }),
})

export class ProductList extends ListView<Product> { model = Product; serializer = publicProduct }
export class ProductDetail extends DetailView<Product> { model = Product; serializer = publicProduct }
```

### 2. Limited create input with read-only fields

```ts
import { z } from 'zod'
import { CreateView, defineSerializer } from 'tvine'
import { Review } from './models.ts'

export class ReviewCreate extends CreateView<Review> {
  model = Review
  serializer = defineSerializer<Review>({
    input: z.object({ product: z.number().int(), stars: z.number().int().min(1).max(5), text: z.string().max(2000), author: z.string() }),
    readOnlyFields: ['author'],                       // sending author → invalid_param, code read_only
    output: (r) => ({ id: r.id, stars: r.stars, text: r.text }),
  })
  performCreate(data, ctx) { return Review.create({ ...data, author: ctx.request.user.id }) }
}
```

### 3. Different output per action and user

```ts
export class OrderViewSet extends ModelViewSet<Order> {
  model = Order
  getSerializer(ctx) {
    return defineSerializer<Order>({
      output: (o, sctx) => ({
        id: o.id, status: o.status, total: o.total,
        ...((sctx.user as { isStaff?: boolean }).isStaff && { internalNote: o.note }),
        ...(sctx.action === 'get' && { lines: o.lines }),
      }),
    })
  }
}
```

## Gotchas

- `serializer.input` must be a plain `z.object`; `.refine()` on the object fails at boot.
- `readOnlyFields` names must match input keys; listing a key not in the input just does nothing.
- The advertised (MCP / typed) create and update schemas come from `getSerializer` at boot with an anonymous
  user; a per-request switch does not change them.
- Shapers in `serializers.ts` only touch the default serializer; once you set `serializer`, do the shaping in `output`.
- If `lookupParam` equals a writable field name in `update`, boot fails; rename the param or make the field read-only.
- The serializer's output is not filtered again: anything `output` returns is sent.

## See also

[views.md](./views.md) · [actions.md](./actions.md) · [models.md](./models.md) · [errors.md](./errors.md) ·
[overview.md](./overview.md)
