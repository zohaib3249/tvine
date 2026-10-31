// tvine.admin 0002 — dashboard rollups (AdminStat); ships with Tvine, matches models.ts.
import { field, migration, ops } from '../../../data/migrations.js'

export default migration({
  dependencies: [['admin', '0001_initial']],
  operations: [
    ops.createModel('admin_stat', {
      id: field.id(),
      bucket: field.datetime({ index: true }),
      node: field.text(),
      key: field.text({ index: true }),
      dims: field.json(),
      count: field.int(),
      sum: field.float(),
      max: field.float(),
      hist: field.json(),
    }),
  ],
})
