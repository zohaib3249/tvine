// Django Paginator over a QuerySet: page numbers through OFFSET / LIMIT (qs.slice). Cursor paging
// (qs.page({ cursor })) stays the default for lists; use this when a UI needs "page 3 of 12".
// count / numPages are async (one COUNT query, cached) — Django's are lazy properties.
import { DomainError } from '../core/errors.js'
import type { QuerySet } from './queryset.js'

export interface Page<T> {
  items: T[]                 // Django object_list
  number: number
  numPages: number
  count: number
  hasNext: boolean
  hasPrevious: boolean
  startIndex: number         // 1-based index of the first item (0 when empty), Django start_index()
  endIndex: number
}

export class Paginator<T extends object> {
  private total?: Promise<number>
  constructor(
    readonly objectList: QuerySet<T>,
    readonly perPage: number,
    readonly opts: { orphans?: number; allowEmptyFirstPage?: boolean } = {},
  ) {
    if (!Number.isInteger(perPage) || perPage < 1) throw new Error('Paginator perPage must be a positive integer')
  }
  private get orphans() { return this.opts.orphans ?? 0 }

  count(): Promise<number> { return (this.total ??= this.objectList.count()) }

  async numPages(): Promise<number> {
    const n = await this.count()
    if (n === 0 && this.opts.allowEmptyFirstPage === false) return 0
    return Math.max(1, Math.ceil(Math.max(1, n - this.orphans) / this.perPage))
  }

  // Django validate_number: PageNotAnInteger / EmptyPage → invalid_param on `page`
  async validateNumber(n: unknown): Promise<number> {
    const v = typeof n === 'string' && /^\d+$/.test(n.trim()) ? Number(n) : n
    if (typeof v !== 'number' || !Number.isInteger(v)) throw new DomainError('invalid_param', 'page: that page number is not an integer', 'page')
    if (v < 1) throw new DomainError('invalid_param', 'page: that page number is less than 1', 'page')
    if (v > await this.numPages() && !(v === 1 && this.opts.allowEmptyFirstPage !== false)) {
      throw new DomainError('invalid_param', 'page: that page contains no results', 'page')
    }
    return v
  }

  async page(n: unknown): Promise<Page<T>> {
    const number = await this.validateNumber(n)
    const [count, numPages] = [await this.count(), await this.numPages()]
    const bottom = (number - 1) * this.perPage
    const top = bottom + this.perPage + this.orphans >= count ? count : bottom + this.perPage
    const items = top > bottom ? await this.objectList.slice(bottom, top).all() : []
    return {
      items, number, numPages, count, hasNext: number < numPages, hasPrevious: number > 1,
      startIndex: count ? bottom + 1 : 0, endIndex: count ? bottom + items.length : 0,
    }
  }
}
