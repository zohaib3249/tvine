# Forms

## What it is

Weft has four ways to build a form, all agent-operable:

| Way | From | Use when |
|---|---|---|
| Plain HTML `<form>` + `api.*` in `onSubmit` | the Weft JSX runtime | the simplest case; inputs, selects and the form register by themselves |
| Built-in widgets (`Input`, `Select`, `Quantity`, …) inside a `<form>` | `tvine/widgets` | you want labels, errors, typed agent controls |
| Server `Form` / `Input` / `Button` primitives bound to an action definition | `tvine/weft` (server components) | a server-rendered form that submits through a Next server action into the same dispatcher agents use |
| `ModelForm` / `Field` driven by field meta | `tvine/forms` | Django ModelForm / admin style forms with 40+ field kinds, client validation, inline formsets |

This page covers all four, plus validation, file uploads, `HumanOnly` and confirm prompts.

## Import

```ts
import { Input, Textarea, Select, Checkbox, RadioGroup, FileUpload, Button, HumanOnly } from 'tvine/widgets'
import { Form, Input as FormInput, Button as FormButton } from 'tvine/weft'          // server components only
import { ModelForm, Field, Fieldset, InlineFormset, registerFieldWidget, validate, validateField,
         fromApi, toPayload, fieldPayload, mapServerErrors, slugify } from 'tvine/forms'
import 'tvine/forms/forms.css'                                                      // optional default look
import { api, must, ApiError } from 'tvine/api'
```

---

## 1. Plain HTML form + `api.*`

With `jsxImportSource: "tvine/weft"` in `tsconfig.json`, plain elements register as widgets:

| Element | Agent kind | Controls |
|---|---|---|
| `<form>` | `form` | `submit()` (calls `requestSubmit()`, so your `onSubmit` runs) |
| `<input>` (text-like), `<textarea>` | `input`, `textarea` | `input(text, mode?)`, `clear()` |
| `<input type=checkbox>` / `role=switch` | `checkbox` / `switch` | `toggle(on?)` |
| `<input type=radio>` | `radio` | `select()` |
| `<select>` | `select` | `select(value)` / `select(values[])` |
| `<input type=range>` / `date` / `color` | `slider` / `date` / `color` | `set(value)` |
| `<input type=file>` | `file` | `upload(files[])` (one file unless `multiple`; 5 MB total) |
| `<button>`, `<a href>` | `button`, `link` | `click()`, `navigate()` |
| `<details>` | `disclosure` | `open()`, `close()` |

The id comes from `agentId`, then `name`, then `key`, then (links) `href`, then a slug of the text. Extra
props on any element: `agent={false}` (opt the subtree out), `agentId`, `agentLabel`, `agentSensitive`
(value never shown), `agentConfirm` (see Gotchas).

```tsx
'use client'
import { useRouter } from 'next/navigation'
import { api } from 'tvine/api'

export function Newsletter() {
  const router = useRouter()
  return (
    <form name="newsletter" onSubmit={async (e) => {
      e.preventDefault()
      const f = new FormData(e.currentTarget)
      const r = await api.shop.subscribe({ email: String(f.get('email')) })
      if (!r.ok) alert(r.message); else router.refresh()
    }}>
      <input name="email" type="email" placeholder="you@example.com" required />
      <button type="submit">Subscribe</button>
    </form>
  )
}
```

An agent sees `form:newsletter > input:email` (`input(text)`) and `form:newsletter > button:subscribe` (`click()`),
plus `form:newsletter` itself (`submit()`).

## 2. Built-in widgets in a form

Widgets render native fields with `name`, so `new FormData(form)` reads them. Pass `error` to show a field
error. A checkout form for a shop:

```tsx
'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Input, RadioGroup, Textarea, Checkbox } from 'tvine/widgets'
import { api } from 'tvine/api'

export function CheckoutForm() {
  const router = useRouter()
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [message, setMessage] = useState('')
  return (
    <form name="checkout" onSubmit={async (e) => {
      e.preventDefault()
      const f = Object.fromEntries(new FormData(e.currentTarget))
      const r = await api.shop.checkout({ ...f, gift: f.gift === 'on' })
      if (r.ok) return router.push(r.goto ?? '/orders')
      setErrors(Object.fromEntries((r.errors ?? []).map((x) => [x.field, x.message])))
      setMessage(r.message)
    }}>
      <Input name="email" type="email" label="Email" autoComplete="email" required error={errors.email} />
      <Input name="street" label="Street" required error={errors.street} />
      <RadioGroup name="shipping" label="Shipping" defaultValue="standard"
        options={[{ value: 'standard', label: 'Standard' }, { value: 'express', label: 'Express' }]} />
      <Textarea name="note" label="Note for the courier" maxLength={200} showCount />
      <Checkbox name="gift" label="This is a gift" />
      {message && <p role="alert">{message}</p>}
      <button type="submit">Place order</button>
    </form>
  )
}
```

Agent ids: `form:checkout > input:email`, `… > radio:shipping`, `… > textarea:note`, `… > checkbox:gift`.

## 3. Server primitives bound to an action (`Form`, `Input`, `Button`)

Server components only (`tvine/weft` under `react-server`). The form submits through a Next server action
into the same dispatcher agents use, so a person's submit and an agent's `submit` are the same command.

```ts
function Form(props: {
  action: ActionDef; bind?: Record<string, unknown>; disabled?: boolean; agentId?: string; id?: string
  className?: string; children: ReactNode | ((scope: Scope) => ReactNode); scope?: Scope
}): JSX.Element
function Input(props: {
  name: string; type?: 'text' | 'number' | 'email' | 'date' | 'checkbox' | 'file'
  options?: { value: string; label: string }[]; defaultValue?: unknown; className?: string
  error?: ComponentType<{ message: string }>; scope?: Scope
}): JSX.Element
function Button(props: {
  intent?: string; disabled?: boolean; asChild?: boolean; children: ReactNode; className?: string
  action?: ActionDef; bind?: Record<string, unknown>; agentId?: string; scope?: Scope
}): JSX.Element
```

| `Form` prop | Default | Meaning |
|---|---|---|
| `action` | required | The action definition (`{ id, schema, rules }`). |
| `bind` | — | Values fixed by the server (e.g. `{ productId: 12 }`), signed into a bind token so the client cannot change them. Bind-only params are not shown to agents. |
| `disabled` | `false` | Native `<fieldset disabled>`; agents get no submit control. Also off when every `Button` inside is disabled. |
| `agentId` | `form:<action.id>[:<bind values>]` | Agent id. Needed when several bind-less forms for the same action are on one page, or when `bind` has non-string/number values (dev throws). |
| `id`, `className` | — | DOM attributes of the `<form>`. |

| `Input` prop | Meaning |
|---|---|
| `name` | Must be a param of the action's schema (dev warns otherwise). |
| `type` | `text` (default), `number`, `email`, `date`, `checkbox`, `file`. With `options` it renders a `<select>`. |
| `defaultValue` | Initial value (`defaultChecked` for checkbox). |
| `error` | A client component `({ message }) => …` for the field error; default `<p data-tvine-error>`. |

`Button`: a submit button. Inside a `Form` it submits that form; outside a `Form`, with `action` (and
`bind`), it becomes a one-button form. `intent` becomes the form's agent label. `asChild` puts the submit
behaviour on your own element.

How the submit works:

- `FormData` is coerced to the schema: numbers → `Number`, booleans → checkbox present, empty optional
  fields dropped, repeated names → the last value unless the param is an array.
- One `cmdId` per attempt, so a double click runs the handler once.
- A result with `errors` shows per-field messages (`FieldError`), `message` shows under the form
  (`<p data-tvine-message>`), `goto` is followed only to this site over http(s).
- `rules.confirm` on the action: the confirm dialog appears, then the same submit is resent with the token.

```tsx
// a server component
import { Form, Input, Button } from 'tvine/weft'
import { addToCart } from '../../apps/shop/views'   // see Gotchas: tvine check flags this import

<Form action={addToCart} bind={{ productId: product.id }}>
  <Input name="qty" type="number" defaultValue={1} />
  <Button intent="Add to cart">Add to cart</Button>
</Form>
```

The scope walk: `Form` finds `Input` / `Button` by walking its children. A primitive rendered inside your
own component is invisible to that walk; use render-prop children and pass `scope` on:

```tsx
<Form action={review}>{(scope) => <ReviewFields scope={scope} />}</Form>
```

## 4. `ModelForm` and `Field` (`tvine/forms`)

`ModelForm` renders a whole form from `FormMeta` (the shape the admin API emits: fieldsets, field meta,
inlines). Each field is a `Field` widget; agents speak **API shape** (`set({value: 12.5})`, `choose({value: 'paid'})`).

```ts
function ModelForm(props: ModelFormProps): JSX.Element
```

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `form` | `FormMeta` | required | `{ fieldsets: {title, classes?, fields}[], fields: Record<string, FieldMeta>, inlines?: InlineMeta[] }`. Empty `fieldsets` = all fields in one set. |
| `values` | `Record<string, unknown>` | — | Initial values, API shape. A new object resets the form. |
| `inlines` | `Record<string, Row[] \| { rows: Row[] }>` | — | Inline rows, API shape. |
| `onSubmit` | `(payload, { values, inlines }) => unknown` | required | Gets `toPayload(...)` (API shape). Throw / reject to show server errors (mapped like `errors`). Returning `{ ok: false, message }` shows that message to an agent. |
| `errors` | `unknown` | — | Server errors, any shape `mapServerErrors` reads. |
| `readOnly` | `boolean` | `false` | Every field shown as text; no controls. |
| `layout` | `'stacked' \| 'aligned'` | `'stacked'` | `aligned`: label beside input on wide screens. |
| `name` | `string` | `'model'` | Widget id `form:<name>`. |
| `label` | `string` | `name` | Agent label. |
| `model` | `string` | — | `'app.model'`, for per-field widget overrides and search. |
| `search` | `({ model, field, q, page }) => Promise<{ results: {pk,text}[], more }>` | — | fk / m2m autocomplete. |
| `uploadImage` | `(file, field) => Promise<string>` | — | Rich text image button: upload and return the URL. |
| `call` | `{ id: string; args? }` | — | Headless: the agent's `submit` maps to `do <id>` with `args` + the values. |
| `onDirtyChange` | `(dirty: boolean) => void` | — | |
| `actions` | `ReactNode \| (state) => ReactNode` | one Save button | Submit row. `state` = `{ isDirty, submitting, submit(), reset(), errors }`. |
| `top` | same | — | Extra row above the fields (e.g. a second Save). |
| `className`, `slots` | | | Slots: `root banner fieldset legend actions inline`. |

- Agent widget `form:<name>`: state `{ dirty, pending?, errors?, banner? }`, controls `submit()` and `reset()`.
- Fields: `form:<name> > field:<field>`; inline rows: `form:<name> > inline:<i> > row:<pk|newN> > field:<f>`.
- Inline widget `inline:<name>` (kind `list`): `add()` and `remove(row)`; state `{ rows, deleted, max, min }`.
- `slugAuto` fields follow their `from` field until someone edits them (Django `prepopulated_fields`).
- Fieldset `classes: ['collapse']` renders a `<details>` that opens itself when it holds an error.

```tsx
'use client'
import { ModelForm, type FormMeta } from 'tvine/forms'
import 'tvine/forms/forms.css'
import { api, must } from 'tvine/api'

const form: FormMeta = {
  fieldsets: [{ title: null, fields: ['name', 'price', 'status', 'image'] }],
  fields: {
    name: { name: 'name', label: 'Name', kind: 'text', required: true, readOnly: false, nullable: false, maxLength: 80 },
    price: { name: 'price', label: 'Price', kind: 'money', required: true, readOnly: false, nullable: false, currency: 'USD' },
    status: { name: 'status', label: 'Status', kind: 'choice', required: true, readOnly: false, nullable: false,
      choices: [{ value: 'draft', label: 'Draft' }, { value: 'live', label: 'Live' }] },
    image: { name: 'image', label: 'Photo', kind: 'image', required: false, readOnly: false, nullable: true,
      upload: { accept: 'image/*', maxBytes: 2_000_000 } },
  },
}

export function ProductForm({ values }: { values?: Record<string, unknown> }) {
  return <ModelForm name="product" label="Product" form={form} values={values}
    onSubmit={async (payload) => must(await api.shop.saveProduct(payload as Record<string, unknown>))} />
}
```

`must` throws an `ApiError` on failure; `ModelForm` catches it, maps `field` / `errors` onto the fields,
and shows the rest in the banner.

### `Field`

```ts
function Field(props: FieldProps): JSX.Element
```

| Prop | Type | Meaning |
|---|---|---|
| `meta` | `FieldMeta` | The field (see below). |
| `value` / `onChange` | form shape | See "Value shapes". |
| `error` | `string` | Error text. |
| `readOnly` | `boolean` | Text display, no controls (also when `meta.readOnly`). |
| `search` | `(q, page) => Promise<{results, more}>` | fk / m2m. |
| `model` | `string` | `'app.model'` for overrides. |
| `hideLabel` | `boolean` | Label for screen readers only. |
| `uploadImage` | `(file) => Promise<string>` | rich text. |
| `controls` | overrides | Same override rules as widgets. |
| `className`, `slots` | | Slots: `root label control help error`. |

Widget id `field:<name>`; state `{ kind, value?, filled?, invalid? }` (password / otp / signature show only
`filled`; long text is cut to 400 chars + length; files show `{name, type, size}`).

### `FieldMeta`

| Key | Type | Meaning |
|---|---|---|
| `name`, `label`, `kind` | | required |
| `required`, `readOnly`, `nullable` | `boolean` | required |
| `help` | `string` | Help text (also an agent summary line). |
| `default` | `unknown` | Used for new inline rows. |
| `choices` | `{value,label}[]` | choice, tags, checkboxes, segmented, currency, fk/m2m listed rows. |
| `min`, `max`, `maxLength`, `decimals`, `step` | `number` | Bounds. `max` on tags / m2m / list = most items. |
| `currency` | `string` | money: fixed currency. |
| `multiple` | `boolean` | choice (multi), range (two thumbs). |
| `relation` | `{ model, autocomplete, rawId }` | fk / m2m. `rawId`: type the pk. `autocomplete: false` + `choices`: a plain list. |
| `upload` | `{ accept, maxBytes }` | file / image. |
| `prefix`, `suffix` | `string` | Adornments (`$`, `kg`). |
| `palette` | `string[]` | color presets. |
| `language` | `string` | code: `json js sql html css`. |
| `from` | `string` | slugAuto source field. |
| `of` | `Partial<FieldMeta>` | list item kind (default text). |
| `free` | `boolean` | tags with choices: free text allowed too. |
| `humanOnly` | `boolean` | Lock the field for agents (signature is locked by default; `false` unlocks `clear`). |
| `allowRemoteImages` | `boolean` | rich: keep http(s) images. |

### Field kinds and agent controls

Every kind has `set(value)` and `clear()` (signature: only `clear`, and only when `humanOnly: false`).
Extra controls:

| Kind | Widget | Extra controls / notes |
|---|---|---|
| `text` `email` `url` `slug` `uuid` | native input | |
| `textarea` | textarea | |
| `int` `decimal` | number input | `set` takes a number |
| `money` | amount + currency | `set(value, currency?)` |
| `bool` | switch checkbox (nullable: Unknown/Yes/No select) | |
| `date` `datetime` `time` | native pickers | |
| `duration` | `HH:MM:SS` text | |
| `json` | code editor + live parse error | `set` takes JSON |
| `choice` | dropdown (multi-select when `multiple`) | `choose(value)` |
| `fk` | searchable dropdown / raw id | `search(q, page?)`, `choose(value)` |
| `m2m` | multi-select | `search(q, page?)`, `add(value)`, `remove(value)` |
| `file` `image` | drop zone + preview | `upload(file: {name, type, dataBase64})` (`set` refuses files) |
| `password` | show/hide input | `set` (secret: masked in logs) |
| `rich` | rich text editor | `set(value, format?: markdown\|html)`, `append(markdown)`, `read()` → markdown |
| `color` | color + hex + palette | `set('#rrggbb')` |
| `range` | slider (two thumbs when `multiple`) | |
| `phone` | country code + tel | `set('+15551234567')` (E.164) |
| `search` `month` `week` `ip` `slugAuto` | native input | |
| `tags` | chips | `add(value)`, `remove(value)` |
| `checkboxes` | checkbox list | `add`, `remove`, `toggle(value)` |
| `switch` | role=switch | `toggle()` |
| `segmented` | segmented radios | `choose(value)` |
| `rating` | stars | `set(1..max)` |
| `otp` | N digit cells | secret |
| `markdown` | textarea + toolbar + preview | `append(markdown)`, `read()` |
| `code` | editor with highlight | `read()` |
| `daterange` | two dates | `set({start, end})` |
| `country` | filter + ISO 3166 select | `choose(code)` |
| `address` | line1, line2, city, region, postal, country | `set({line1, city, country, …})` |
| `keyvalue` | editable rows | `add(key, value)`, `remove(key)` |
| `list` | rows of `meta.of` | `add(value)`, `remove(index)` |
| `signature` | canvas → PNG | human only by default |
| `currency` | ISO 4217 select | `choose(value)` |
| `percent` | number + % | |

Every control validates with `validateField` before it changes anything, so an agent gets exactly the
message a person would see (`invalid_param`, `field: "value"`).

### Custom field widgets

```ts
registerFieldWidget(key: FieldKind | `${app}.${model}.${field}`, widget: ComponentType<FieldWidgetProps>): () => void
```

`registerFieldWidget('money', MyMoney)` replaces the widget for every money field;
`registerFieldWidget('shop.order.status', StatusPicker)` for one field of one model (wins over the kind).
It returns an unregister function. The widget gets `{ meta, value, onChange, id, name, invalid, describedBy, readOnly, search?, model?, uploadImage? }`.
Agent controls stay those of the kind.

### Value shapes

Widgets edit **form shape**; the API takes **API shape**. `fromApi(meta, v)` converts API → form;
`fieldPayload(meta, v)` / `toPayload(form, values, inlines?)` convert form → API.

| Kind | Form shape | API shape |
|---|---|---|
| text-like, date, time, choice | `string` (`''` = empty) | same; choice multiple `string[]` |
| int, decimal, percent | `string` | `number` (`null` when empty) |
| money | `{ amount: string, currency }` | `{ value: number, currency }` |
| datetime | local `YYYY-MM-DDTHH:mm` | ISO string (UTC) |
| duration | `[D ]HH:MM[:SS]` | seconds |
| json | text | parsed JSON |
| fk / m2m | `{pk, text}` / `{pk, text}[]` | pk / pk[] |
| file / image | `File` (new) or the stored value | `File`; `null` clears; the stored value is left out (unchanged) |
| keyvalue | `{key, value}[]` | object |

## Validation

Client side (`tvine/forms`):

```ts
validateField(meta: FieldMeta, value: any): string | undefined        // one field, Django-style messages
validate(fields: Record<string, FieldMeta>, values: Record<string, any>): Record<string, string>
```

Messages match Django: `This field is required.`, `Enter a valid email address.`, `Ensure this value is
less than or equal to 10.`, `Select a valid choice. x is not one of the available choices.`, and so on.
`ModelForm` validates on submit and then live after the first submit attempt.

Server errors → fields:

```ts
mapServerErrors(err: unknown): { fields: Record<string, string>; nonField: string[] }
```

Reads an `ApiError`, an `{ ok: false, field?, message, errors? }` result, an array of those, a
`{ fields | errors: Record<field, string | string[]> }` envelope, or a bare record. `__all__`,
`nonField`, `non_field_errors` or no field go to `nonField`. Inline keys: `<inline>.<i>.<field>` or `<inline>[i].<field>`.

With `api.*` directly: a failed call is `{ ok: false, code: 'invalid_param', field?, errors?: [{ field, code?, message }], message }`
(every bad field is in `errors`; `field` is the first). See [api-client.md](api-client.md).

## File uploads

Three pieces exist:

1. **`FileUpload` widget** (`tvine/widgets`) — the picker, with `accept`, `maxBytes`, `maxFiles`; agent
   `upload(files: {name, type, dataBase64}[])`, total agent upload capped at 5 MB. See [widgets.md](widgets.md#fileupload).
2. **`file` / `image` fields** in `ModelForm` — value is a `File`; `toPayload` keeps it as a `File`.
3. **The server endpoint** `/tvine/api/<id>` accepts `multipart/form-data` with one `params` JSON part
   plus file parts, only for actions that declare `multipart`, only for a signed-in user, same-origin, with
   the `x-tvine-api: 1` header. Size limits come from the action's `multipart.maxBytes` / `partBytes`.

`api.*` in the browser always sends JSON (`JSON.stringify` cannot carry a `File`). To send a file, post
multipart yourself:

```ts
async function uploadPhoto(productId: number, file: File) {
  const body = new FormData()
  body.append('params', JSON.stringify({ productId }))
  body.append('photo', file)
  const r = await fetch('/tvine/api/shop.uploadPhoto', {
    method: 'POST', credentials: 'same-origin', headers: { 'x-tvine-api': '1' }, body,
  })
  return r.json()   // an ApiResult
}
```

Not covered: how the action reads the file parts (that is the backend side — see [../warp/actions.md](../warp/actions.md)),
and the file-part naming the server expects. The server `Input type="file"` primitive renders a native
file input only ("upload wiring lands with media" in the source).

## HumanOnly

```ts
import { HumanOnly } from 'tvine/weft'   // also from 'tvine/widgets'
function HumanOnly(props: { reason: string; children?: ReactNode }): JSX.Element
```

Everything inside is shown to agents as locked (`ho: <reason>`, no controls) and the in-tab executor
refuses it with `human_only` before any hook runs. In the browser, untrusted events (`el.click()`,
`dispatchEvent`, WebMCP, page scripts) never reach the subtree's handlers. Empty `reason` →
`"only a human can do this"`. The innermost `HumanOnly` wins. It renders a `display: contents` div.

This is a UI guard. The security guard is the action's `rules.humanOnly` (dispatch refuses agents on every
path: `do`, MCP, HTTP). In dev, a `HumanOnly` wrapping a control bound to an action without `humanOnly`
logs a warning.

```tsx
<HumanOnly reason="Payment must be confirmed by you">
  <Button name="pay" onClick={pay}>Pay $42.00</Button>
</HumanOnly>
```

Known limit (from the source): React portals leave the DOM subtree, so a portal inside `HumanOnly` is not
covered by the event block (it still inherits the locked flag through context).

## Confirm prompts

Server `rules.confirm` on an action makes the first call return `{ ok: false, code: 'confirm_required', confirm: { token, message, summary, expiresIn, by } }`.
What Weft does with it:

| Caller | Behaviour |
|---|---|
| A person via `api.*` in the browser or a server `Form` | `<WeftRoot>`'s confirm dialog (a `Dialog` named `tvine-confirm`) shows `message` and `summary` with Cancel / Confirm; Confirm resends once with `params.$confirm = token`. Without `WeftRoot`, `window.confirm` is used. |
| Cancel | Result `{ ok: false, code: 'confirm_required', reason: 'cancelled', message: 'Cancelled: nothing was done.' }`. Nothing ran. |
| An in-tab agent (a WebMCP step) | The `confirm_required` result goes back to the agent; no dialog. |
| The Confirm button | Wrapped in `HumanOnly`: scripts and agents cannot click it. |

Replace the dialog: `setConfirmHandler(async (ask) => boolean)` from `tvine/api` (one handler per page;
`<WeftRoot>` sets its own on mount).

## Gotchas

- `ModelForm`, `Field`, every widget with a function prop: client components only.
- The server `Form` / `bindAction` path needs the action definition object from `apps/<app>/views.ts`, and
  `tvine check` fails on any file under `app/` or `components/` that imports `apps/`. Not covered: how a
  project is meant to pass that object to `Form` without tripping the check. Plain forms + `api.*` avoid it.
- `Input` (server primitive) outside a `Form`, or inside a component the `Form` cannot see: dev logs an
  error and agents will not see it. Use render-prop children.
- A schema param that should keep every value of a repeated field must be an array (`z.array(...)`), else
  the last value wins.
- `agentConfirm` on plain elements is stored on the control, but the in-tab executor in this version does
  not show a prompt for it (Not covered: its intended behaviour). Use `rules.confirm` on the action.
- Agents type values instantly by default (no per-char animation) unless `<WeftRoot presence={{ typing: 'animate' }}>`.

## See also

- [widgets.md](widgets.md) — every input widget's props and controls
- [api-client.md](api-client.md) — results, errors, confirm, auth
- [pages-and-regions.md](pages-and-regions.md) — scope walk, ids
- [../warp/actions.md](../warp/actions.md) — `rules.humanOnly`, `rules.confirm`, `multipart`, schemas
- [../warp/views.md](../warp/views.md) — ListView / generated create and update actions
