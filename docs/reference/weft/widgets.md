# Widgets

## What it is

`tvine/widgets` is the set of built-in UI widgets. Each one renders native, accessible HTML (a real
`<select>`, `<input type=date>`, `<dialog>`, `<table>`…), has no styling of its own, and registers with the
agent registry: an id, a kind, a label, JSON state, and controls an agent can call (`select(value)`,
`toggle(on?)`, `open()`…). Agent controls act on the real element, so your `onChange` / `onClick` run for
agents exactly as for people. Every module is `'use client'`; a server component may render them directly.

## Import

```ts
import {
  Input, Textarea, Select, Checkbox, CheckboxGroup, RadioGroup, Switch, Slider, Quantity, Rating,
  Combobox, DatePicker, FileUpload, Swatch, ColorPicker,
  Dialog, Drawer, Menu, ContextMenu, Popover, Tooltip, Toaster, toast,
  Tabs, Accordion, Button, Link, Pagination, Stepper,
  Table, Card, CartBadge, Carousel, SortableList, Tree,
  HumanOnly, part, useControllable,
} from 'tvine/widgets'
```

## Props every widget takes

These come from `defineWidget` and work on every widget below (Card is the exception: it takes only its
own props, listed in its section).

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name` | `string` | — | Stable name; the widget's local id is `<kind>:<name>`. Required on most widgets (see each table). |
| `id` | `string` | `<kind>:<name>` | Override the local id segment. Only letters, digits, `_ . : @ / + -`; anything else becomes `_`. |
| `label` | `string` | per widget | What the agent (and screen reader) calls it. Must end up non-empty. |
| `disabled` | `boolean` | `false` | Native disabled. A disabled widget lists no controls. |
| `presence` | `false \| PresenceOptions` | page setting | Agent outline/cursor/label for this widget; `false` hides it. See [agents-in-the-browser.md](agents-in-the-browser.md). |
| `controls` | `ControlOverrides` | — | Change agent controls: `false` removes one, a partial object patches it (`{ enabled: false }`), a function `(args, ctx, next) => …` wraps it, a full `{ kind, run }` adds a new one. |
| `hooks` | `WidgetHooks` | — | `onAgentAction(e)` (return `false` or a string to refuse), `afterAgentAction(e)`, `onAgentFocus(active)`. They also run for agent actions on any widget inside this one. |
| `className` | `string \| (state) => string` | — | Class on the root part. |
| `slots` | `{ [part]: SlotProps }` | — | Per-part `className`, `style` (both may be functions of state), `asChild` (merge onto your element), `render(props, state)` (full control). Part names are listed per widget. |

Agent ids nest: a `Select name="size"` inside `Card entity="product:12"` is `product:12 > select:size`.
There is no `agentId` prop on these widgets; use `name` or `id`. (`agentId` exists on the server
primitives and on plain HTML under the Weft JSX runtime — see [pages-and-regions.md](pages-and-regions.md).)

Two more props appear on most input widgets:

| Prop | Type | Meaning |
|---|---|---|
| `action` | `ActionHandle` | A server action signed with `bindAction(def, bind)` in a server component. Tells a headless agent (no browser) which action param this widget fills. |
| `url` | `string` | A query param name (e.g. `"color"`, `"q"`). Tells a headless agent "set `?color=<value>` on this page". Must be a plain name; a URL or path is dropped with a dev warning. `url` wins over `action`. |

Every widget root carries `data-tvine-widget="<kind>"`, `data-tvine-id="<id>"` and, while an agent acts on
it, `data-agent-active` and `data-agent-verb="<kind>"` for styling. State attributes (`data-state`,
`data-disabled`, `data-invalid`, …) are listed per widget.

Error codes an agent may get back from a control: `invalid_param` (bad arg; `field` says which),
`unknown_action` (no such control right now), `domain` (refused, e.g. vetoed by a hook), `human_only`.

---

## Inputs

### Input

```ts
import { Input, type InputProps, type InputState } from 'tvine/widgets'
```

Native `<input>` + `<label>`. Kind `input`. Also takes every native `<input>` attribute (`placeholder`,
`maxLength`, `min`, `max`, `pattern`, `autoComplete`, `readOnly`, `onChange`, …).

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name` | `string` | required | Form field name and widget name. |
| `type` | `'text' \| 'number' \| 'email' \| 'password' \| 'search' \| 'url' \| 'tel'` | `'text'` | Input type. |
| `label` | `string` | `name` | Visible `<label>` and agent label. |
| `value` / `defaultValue` | `string \| number` | `''` | Controlled / uncontrolled value. |
| `onValueChange` | `(v: string) => void` | — | Called with the new text. |
| `sensitive` | `boolean` | auto | Hide the value from agents (state becomes `{filled}`). Always on for `type="password"` and `autoComplete` containing `password` or `cc-`; `sensitive={false}` never unmasks a password. |
| `error` | `string` | — | Error text (`role=alert`), sets `aria-invalid`. |
| `description` | `string` | — | Help text under the field. |
| `action`, `url` | see above | — | Headless map. |
| slots | `root label field description error` | | |

- State: `{ value, invalid? }` — `value` is a number (or `null`) for `type="number"`.
- Controls: `input(text, mode?: 'replace'|'append')`, `clear()`. `text` is checked against `maxLength`
  (`invalid_param` if too long), `pattern`, and `min`/`max` for numbers.
- Data attributes: `data-invalid`, `data-disabled`, `data-readonly`, `data-filled`.

```tsx
<Input name="email" type="email" label="Email" autoComplete="email" required error={errors.email} />
<Input name="q" type="search" label="Search products" url="q" />
```

### Textarea

```ts
import { Textarea, type TextareaProps } from 'tvine/widgets'
```

Native `<textarea>`. Kind `textarea`. Takes native textarea attributes too.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name` | `string` | required | Field / widget name. |
| `label` | `string` | `name` | Label. |
| `value` / `defaultValue` | `string` | `''` | Value. |
| `onValueChange` | `(v: string) => void` | — | New text. |
| `autoGrow` | `boolean` | `false` | Sets CSS var `--textarea-height` to the content height. |
| `showCount` | `boolean` | `false` | Live `12/200` counter (`aria-live=polite`). |
| `error` | `string` | — | Error text. |
| `action` | `ActionHandle` | — | Headless map. |
| slots | `root label field count error` | | |

- State: `{ value, length, max?, invalid? }`.
- Controls: `input(text, mode?)`, `clear()`.

```tsx
<Textarea name="note" label="Delivery note" maxLength={200} showCount autoGrow />
```

### Quantity

```ts
import { Quantity, type QuantityProps } from 'tvine/widgets'
```

Native number input (`role=spinbutton`) with − / + buttons. Kind `quantity`.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name` | `string` | required | Field / widget name. |
| `label` | `string` | `'Quantity'` | Label; buttons are "Decrease …" / "Increase …". |
| `min` | `number` | `1` | Lowest value. |
| `max` | `number` | none | Highest value. |
| `step` | `number` | `1` | Step for − / +. |
| `value` / `defaultValue` | `number` | `min` | Value. |
| `onValueChange` | `(v: number) => void` | — | New value. |
| `action` | `ActionHandle` | — | Headless map. |
| slots | `root label decrement input increment` | | |

- State: `{ value, min, max? }`.
- Controls: `set(value)` (min..max), `inc()` (not listed at max), `dec()` (not listed at min).
- Data attributes: `data-at-min`, `data-at-max`.

```tsx
<Quantity name="qty" min={1} max={item.stock} value={qty} onValueChange={setQty} />
```

### Slider

```ts
import { Slider, type SliderProps } from 'tvine/widgets'
```

Native `<input type=range>`, one thumb. Kind `slider`.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name`, `label` | `string` | required | |
| `min`, `max` | `number` | required | Range. |
| `step` | `number` | `1` | Step; agent values snap to it. |
| `value` / `defaultValue` | `number` | `min` | Value. |
| `onValueChange` | `(v: number) => void` | — | |
| `format` | `(v: number) => string` | — | Text for `<output>`, `aria-valuetext` and state `text`. |
| `orientation` | `'horizontal' \| 'vertical'` | `'horizontal'` | |
| `action`, `url` | | — | Headless map. |
| slots | `root label input output` | | |

- State: `{ value, text? }`. Control: `set(value: min..max)`. CSS var `--slider-percent`.

```tsx
<Slider name="max_price" label="Max price" min={0} max={500} step={10} url="max_price" format={(v) => `$${v}`} />
```

### DatePicker

```ts
import { DatePicker, type DatePickerProps } from 'tvine/widgets'
```

Native `<input type=date>`. Kind `date`. Values are ISO `YYYY-MM-DD` strings, compared as strings (no timezone shifts).

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name`, `label` | `string` | required | |
| `value` / `defaultValue` | `string` | `''` | ISO date. |
| `onValueChange` | `(v: string \| null) => void` | — | `null` when empty or an unavailable day. |
| `min`, `max` | `string` | — | ISO bounds. |
| `isDisabled` | `(d: string) => boolean` | — | Unavailable days: a person picking one gets a native validity error; an agent gets `invalid_param`. |
| `required` | `boolean` | `false` | Also removes the `clear` control. |
| `action`, `url` | | — | Headless map. |
| slots | `root label field` | | |

- State: `{ value: string | null }`.
- Controls: `set(value: date)` (refuses non-calendar days like `2026-02-30`, out-of-range and disabled days), `clear()` (only when not required).

```tsx
<DatePicker name="delivery" label="Delivery date" min="2026-11-04" isDisabled={(d) => new Date(d).getUTCDay() === 0} required />
```

### FileUpload

```ts
import { FileUpload, type FileUploadProps } from 'tvine/widgets'
```

Native `<input type=file>` + a keyboard-usable drop zone. Kind `file`. Uncontrolled (no `value` prop).

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name`, `label` | `string` | required | |
| `accept` | `string` | any | Same tokens as the browser: `.jpg`, `image/*`, `image/png`. A MIME token needs both the declared type and the extension's type to match. |
| `multiple` | `boolean` | `false` | |
| `maxBytes` | `number` | — | Per-file limit. |
| `maxFiles` | `number` | — | |
| `required` | `boolean` | `false` | |
| `onFilesChange` | `(files: File[]) => void` | — | Accepted files (a refused pick clears to `[]`). |
| `action` | `ActionHandle` | — | Headless map (the action's multipart call). |
| slots | `root label dropzone list item remove error` | | |

- State: `{ files: {name, type, size}[], invalid? }` — never file contents.
- Controls: `upload(files: {name, type, dataBase64}[])`; `remove(name)` and `clear()` only while files are chosen.
  Agent uploads are refused before touching the input when they break `accept` / `maxBytes` / `maxFiles`,
  have a path in the name, or total over 5 MB.
- Data attributes: `data-invalid`, `data-dragging`.

```tsx
<FileUpload name="receipt" label="Receipt" accept="image/*,.pdf" maxBytes={2_000_000} />
```

### ColorPicker

```ts
import { ColorPicker, type ColorPickerProps } from 'tvine/widgets'
```

Native `<input type=color>`. Kind `color`.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name`, `label` | `string` | required | |
| `value` / `defaultValue` | `string` | `'#000000'` | `#rrggbb`. |
| `onValueChange` | `(v: string) => void` | — | |
| `presets` | `string[]` | — | Suggestions (a `<datalist>`). |
| `action`, `url` | | — | Headless map. |
| slots | `root label field` | | |

- State `{ value }`. Control `set(value: #rrggbb)`. CSS var `--swatch-color`.

---

## Choice

### Select

```ts
import { Select, type SelectOption, type SelectProps } from 'tvine/widgets'
```

Native `<select>`. Kind `select`.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name`, `label` | `string` | required | |
| `options` | `{ value, label, disabled?, group? }[]` | required | `group` puts options in an `<optgroup>`. |
| `value` / `defaultValue` | `string \| string[]` | `''` / `[]` | |
| `multiple` | `boolean` | `false` | |
| `onValueChange` | `(v: string \| string[]) => void` | — | |
| `placeholder` | `string` | — | Empty first option (single only). |
| `required` | `boolean` | `false` | |
| `action`, `url` | | — | Headless map. |
| slots | `root label field option` | | |

- State: `{ value: string | null }` or `{ values: string[] }` when `multiple`.
- Controls: `select(value)` (enum of enabled options) or `select(values[])`; `clear()` only when not
  `required` and (`multiple` or a `placeholder` is set).
- Data attributes: `data-placeholder` (nothing chosen), option `data-selected`.

```tsx
<Select name="size" label="Size" url="size" value={size}
  options={[{ value: 's', label: 'Small' }, { value: 'm', label: 'Medium' }, { value: 'l', label: 'Large', disabled: true }]} />
```

### Combobox

```ts
import { Combobox, type ComboboxProps } from 'tvine/widgets'
```

Text box + suggestion list (APG combobox). Kind `combobox`. At most 10 suggestions. Typing waits 200 ms
before an async load; only the newest request may write suggestions.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name`, `label` | `string` | required | |
| `items` | `T[] \| (q, signal) => Promise<T[]>` | required | Static list (filtered by label, case-insensitive) or async search. |
| `itemValue` / `itemLabel` | `(t: T) => string` | required | |
| `query` / `defaultQuery` / `onQueryChange` | `string` | `''` | The text in the box. |
| `value` / `defaultValue` / `onValueChange` | `string \| null` | `null` | The chosen value (posted by a hidden input named `name`). |
| `freeText` | `boolean` | `false` | Search-box mode: any text is the value, the input itself has `name`. |
| `onSubmit` | `(q: string) => void` | — | Enter outside a form (freeText). |
| `url` | `string` | — | Query param for a search page: submit goes to `?<url>=<query>`. |
| `suggest` | `ActionHandle` | — | Headless suggestions: a read-only server action taking `q`. |
| `placeholder` | `string` | — | |
| slots | `root label input content item empty loading` | | |

- State: `{ query, value, open, suggestions: {value,label}[], loading }`.
- Controls: `search(text)` (types, loads at once, returns the suggestions, waits up to 3 s),
  `choose(value)` (must be a current suggestion unless `freeText`), `clear()`,
  `submit(text?)` (submits the enclosing form, else `onSubmit` + the `url` search page).

```tsx
<Combobox name="city" label="City" items={(q, signal) => fetchCities(q, signal)}
  itemValue={(c) => c.code} itemLabel={(c) => c.name} />
<Combobox name="q" label="Search" items={[]} itemValue={String} itemLabel={String} freeText url="q" />
```

### Checkbox

```ts
import { Checkbox, type CheckboxProps, type Checked } from 'tvine/widgets'
```

Native checkbox. Kind `checkbox`.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name`, `label` | `string` | required | |
| `checked` | `boolean \| 'indeterminate'` | — | Controlled. |
| `defaultChecked` | `boolean` | `false` | |
| `onCheckedChange` | `(v: boolean) => void` | — | |
| `value` | `string` | — | Posted value. |
| `required` | `boolean` | — | |
| `action`, `url` | | — | Headless map. |
| slots | `root input label` | | |

- State `{ checked }`. Control `toggle(on?)` (no arg flips; `on:true` on a checked box is a no-op).
- `data-state`: `checked | unchecked | indeterminate`.

```tsx
<Checkbox name="gift" label="This is a gift" />
```

### CheckboxGroup

```ts
import { CheckboxGroup, type CheckboxGroupProps } from 'tvine/widgets'
```

`<fieldset>` + `<legend>` of checkboxes sharing `name`. Kind `checkbox`.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name`, `label` | `string` | required | |
| `options` | `{ value, label, disabled? }[]` | required | |
| `value` / `defaultValue` | `string[]` | `[]` | |
| `onValueChange` | `(v: string[]) => void` | — | |
| `action`, `url` | | — | Headless map. |
| slots | `root legend item input label` | | |

- State `{ values }`. Control `select(values[])` — sets exactly that set.

### RadioGroup

```ts
import { RadioGroup, type RadioGroupProps } from 'tvine/widgets'
```

`role=radiogroup` of native radios. Kind `radio`.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name`, `label` | `string` | required | |
| `options` | `{ value, label, disabled? }[]` | required | |
| `value` / `defaultValue` | `string` | `''` | |
| `onValueChange` | `(v: string) => void` | — | |
| `orientation` | `'horizontal' \| 'vertical'` | `'vertical'` | |
| `required` | `boolean` | — | |
| `action`, `url` | | — | Headless map. |
| slots | `root label item input itemLabel` | | |

- State `{ value: string | null }`. Control `select(value)`.

```tsx
<RadioGroup name="shipping" label="Shipping" defaultValue="standard"
  options={[{ value: 'standard', label: 'Standard (free)' }, { value: 'express', label: 'Express ($9)' }]} />
```

### Switch

```ts
import { Switch, type SwitchProps } from 'tvine/widgets'
```

`<button role=switch>` plus a hidden input posting `"true"`/`"false"`. Kind `switch`.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name`, `label` | `string` | required | |
| `checked` / `defaultChecked` | `boolean` | `false` | |
| `onCheckedChange` | `(v: boolean) => void` | — | |
| `action`, `url` | | — | Headless map. |
| slots | `root thumb label` | | |

- State `{ on }`. Control `toggle(on?)`. `data-state`: `on | off`.

### Rating

```ts
import { Rating, type RatingProps } from 'tvine/widgets'
```

Star radios ("4 stars"); read-only mode is `role=img`. Kind `rating`.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `label` | `string` | required | |
| `name` | `string` | — | Optional here; without it the id falls back to `id` prop. |
| `max` | `number` | `5` | |
| `value` / `defaultValue` | `number` | `0` | |
| `onValueChange` | `(v: number) => void` | — | |
| `readOnly` | `boolean` | `false` | Display only, no controls. |
| `allowHalf` | `boolean` | `false` | Steps of 0.5. |
| `action` | `ActionHandle` | — | Headless map. |
| slots | `root item input icon` | | |

- State `{ value: number | null, max }`. Control `set(value)` (not in read-only). CSS var `--rating-percent`;
  icon `data-state`: `full | half | empty`.

```tsx
<Rating name="stars" label="Your rating" />
<Rating id="avg" label="Average rating" value={4.5} readOnly />
```

Gotcha: a `Rating` with neither `name` nor `id` throws in dev ("needs a name").

### Swatch

```ts
import { Swatch, type SwatchOption, type SwatchProps } from 'tvine/widgets'
```

Variant picker: native radios, each with a text `aria-label` (never colour only). Kind `radio`.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name`, `label` | `string` | required | |
| `options` | `{ value, label, color?, image?, available?, price? }[]` | required | `available: false` shows the option but it cannot be picked. |
| `value` / `defaultValue` | `string` | `''` | |
| `onValueChange` | `(v: string) => void` | — | |
| `url`, `action` | | — | Headless map (e.g. `url="color"` → `?color=blue`). |
| slots | `root label item swatch itemLabel` | | |

- State `{ value, options: {value, available, price?}[] }`. Control `select(value)` over available options
  only; no control at all when none is available. Item `data-unavailable`; CSS var `--swatch-color`.

```tsx
<Swatch name="color" label="Colour" url="color" value={color}
  options={[{ value: 'black', label: 'Black', color: '#111' }, { value: 'sand', label: 'Sand', color: '#d8c8a8', available: false }]} />
```

---

## Overlays

Closed overlay content is not mounted, so agents never read it.

### Dialog

```ts
import { Dialog, type DialogProps } from 'tvine/widgets'
```

Native `<dialog>` in the top layer. Modal = background gets `inert` + Esc closes. Kind `dialog`.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name`, `label` | `string` | required | `label` is the dialog's `aria-label` and default trigger text. |
| `trigger` | `ReactNode` | `label` | Content of the built-in trigger button. |
| `children` | `ReactNode` | — | Dialog body. |
| `open` / `defaultOpen` | `boolean` | `false` | |
| `onOpenChange` | `(open: boolean) => void` | — | |
| `modal` | `boolean` | `true` | |
| slots | `root trigger content title close` | | The close button (`×`, "Close") is always rendered. |

- State `{ open }`. Controls: `open()` while closed, `close()` while open (they click the real trigger / close).
- While a modal is open, widgets behind it are left out of the agent view and are not callable.

```tsx
<Dialog name="size-guide" label="Size guide" trigger="Size guide">
  <SizeTable />
</Dialog>
```

### Drawer

```ts
import { Drawer, type DrawerProps } from 'tvine/widgets'
```

A Dialog pinned to an edge. Kind `drawer`. Same props as Dialog plus:

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `side` | `'left' \| 'right' \| 'top' \| 'bottom'` | `'right'` | Sets `data-side` on the `<dialog>`; position it with CSS. |

```tsx
<Drawer name="cart" label="Cart" trigger={`Cart (${count})`} side="left"><CartLines /></Drawer>
```

### Menu

```ts
import { Menu, type MenuItem, type MenuProps } from 'tvine/widgets'
```

Menu button with a `popover` list. Items are declared, so agents can pick one while it is closed. Kind `menu`.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name`, `label` | `string` | required | |
| `trigger` | `ReactNode` | `label` | |
| `items` | `{ id, label: ReactNode, onSelect?, disabled? }[]` | required | |
| `open` / `defaultOpen` / `onOpenChange` | | `false` | |
| slots | `root trigger content item` | | |

- State `{ open, items: string[] }` (enabled item ids).
- Controls: `choose(item)` (opens if needed, clicks the item), `open()` while closed, `close()` while open.

```tsx
<Menu name="order-actions" label="Order actions"
  items={[{ id: 'invoice', label: 'Download invoice', onSelect: download }, { id: 'cancel', label: 'Cancel order', onSelect: cancel }]} />
```

### ContextMenu

```ts
import { ContextMenu, type ContextMenuProps } from 'tvine/widgets'
```

Right-click (or the browser's long-press) on `children` opens the same menu. Kind `context-menu`. Props =
Menu props without `trigger`, plus `children` (the area, which stays agent-visible). Controls: `choose(item)`,
`close()` while open (no `open`).

### Popover

```ts
import { Popover, type PopoverProps } from 'tvine/widgets'
```

Non-modal native `popover` (Esc and outside click close it). Kind `popover`.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name`, `label` | `string` | required | |
| `trigger` | `ReactNode` | `label` | |
| `children` | `ReactNode` | — | Content (mounted only while open). |
| `side` | `'top' \| 'bottom' \| 'left' \| 'right'` | `'bottom'` | `data-side` only; no positioning math. |
| `open` / `defaultOpen` / `onOpenChange` | | `false` | |
| slots | `root trigger content` | | |

- State `{ open }`. Controls `open()` / `close()`.

### Tooltip

```ts
import { Tooltip, type TooltipProps } from 'tvine/widgets'
```

Read-only. The text is in state from the start (agents never hover). Kind `tooltip`.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name` | `string` | required | |
| `content` | `string` | required | Tooltip text; also the agent label. |
| `children` | `ReactNode` | — | The trigger (stays agent-visible). |
| slots | `root content` | | |

- State `{ text }`. No controls.

```tsx
<Tooltip name="vat" content="Prices include 20% VAT"><span>ⓘ</span></Tooltip>
```

---

## Navigation

### Button

```ts
import { Button, type ButtonProps } from 'tvine/widgets'
```

Native `<button>`; with `pressed` / `defaultPressed` it is a toggle (`aria-pressed`). Kind `button`.
The slot props (`className`, `style`, `asChild`, `render`) are on the button itself.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name` | `string` | required | |
| `children` | `ReactNode` | required | |
| `label` | `string` | text children, else `name` | |
| `intent` | `string` | — | Shown to agents as `intent: <x>`. |
| `type` | `'button' \| 'submit' \| 'reset'` | `'button'` | |
| `pressed` / `defaultPressed` / `onPressedChange` | `boolean` | — | Toggle mode. |
| `onClick` | `(e) => void` | — | |
| `className`, `style`, `asChild`, `render` | slot props | — | |

- State `{ pressed?, disabled }` (only `pressed` when a toggle). Control `click()`.
- No `action`/`bind` sugar here; call `api.*` in `onClick` (or use the server `Button` primitive inside a server `Form`).

```tsx
'use client'
import { Button } from 'tvine/widgets'
import { api } from 'tvine/api'
export function AddToCart({ productId }: { productId: number }) {
  return <Button name="add" onClick={async () => { const r = await api.cart.add({ productId, qty: 1 }); if (!r.ok) alert(r.message) }}>Add to cart</Button>
}
```

### Link

```ts
import { Link, type LinkProps } from 'tvine/widgets'
```

Native `<a href>`. Same-site left clicks go through the Next App Router (no full reload). Kind `link`.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `href` | `string` | required | |
| `children` | `ReactNode` | required | |
| `name` | `string` | `href` | |
| `label` | `string` | text children, else `href` | |
| `current` | `boolean` | — | `aria-current=page`, state `{current:true}`. |
| `onClick` | `(e) => void` | — | |
| `className`, `style`, `asChild`, `render` | slot props | — | `asChild={<NextLink href=… />}` works. |

- Control `navigate()` only for same-site http(s) hrefs (off-site and `javascript:` links expose none).
  Headless: a plain GET of `href`.

### Pagination

```ts
import { Pagination, type PaginationProps } from 'tvine/widgets'
```

`<nav aria-label="Pagination">` of real links; shows first, last, current ±1 with ellipses. Kind `pagination`.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `page`, `pageCount` | `number` | required | 1-based. |
| `name` | `string` | `'pages'` | |
| `param` | `string` | `'page'` | Query param. |
| `query` | `string` | none | Current search string to keep, e.g. `"sort=price"`. |
| `hrefFor` | `(page) => string` | `?<param>=n` | Custom URLs (then there is no headless map). |
| `onPageChange` | `(page) => void` | — | |
| slots | `root item prev next ellipsis` | | |

- State `{ page, pageCount }`. Controls `page(to)`, `next()` (not on last), `prev()` (not on first).

```tsx
<Pagination page={page} pageCount={pages} query={`sort=${sort}`} />
```

### Tabs

```ts
import { Tabs, type TabItem, type TabsProps } from 'tvine/widgets'
```

APG tabs. Every panel is server-rendered (inactive ones `hidden inert`), so headless agents read all of them. Kind `tabs`.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name`, `label` | `string` | required | |
| `items` | `{ value, label, content, disabled? }[]` | required | |
| `value` / `defaultValue` / `onValueChange` | `string` | first enabled | |
| `url` | `string` | — | Query param for the active tab (headless). |
| `activation` | `'automatic' \| 'manual'` | `'automatic'` | Arrow keys select (automatic) or only move focus (manual). |
| `orientation` | `'horizontal' \| 'vertical'` | `'horizontal'` | |
| slots | `root list trigger panel` | | |

- State `{ value }`. Control `select(value)`.

```tsx
<Tabs name="product-info" label="Product information"
  items={[{ value: 'details', label: 'Details', content: <Details /> }, { value: 'reviews', label: 'Reviews', content: <Reviews /> }]} />
```

### Accordion

```ts
import { Accordion, type AccordionItem, type AccordionProps } from 'tvine/widgets'
```

APG accordion; closed panels are server-rendered `hidden`. Kind `accordion`.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name`, `label` | `string` | required | |
| `items` | `{ value, label, content, disabled? }[]` | required | |
| `type` | `'single' \| 'multiple'` | `'single'` | |
| `collapsible` | `boolean` | `true` | In `single`, can the open item close. |
| `value` / `defaultValue` / `onValueChange` | `string[]` | `[]` | Open items. |
| `url` | `string` | — | Headless map. |
| slots | `root item trigger panel` | | |

- State `{ open: string[] }`. Control `toggle(value, open?)`.

### Stepper

```ts
import { Stepper, type Step, type StepperProps } from 'tvine/widgets'
```

Multi-step flow: a progress list + one panel per step + Back / Next buttons. Kind `stepper`.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name`, `label` | `string` | required | |
| `steps` | `{ value, label, content, validate?() }[]` | required | `validate` returns `{field: message}`, a string, or nothing (may be async). |
| `value` / `defaultValue` / `onValueChange` | `string` | first step | |
| `linear` | `boolean` | `false` | Later steps are locked until earlier ones are done. |
| `url` | `string` | — | Headless map for `go`. |
| slots | `root list item panel prev next error` | | |

- State `{ value, done: string[] }`.
- Controls: `next()` (runs the current step's `validate`; a failure stays put and returns `invalid_param`
  with the first field), `prev()`, `go(step)` (reachable steps only).

```tsx
<Stepper name="checkout" label="Checkout" linear steps={[
  { value: 'address', label: 'Address', content: <AddressFields />, validate: () => (street ? undefined : { street: 'Enter a street' }) },
  { value: 'payment', label: 'Payment', content: <PaymentFields /> },
  { value: 'review', label: 'Review', content: <Review /> },
]} />
```

---

## Data display

### Card

```ts
import { Card, type CardProps } from 'tvine/widgets'
```

An entity card: `<article>` + heading. Its id **is** the global entity (`product:12`), so the same product
in a grid and in "recently viewed" is one agent node. Child widgets scope under it. Kind `card`. `Card` is
server-safe: it strips `hidden` keys before the client part, so they never reach the browser.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `entity` | `string` | required | Global id, e.g. `product:12`. |
| `label` | `string` | required | Heading text and agent label. |
| `data` | `Record<string, unknown>` | required | What the agent reads about the entity. |
| `href` | `string` | — | Heading becomes a link; adds control `navigate()` for same-site hrefs. |
| `summary` | `string[]` | — | Data keys to show in the compact (L1) view. |
| `hidden` | `string[]` | — | Data keys removed before rendering (never sent to the client or agent). |
| `hooks` | `WidgetHooks` | — | |
| `children` | `ReactNode` | — | Body. |
| slots | `root title body` | | |

Card takes no `name`/`id`/`disabled`/`controls`/`presence` props.

```tsx
<Card entity={`product:${p.id}`} label={p.name} href={`/products/${p.slug}`}
  data={{ price: p.price, stock: p.stock, cost: p.cost }} hidden={['cost']}>
  <img src={p.image} alt="" /><AddToCart productId={p.id} />
</Card>
```

### CartBadge

```ts
import { CartBadge, type CartBadgeProps } from 'tvine/widgets'
```

A read-only cart count on `<a href>`. Id is always `cart:badge`; marked personal (the page snapshot is
not cached). Kind `cart-badge`.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `count` | `number` | required | |
| `total` | `string` | — | e.g. `"$42.00"`. |
| `href` | `string` | `'/cart'` | |
| `label` | `(n: number) => string` | `"Cart, n item(s)"` | Accessible name (a function, not a string). |
| `icon` | `ReactNode` | — | |
| `onClick` | `(e) => void` | — | |
| slots | `root icon count` | | |

- State `{ count, total? }`. Control `navigate()`. `data-empty` at 0; `data-bumped` for 300 ms after a change.

### Table

```ts
import { Table, type TableColumn, type TableBulk, type TableProps } from 'tvine/widgets'
```

Native `<table>`. Sort, filter and next page are real links to ListView query params (`?sort=-price`,
`?status=paid`, `?cursor=…`), so a headless agent and a click land on the same URL. Each row registers
as an entity (`order:7`, kind `data`) under `list:rows`. Kind `table`.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name`, `label` | `string` | required | `label` is the `<caption>`. |
| `rows` | `T[] \| Paginated<T>` | required | `Paginated` = `{ items, total?, pageSize, nextCursor? }` (what a ListView returns). |
| `rowId` | `(t: T) => string` | required | |
| `entity` | `string` | — | Row id prefix: `entity="order"` → rows `order:7`; without it rows are `row:7`. |
| `columns` | `TableColumn<T>[]` | required | `{ key, header, sortable?, filter?: 'text' \| { enum: string[] }, cell?(t) }`. Rows publish only column values. |
| `sort` / `onSortChange` | `{ column, dir: 'asc'\|'desc' }` | — | Current sort (from the URL). |
| `filters` / `onFiltersChange` | `Record<string, string>` | — | Current filters. |
| `selection` | `'none' \| 'single' \| 'multiple'` | `'none'` | Row checkboxes. |
| `selected` / `defaultSelected` / `onSelectedChange` | `string[]` | `[]` | |
| `bulk` | `TableBulk[]` | — | `{ name, label, action: ActionHandle, param? = 'ids', confirm?, onRun?(ids) }`. Without `onRun` the button submits the action with `{ [param]: ids }`. `confirm` asks the person with `window.confirm`. |
| `query` | `string` | — | Current search string kept in links. |
| `url` | `{ sort?, cursor?, filters? }` | `sort`, `cursor`, column key | Param names. |
| `virtual` | `{ rowHeight, height? }` | — | Render only the visible window (`height` default `rowHeight*10`). |
| slots | `root toolbar table header headerCell body row cell footer` | | |

- State `{ sort?, filters?, selected?, count, offset?, cursor? }`.
- Controls: `sort(by)` (`price` or `-price`, sortable columns only), `filter_<key>(value)` per filtered
  column, `next()` when there is a `nextCursor`, `select(rows[])` when selectable (rows must be on screen),
  `bulk_<name>(ids?)` per bulk action (defaults to the current selection; not listed when the action is
  agent-off), `scroll(to)` when `virtual`.

`rowId`, `cell` and the `on…` callbacks are functions, and functions cannot be passed from a server
component into a client component. So render `Table` from your own `'use client'` component and give it
the rows from the server:

```tsx
// components/orders-table.tsx
'use client'
import { Table } from 'tvine/widgets'
import type { Paginated } from 'tvine/weft'

type Order = { id: number; total: string; status: string }

export function OrdersTable({ rows, sort, status, query }: { rows: Paginated<Order>; sort?: string; status?: string; query: string }) {
  return (
    <Table name="orders" label="Orders" entity="order" rows={rows} rowId={(o) => String(o.id)} query={query}
      sort={sort ? { column: sort.replace(/^-/, ''), dir: sort.startsWith('-') ? 'desc' : 'asc' } : undefined}
      filters={{ status: status ?? '' }}
      columns={[
        { key: 'id', header: '#' },
        { key: 'total', header: 'Total', sortable: true, cell: (o) => <b>{o.total}</b> },
        { key: 'status', header: 'Status', filter: { enum: ['paid', 'shipped', 'refunded'] } },
      ]} />
  )
}

// app/orders/page.tsx (server component)
import { api, must } from 'tvine/api'
import { OrdersTable } from '../../components/orders-table'

export default async function Orders({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const rows = must(await api.shop.orders({ sort: sp.sort, status: sp.status, cursor: sp.cursor }))   // a ListView
  const query = new URLSearchParams(Object.entries(sp).filter(([, v]) => v) as [string, string][]).toString()
  return <OrdersTable rows={rows as never} sort={sp.sort} status={sp.status} query={query} />
}
```

An agent sees `table:orders` with `sort(by: total|-total)`, `filter_status(value: paid|shipped|refunded)`,
`next()` when there is a next page, and rows `order:1`, `order:2` … with their column values.

`bulk` needs an `ActionHandle` from `bindAction(def)` (server only). See Gotchas.

### Carousel

```ts
import { Carousel, type CarouselProps, type CarouselSlide } from 'tvine/widgets'
```

CSS scroll-snap carousel. All slides are server-rendered and their data published, so agents read every
slide without moving it. Kind `carousel`.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name`, `label` | `string` | required | |
| `slides` | `{ key, label, content, data? }[]` | required | `data` (JSON) is what agents read per slide (else `label`). |
| `index` / `defaultIndex` / `onIndexChange` | `number` | `0` | |
| `loop` | `boolean` | `false` | |
| `autoplay` | `number` | — | Interval in ms. Pauses on hover/focus and while an agent acts; any manual move stops it; off under reduced motion. |
| slots | `root viewport slide prev next dot play` | | |

- State `{ index, count, playing? }`. Controls `set(index)`, `next()` / `prev()` (not at the ends unless
  `loop`), `toggle(on?)` when `autoplay`. No headless map (position is presentation).

### SortableList

```ts
import { SortableList, type SortableListProps } from 'tvine/widgets'
```

`<ul>` with keyboard move (Space grabs, arrows move, Space drops, Esc cancels) and native drag-and-drop.
Items are controlled: `onMove` must reorder them. Kind `list`.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name`, `label` | `string` | required | |
| `items` | `T[]` | required | |
| `itemId` | `(t: T) => string` | required | |
| `onMove` | `(id, to) => void \| Promise<void>` | required | Called once with the final index. |
| `move` | `ActionHandle` | — | Headless: the server action taking `{id, to}`. |
| `children` | `(item: T) => ReactNode` | required | Row content. |
| slots | `root item` | | |

- State `{ count }`. Control `move(id, to)`.

### Tree

```ts
import { Tree, type TreeNode, type TreeProps } from 'tvine/widgets'
```

APG tree view; the whole tree is server-rendered (collapsed groups `hidden inert`). Kind `tree`.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `name`, `label` | `string` | required | |
| `nodes` | `{ id, label, children? }[]` | required | Static. |
| `expanded` / `defaultExpanded` / `onExpandedChange` | `string[]` | `[]` | |
| `selection` | `'none' \| 'single' \| 'multiple'` | `'single'` | |
| `selected` / `defaultSelected` / `onSelectedChange` | `string[]` | `[]` | |
| `url` | `string` | — | Query param for single selection (headless). |
| `render` | `(n) => ReactNode` | `n.label` | Label content (its own elements register normally). |
| slots | `root item toggle label group` | | |

- State `{ expanded, selected? }`. Controls (only over items whose parents are open): `open(item)`,
  `close(item)`, `select(item)` or `select(items[])` for multiple.

```tsx
<Tree name="categories" label="Categories" url="category"
  nodes={[{ id: 'men', label: 'Men', children: [{ id: 'men-shirts', label: 'Shirts' }] }, { id: 'women', label: 'Women' }]} />
```

---

## Feedback

### Toaster and `toast()`

```ts
import { Toaster, toast, type ToasterProps, type ToastItem, type ToastKind } from 'tvine/widgets'
```

`toast()` pushes to a module-level store; one `<Toaster>` renders them in a live region. Kind `toast`, id `toaster`.

```ts
toast(t: { title: string; description?: string; kind?: 'success' | 'error' | 'info'; duration?: number }): string   // returns the id
```

| `toast` option | Default | Meaning |
|---|---|---|
| `kind` | `'info'` | `error` uses `role=alert`, others `role=status`. |
| `duration` | `5000` | ms before dismiss; `0` or `Infinity` = stays. |

| Toaster prop | Type | Default | Meaning |
|---|---|---|---|
| `name` | `string` | `'toaster'` | |
| `label` | `string` | `'Notifications'` | |
| `max` | `number` | `5` | Toasts shown and kept in agent state. |
| slots | `root toast close` | | |

- State `{ items: ToastItem[] }` — dismissed toasts stay in the list flagged `dismissed: true`, so an agent
  does not miss a fast one. Control `close(id)` while any toast is open.

```tsx
// app/layout.tsx: <WeftRoot><Toaster />{children}</WeftRoot>
toast({ title: 'Added to cart', kind: 'success' })
```

### HumanOnly

Re-exported here from `tvine/weft`. Wrap anything only a person may operate. See [forms.md](forms.md#humanonly).

---

## Making your own widget

Use `defineWidget` (or `useWidget`) from `tvine/weft`; see [pages-and-regions.md](pages-and-regions.md).
The slot helpers used by the built-ins are exported:

```ts
part(tag: string, ownProps: Record<string, any>, slot: SlotProps<S> | undefined, state: S, children?: ReactNode): ReactElement
useControllable<T>(value: T | undefined, defaultValue: T): [T, (v: T) => void]   // controlled when value !== undefined
```

## Gotchas

- Any function prop (`onValueChange`, `isDisabled`, `format`, `itemValue`, `rowId`, `cell`, `validate`, `hooks`, `controls` functions…) only works when the widget is rendered from a `'use client'` component. A server component may render a widget with plain data props only.
- `name` is required on almost every widget and must be unique among siblings; it becomes the agent id.
- `label` must be non-empty (dev throws). For `Tooltip` the label is `content`; for `CartBadge`, `Pagination`, `Toaster` it is fixed.
- Controlled props (`value`, `checked`, `open`) need their `on…Change` handler, or the widget cannot change (agent included).
- A control that does not apply right now is simply missing (`dec` at `min`, `close` on a closed dialog, `clear` on a required select). Agents get `unknown_action`.
- `action` must be an `ActionHandle` made by `bindAction` in a server component; a client cannot sign it.
- `url` must be a bare query param name (`"color"`), not `"/shop?color"`.
- `Button`'s own `confirm` prop does not exist; server-side `rules.confirm` covers that (see [forms.md](forms.md#confirm-prompts)).
- `Table bulk[].action`, and the `action` prop of input widgets, need an `ActionHandle` from `bindAction(def, bind)`, which needs the action definition object. That object lives in `apps/<app>/views.ts`, and `tvine check` flags any file under `app/` or `components/` that imports `apps/`. Not covered: how app code is meant to obtain the definition without tripping that check (the repo's example app uses only `api.*` calls).
- Not covered: a per-control `confirm` field exists on the `Control` type (and Table `bulk.confirm` sets it), but the in-tab executor in this version does not prompt on it; only the person-side `window.confirm` in Table bulk buttons runs.

## See also

- [overview.md](overview.md), [forms.md](forms.md), [pages-and-regions.md](pages-and-regions.md), [agents-in-the-browser.md](agents-in-the-browser.md), [api-client.md](api-client.md)
- [../warp/views.md](../warp/views.md) — ListView params (`sort`, `cursor`, filters) the Table links to
- [../warp/actions.md](../warp/actions.md) — `rules.humanOnly`, `rules.confirm`, `readOnly`, `destructive`
