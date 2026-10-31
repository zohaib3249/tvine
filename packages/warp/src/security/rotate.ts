// `tvine encryption rotate`: re-saves every encrypted field so it is written under the newest key (and its
// blind index re-computed). Reading decrypts with whichever key wrote it; writing always uses the first.
import type { Model } from '../data/model.js'
import { atomic } from '../data/engine.js'

export async function rotateEncryption(models: Model<any, any>[], log: (m: string) => void = () => {}): Promise<number> {
  let total = 0
  for (const m of models) {
    const names = Object.entries(m.fields as Record<string, { kind: string }>).filter(([, f]) => f.kind === 'encrypted').map(([n]) => n)
    if (!names.length) continue
    let cursor: string | undefined
    let n = 0
    do {   // one transaction per page: a crash mid-way leaves whole pages done, and a re-run is harmless
      const p = await m.objects.order('id').page({ cursor, size: 100 }, false)
      if (p.items.length) await atomic(() => m.objects.bulkUpdate(p.items, names))
      n += p.items.length
      cursor = p.nextCursor
    } while (cursor)
    log(`${m.name}: re-encrypted ${n} row(s) (${names.join(', ')})`)
    total += n
  }
  return total
}
