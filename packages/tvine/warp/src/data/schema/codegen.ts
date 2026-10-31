// Migration file writer: readable, deterministic TS. render(imported file) === file bytes, so a
// generated migration regenerates identically (and its checksum ignores comments/formatting).
import type { FieldSpec } from './state.js'
import { destroyed, type Migration, type OpData } from './operations.js'

const IDENT = /^[A-Za-z_$][\w$]*$/
const key = (k: string) => (IDENT.test(k) ? k : lit(k))

export function lit(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return `'${JSON.stringify(v).slice(1, -1).replace(/\\"/g, '"').replace(/'/g, "\\'")}'`
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return `[${v.map(lit).join(', ')}]`
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const es = Object.entries(v).filter(([, x]) => x !== undefined)
    return es.length ? `{ ${es.map(([k, x]) => `${key(k)}: ${lit(x)}`).join(', ')} }` : '{}'
  }
  throw new Error(`cannot write ${String(v)} into a migration file (plain values only)`)
}

export function fieldCode(s: FieldSpec): string {
  const args = [
    ...(s.kind === 'enum' ? [lit(s.values)] : s.kind === 'fk' || s.kind === 'm2m' ? [lit(s.to)] : []),
    ...(Object.keys(s.opts).length || s.through ? [lit({ ...s.opts, ...(s.through ? { through: s.through } : {}) })] : []),
  ]
  return `field.${s.kind}(${args.join(', ')})`
}

function opCode(o: OpData): string {
  const a = (...xs: unknown[]) => xs.map(lit).join(', ')
  switch (o.kind) {
    case 'createModel': {
      const meta = { ...(o.indexes && Object.keys(o.indexes).length ? { indexes: o.indexes } : {}), ...(o.unique?.length ? { unique: o.unique } : {}), ...(o.constraints && Object.keys(o.constraints).length ? { constraints: o.constraints } : {}) }
      return `ops.createModel(${lit(o.model)}, {\n${Object.entries(o.fields).map(([n, f]) => `      ${key(n)}: ${fieldCode(f)},\n`).join('')}    }${Object.keys(meta).length ? `, ${lit(meta)}` : ''})`
    }
    case 'addField': case 'alterField': return `ops.${o.kind}(${a(o.model, o.name)}, ${fieldCode(o.field)})`
    case 'deleteModel': return `ops.deleteModel(${a(o.model)})`
    case 'removeField': return `ops.removeField(${a(o.model, o.name)})`
    case 'renameField': return `ops.renameField(${a(o.model, o.from, o.to)})`
    case 'renameModel': return `ops.renameModel(${a(o.from, o.to)})`
    case 'addIndex': return `ops.addIndex(${a(o.model, o.name, o.fields)}${o.unique ? ', { unique: true }' : ''})`
    case 'removeIndex': return `ops.removeIndex(${a(o.model, o.name)})`
    case 'addConstraint': return `ops.addConstraint(${a(o.model, o.constraint)})`
    case 'removeConstraint': return `ops.removeConstraint(${a(o.model, o.name)})`
    case 'alterUniqueTogether': return `ops.alterUniqueTogether(${a(o.model, o.unique)})`
    case 'runSQL': return `ops.runSQL(${lit(o.sql)}${o.reverse !== undefined ? `, { reverse: ${lit(o.reverse)} }` : ''})`
  }
}

export function render(m: Migration): string {
  const drops = destroyed(m.operations)
  const usesField = m.operations.some(o => o.kind === 'createModel' || o.kind === 'addField' || o.kind === 'alterField')
  const names = ['migration', ...(m.operations.length ? ['ops'] : []), ...(usesField ? ['field'] : [])]
  const list = (xs: string[]) => (xs.length ? `[\n${xs.map(x => `    ${x},\n`).join('')}  ]` : '[]')
  return (drops.length ? `// DESTRUCTIVE: drops ${drops.join(', ')}\n` : '') +
    `import { ${names.join(', ')} } from 'tvine/migrations'\n\n` +
    'export default migration({\n' +
    `  dependencies: ${list(m.dependencies.map(d => lit(d)))},\n` +
    `  operations: ${list(m.operations.map(opCode))},\n` +
    '})\n'
}
