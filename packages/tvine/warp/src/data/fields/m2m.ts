import { z } from 'zod'
import { Field, type ModelDef, type Opts } from './base.js'
import { FkField } from './fk.js'
import { IdField } from './id.js'
import { shortName } from '../sql/dialect.js'

// Many-to-many: no column on the model. The pairs live in a through table — auto-created
// `<model>_<field>` (id, `<model>Id`, `<target>Id`, both CASCADE, unique pair), or a custom through
// model holding one fk to each side (`through: () => ProductTag`). orm-advanced.md §4.
export class M2MField extends Field<never, true, 'm2m', true> {
  readonly kind = 'm2m' as const
  constructor(readonly target: () => ModelDef, opts: Opts & { through?: () => ModelDef } = {}) {
    const { through, ...rest } = opts
    super(rest)
    if (through) (this as { through?: () => ModelDef }).through = through
  }
  columns() { return [] }
  dbType() { return [] }
  columnDDL() { return [] }
  zod() { return z.array(z.union([z.number(), z.string()])) }
}

export interface Through { def: ModelDef; src: string; dst: string; auto: boolean }   // src/dst: fk FIELD names

// the through table of `owner.<name>`; cached per owner field (Table.of caches by fields identity)
const cache = new WeakMap<Field, Map<string, Through>>()
export function throughOf(owner: ModelDef, name: string, f: Field): Through {
  let m = cache.get(f)
  if (!m) cache.set(f, (m = new Map()))
  const key = owner.name
  let t = m.get(key)
  if (t) return t
  const target = f.target!()
  if (f.through) {
    const def = f.through()
    const fks = Object.entries(def.fields).filter(([, x]) => x.kind === 'fk')
    const src = fks.find(([, x]) => x.target!().name === owner.name)?.[0]
    const dst = fks.find(([n, x]) => n !== src && x.target!().name === target.name)?.[0]
    if (!src || !dst) throw new Error(`${owner.name}.${name}: through model ${def.name} needs an fk to ${owner.name} and an fk to ${target.name}`)
    t = { def, src, dst, auto: false }
  } else {
    const self = owner.name === target.name
    const src = self ? `from_${owner.name}` : owner.name, dst = self ? `to_${target.name}` : target.name
    t = {
      def: {
        name: shortName(`${owner.name}_${name}`),
        fields: { id: new IdField(), [src]: new FkField(() => owner, { onDelete: 'CASCADE' }), [dst]: new FkField(() => target, { onDelete: 'CASCADE' }) },
        meta: { unique: [[src, dst]] },
      },
      src, dst, auto: true,
    }
  }
  m.set(key, t)
  return t
}
