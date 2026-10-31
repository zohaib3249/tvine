import type { ChannelLayer, Event, Replayed } from './types.js'

// channels.md: named pub/sub groups. Last 64 events per group are kept for Last-Event-ID resume.
export const RING = 64

interface Entry { subs: Set<(e: Event, seq: number) => void>; ring: Replayed[] }

export class MemoryChannelLayer implements ChannelLayer {
  private groups = new Map<string, Entry>()
  // One counter for the whole layer, so a cursor taken on one group stays valid across groups.
  private seq = 0

  group(name: string) {
    return {
      add: (subscriber: (e: Event, seq: number) => void): (() => void) => {
        let entry = this.groups.get(name)
        if (!entry) this.groups.set(name, (entry = { subs: new Set(), ring: [] }))
        entry.subs.add(subscriber)
        // Last unsubscribe drops only the subscriber set; the ring stays for Last-Event-ID replay.
        return () => this.groups.get(name)?.subs.delete(subscriber)
      },
      send: (e: Event): void => {
        let entry = this.groups.get(name)
        if (!entry) this.groups.set(name, (entry = { subs: new Set(), ring: [] }))
        const seq = ++this.seq
        entry.ring.push({ seq, e })
        if (entry.ring.length > RING) entry.ring.shift()
        // Copy first: a subscriber that (un)subscribes mid-send must not change this event's fan-out.
        for (const sub of [...entry.subs]) sub(e, seq)
      },
      size: (): number => this.groups.get(name)?.subs.size ?? 0,
      since: (cursor: number): Replayed[] => (this.groups.get(name)?.ring ?? []).filter((r) => r.seq > cursor),
    }
  }

  // Cursor for Last-Event-ID: the seq of the most recent event sent on any group.
  head(): number {
    return this.seq
  }

  // Removes a group's ring and subscribers. Used when its owner (a session) is evicted.
  drop(name: string): void {
    this.groups.delete(name)
  }

  groupCount(): number {
    return this.groups.size
  }
}
