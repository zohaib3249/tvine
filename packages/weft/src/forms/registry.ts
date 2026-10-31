// Django formfield_overrides: registerFieldWidget('money', MyMoney) for every money field, or
// registerFieldWidget('shop.order.status', StatusPicker) for one field of one model (wins over the kind).
import type { FieldKind, FieldWidget } from './types.js'

const KEY = Symbol.for('tvine.weft.forms.widgets')
const reg = (): Map<string, FieldWidget> => ((globalThis as any)[KEY] ??= new Map())

export function registerFieldWidget(key: FieldKind | `${string}.${string}.${string}`, widget: FieldWidget): () => void {
  reg().set(key, widget)
  return () => { if (reg().get(key) === widget) reg().delete(key) }
}
export const fieldWidgetFor = (kind: FieldKind, model?: string, name?: string): FieldWidget | undefined =>
  (model && name ? reg().get(`${model}.${name}`) : undefined) ?? reg().get(kind)
