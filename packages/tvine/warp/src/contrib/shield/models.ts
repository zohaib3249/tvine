// tvine.shield models (docs/design/contrib/shield.md §Data). ShieldRule.rid is the contract Rule.id (stable for the
// built-in defaults, a random id for the panel's own). ShieldConfig is one row: runtime overrides of settings.shield.
import { defineModel } from '../../data/model.js'
import { field } from '../../data/fields.js'

export const ShieldRule = defineModel('shield_rule', {
  id: field.id(),
  rid: field.text({ unique: true }),
  order: field.int({ default: 0 }),
  name: field.text(),
  enabled: field.bool({ default: true }),
  when: field.json(),
  then: field.json(),
  ttl: field.text({ optional: true }),
  hits: field.int({ default: 0 }),
})

export const ShieldList = defineModel('shield_list', {
  id: field.id(),
  kind: field.enum(['ip', 'cidr', 'country', 'asn'] as const),
  value: field.text(),
  list: field.enum(['allow', 'deny'] as const),
  note: field.text({ optional: true }),
  at: field.datetime({ auto: true }),
})

export const ShieldEvent = defineModel('shield_event', {
  id: field.id(),
  at: field.datetime({ auto: true, index: true }),
  ray: field.text({ index: true }),
  ipHash: field.text(),
  ip: field.text({ optional: true }),
  country: field.text({ optional: true }),
  asn: field.int({ optional: true }),
  path: field.text(),
  bot: field.text({ optional: true }),
  category: field.text(),
  score: field.int(),
  decision: field.text({ index: true }),
  ruleId: field.text({ optional: true }),
  mode: field.text(),
})

export const ShieldConfig = defineModel('shield_config', {
  id: field.id(),
  mode: field.text({ optional: true }),
  clearanceTtl: field.text({ optional: true }),
  levels: field.json({ optional: true }),
  aiDefaults: field.json({ optional: true }),
  access: field.json({ optional: true }),
  version: field.int({ default: 0 }),
})
