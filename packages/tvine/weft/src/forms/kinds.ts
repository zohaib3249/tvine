// Every FieldKind → its built-in widget → the agent verbs on its `field:<name>` (besides set / clear on all but signature).
// One table for the dev gallery (Alt+Shift+W → Inputs) and docs (widgets/forms.md). No React: cheap to import.
export const FIELD_KINDS: readonly [kind: string, widget: string, verbs: string][] = [
  ['text / email / url / slug / uuid', 'native <input>', ''], ['textarea', '<textarea>', ''], ['int / decimal', 'type=number', ''],
  ['money', 'amount + currency select', ''], ['bool', 'checkbox (nullable: Unknown/Yes/No)', ''], ['date / datetime / time', 'native pickers', ''],
  ['duration', 'HH:MM:SS', ''], ['json', 'textarea + live parse error', ''], ['choice', 'radios ≤ 4, else select', 'choose'],
  ['fk', 'autocomplete / select / raw id', 'search, choose'], ['m2m', 'chips + autocomplete', 'search, add, remove'],
  ['file / image', 'native picker + preview', 'upload'], ['password', 'show/hide', 'set (secret)'],
  ['rich', 'contenteditable editor (own doc model)', 'set(markdown|html), append(markdown), read → markdown'],
  ['color', 'native color + hex + palette', ''], ['range', 'slider (multiple: two thumbs)', ''], ['phone', 'country code + tel → E.164', ''],
  ['search', 'type=search', ''], ['tags', 'chips, free text and/or choices, max', 'add, remove'], ['checkboxes', 'checkbox list', 'add, remove, toggle'],
  ['switch', 'role=switch', 'toggle'], ['segmented', 'segmented radios', 'choose'], ['rating', 'stars', ''], ['otp', 'N digit cells, paste, one-time-code', ''],
  ['markdown', 'textarea + toolbar + preview', 'append, read'], ['code', 'textarea + gutter + highlight (json/js/sql/html/css)', 'read'],
  ['daterange', 'two dates', ''], ['month / week', 'native month / week', ''], ['country', 'filter + ISO 3166 select', 'choose'],
  ['address', 'line1, line2, city, region, postal, country', ''], ['keyvalue', 'editable rows', 'add({key,value}), remove({key})'],
  ['list', 'rows of a sub-kind (meta.of)', 'add({value}), remove({index})'], ['signature', 'canvas → PNG', 'humanOnly (clear when humanOnly: false)'],
  ['currency', 'ISO 4217 select', 'choose'], ['percent', 'number + %', ''], ['ip', 'v4 / v6 text', ''], ['slugAuto', 'slug from meta.from (until edited)', ''],
]
