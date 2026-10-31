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
