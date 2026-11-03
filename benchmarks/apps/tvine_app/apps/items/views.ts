// Idiomatic Tvine JSON API: generic class views for get/create (DRF-style), defineAction for ping,
// limit/offset list (the generic ListView only does cursor/page pagination) and the Redis-backed cache read.
import { z } from 'zod'
import { CreateView, DetailView, DomainError, defineAction, caches } from 'tvine'
import { Item } from './models.ts'

export const ping = defineAction('ping', z.object({}), async () => null, { readOnly: true })

export class ItemDetail extends DetailView<any> { model = Item }          // → items.get    GET  /api/items/<id>
export class ItemCreate extends CreateView<any> { model = Item }          // → items.create POST /api/items (201)

export const page = defineAction('page',
  z.object({ limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).default(0) }),
  async ({ limit, offset }) => Item.objects.order('id').slice(offset, offset + limit).fetchAll(),
  { readOnly: true })

export const cached = defineAction('cached', z.object({ id: z.coerce.number().int() }),
  async ({ id }) => {
    const c = caches.redis
    const hit = await c.get(`item:${id}`)
    if (hit !== undefined) return hit
    const row = await Item.get(id)
    if (!row) throw new DomainError('not_found', `item ${id} not found`)
    await c.set(`item:${id}`, row, 60)
    return row
  }, { readOnly: true })
