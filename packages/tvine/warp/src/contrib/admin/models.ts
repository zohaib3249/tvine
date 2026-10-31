// tvine.admin models: Django's admin LogEntry. user is the user's id as text (no fk: the admin works with a
// BYO user resolver too); contentType is the model key '<app>.<model>'.
import { defineModel } from '../../data/model.js'
import { field } from '../../data/fields.js'

export const ADDITION = 1, CHANGE = 2, DELETION = 3
export const REPR_MAX = 200   // Django object_repr max_length

export const LogEntry = defineModel('admin_logentry', {
  id: field.id(),
  actionTime: field.datetime({ auto: true }),
  userId: field.text({ index: true }),
  contentType: field.text({ index: true }),
  objectId: field.text({ index: true }),
  objectRepr: field.text(),
  actionFlag: field.int(),
  changeMessage: field.json(),
})

// per-user admin preferences (saved filters, column choices): bounded JSON per key (views.ts caps size + count)
export const AdminPref = defineModel('admin_pref', {
  id: field.id(),
  userId: field.text(),
  key: field.text(),
  value: field.json(),
  updatedAt: field.datetime({ auto: true }),
}, { unique: [['userId', 'key']] })

// dashboard rollups (stats.ts): one row per (hour, process, metric key, dims). Each process rewrites its own rows for
// the current hour on every flush, so rows add up across servers and survive restarts. dims hold low-cardinality
// labels only (route patterns, registered action ids, SQL fingerprints without values); hist = latency buckets (ms).
export const AdminStat = defineModel('admin_stat', {
  id: field.id(),
  bucket: field.datetime({ index: true }),
  node: field.text(),
  key: field.text({ index: true }),
  dims: field.json(),
  count: field.int(),
  sum: field.float(),
  max: field.float(),
  hist: field.json(),
})
