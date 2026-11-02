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

// one row per notable decision (+ sampled passes). Data policy (owner): never bodies, cookies, Authorization / tokens,
// session ids, the header list, query strings or raw sensor values: only what is listed here.
export const ShieldEvent = defineModel('shield_event', {
  id: field.id(),
  ts: field.datetime({ auto: true, index: true }),
  ray: field.text({ index: true }),
  ip: field.text({ optional: true }),
  ipHash: field.text(),
  ipNet: field.text(),
  country: field.text({ optional: true }),
  asn: field.int({ optional: true }),
  asnOrg: field.text({ optional: true }),
  asnKind: field.text({ optional: true }),
  method: field.text(),
  host: field.text(),
  path: field.text(),
  ua: field.text(),
  uaFamily: field.text({ optional: true }),
  botName: field.text({ optional: true }),
  botCategory: field.text(),
  botVerified: field.bool({ default: false }),
  botVia: field.text({ optional: true }),
  spoofed: field.bool({ default: false }),
  score: field.int(),
  headerScore: field.float(),
  tlsJa4: field.text({ optional: true }),
  decision: field.text(),
  ruleId: field.text({ optional: true }),
  level: field.text({ optional: true }),
  status: field.int({ optional: true }),
  reason: field.text(),
  outcome: field.text({ optional: true }),
  solveMs: field.int({ optional: true }),
  sensorFlags: field.json({ optional: true }),
  fpHash: field.text({ optional: true }),
}, { indexes: [{ fields: ['decision', 'ts'], name: 'shield_event_decision_ts' }, { fields: ['ipNet', 'ts'], name: 'shield_event_ipnet_ts' }] })

export const ShieldConfig = defineModel('shield_config', {
  id: field.id(),
  mode: field.text({ optional: true }),
  clearanceTtl: field.text({ optional: true }),
  levels: field.json({ optional: true }),
  aiDefaults: field.json({ optional: true }),
  access: field.json({ optional: true }),
  version: field.int({ default: 0 }),
})
