// URL path globs for guards + CORS routes: `**` any depth (and the base itself), `*` one segment.
export const pathGlob = (g: string): RegExp => new RegExp('^' + g.split('/**').map((p) =>
  p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('(?:/.*)?') + '$')
