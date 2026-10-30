import type { ChannelLayer, Event } from './types.js'

// channels.md: named pub/sub groups. Last 64 events per group are kept for Last-Event-ID resume.
const RING = 64

// A group handle: the ChannelLayer contract plus replay. `since` takes a layer-wide cursor (see head()).
export interface ReplayableGroup {
  add(subscriber: (e: Event) => void): () => void
  send(e: Event): void
  size(): number
  since(cursor: number): Event[]
}

interface Entry { subs: Set<(e: Event) => void>; ring: { seq: number; e: Event }[] }

export class MemoryChannelLayer implements ChannelLayer {
  private groups = new Map<string, Entry>()
  // One counter for the whole layer, so a cursor taken on one group stays valid after a group is GC'd.
  private seq = 0

  group(name: string): ReplayableGroup {
    return {
      add: (subscriber) => {
        let entry = this.groups.get(name)
        if (!entry) this.groups.set(name, (entry = { subs: new Set(), ring: [] }))
        const owner = entry
        owner.subs.add(subscriber)
        return () => {
          if (!owner.subs.delete(subscriber)) return
          // Last unsubscribe drops the group and its ring buffer.
          if (owner.subs.size === 0 && this.groups.get(name) === owner) this.groups.delete(name)
        }
      },
      send: (e) => {
        const entry = this.groups.get(name)
        if (!entry) return // nobody listening: don't create a group, don't buffer
        entry.ring.push({ seq: ++this.seq, e })
        if (entry.ring.length > RING) entry.ring.shift()
        // Copy first: a subscriber that (un)subscribes mid-send must not change this event's fan-out.
        for (const sub of [...entry.subs]) sub(e)
      },
      size: () => this.groups.get(name)?.subs.size ?? 0,
      since: (cursor) => (this.groups.get(name)?.ring ?? []).filter((r) => r.seq > cursor).map((r) => r.e),
    }
  }

  // Cursor for Last-Event-ID: the seq of the most recent event sent on any group.
  head(): number {
    return this.seq
  }

  groupCount(): number {
    return this.groups.size
  }
}
