// sqlite: "x" quoting, ? params, tv_lower() (registered by sqliteDriver; sqlite's lower() is ASCII-only).
import { checkIdent, renderNode, type Dialect } from '../dialect.js'

export const sqlite: Dialect = {
  name: 'sqlite',
  quoteIdent: n => `"${checkIdent(n)}"`,
  param: () => '?',
  render: node => renderNode(node, sqlite),
  lowerFn: 'tv_lower',
  transactionalDDL: true,
}
