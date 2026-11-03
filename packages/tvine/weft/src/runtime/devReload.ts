// tvine dev: reload this tab when the server restarted (warp transport/inspector.ts devReloadTransport). The server
// sends its boot id on every (re)connect; the first one is remembered, a different one means a new process.
// Callers gate it: WeftRoot behind NODE_ENV !== 'production', the admin / shield bundles behind the shell's data-dev-reload.

// a boot-event handler: first id stored, same id ignored, a new id → reload()
export function bootWatcher(reload: () => void): (id: string) => void {
  let first: string | undefined
  return (id) => { if (first === undefined) first = id; else if (id !== first) reload() }
}

// skipped in frames (the inspector's page pane reloads itself) and without EventSource; returns the stop function
export function devReload(url = '/tvine/dev/reload'): (() => void) | undefined {
  if (typeof EventSource === 'undefined' || window.top !== window.self) return undefined
  const es = new EventSource(url)
  const boot = bootWatcher(() => { es.close(); location.reload() })
  es.addEventListener('boot', (e) => boot((e as MessageEvent<string>).data))
  return () => es.close()
}
