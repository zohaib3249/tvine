// sqlite: "x" quoting, ? params, tv_lower() (registered by sqliteDriver; sqlite's lower() is ASCII-only).
// Migrations: sqlite cannot ALTER a column, so alterField / removeField (and an addField that ADD
// COLUMN refuses) rebuild the table; the runner runs that with foreign keys off + foreign_key_check.
import { checkIdent, renderNode, type Dialect } from '../dialect.js'
import { columnsChanged, defaultRender, rebuild } from '../../schema/operations.js'
import type { FieldSpec } from '../../schema/state.js'

// ADD COLUMN needs a usable default for existing rows and cannot add UNIQUE
const canAddColumn = (f: FieldSpec) => (f.opts.optional || f.opts.default !== undefined) && !f.opts.unique

export const sqlite: Dialect = {
  name: 'sqlite',
  quoteIdent: n => `"${checkIdent(n)}"`,
  param: () => '?',
  render: node => renderNode(node, sqlite),
  lowerFn: 'tv_lower',
  transactionalDDL: true,
  renderOperation(op, from, to) {
    switch (op.kind) {
      case 'removeField': return rebuild(sqlite, op.model, from, to)
      case 'alterField': return columnsChanged(op, sqlite, from, to) ? rebuild(sqlite, op.model, from, to) : defaultRender(op, sqlite, from, to)
      case 'addField': return canAddColumn(op.field) ? defaultRender(op, sqlite, from, to) : rebuild(sqlite, op.model, from, to)
      default: return defaultRender(op, sqlite, from, to)
    }
  },
}
