#!/usr/bin/env bash
# Real `next build` + `tvine start` under the DEFAULT security headers / CSP (docs/design/server/security-headers.md).
# Opt-in, slow (~1 min): bash packages/tvine/warp/scripts/csp-e2e.sh [--turbopack]
# Builds a throwaway Next app (dynamic page, prerendered page, client components, a Weft-style data fragment,
# a closed-shadow-root <style> like the presence overlay), serves it with tvine start, and loads both pages in
# headless Chrome: they must hydrate, and no CSP violation may reach /tvine/csp-report.
# Plain .jsx (no TypeScript: next would try to install @types). Uses the workspace's `next` (examples/notes' install); installs nothing. Needs Google Chrome (or $CHROME).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
BUNDLER="--webpack"; [ "${1:-}" = "--turbopack" ] && BUNDLER="--turbopack"
NM="$ROOT/examples/notes/node_modules"
[ -d "$NM/next" ] || { echo "csp-e2e: run pnpm install first (needs examples/notes/node_modules/next)"; exit 1; }
[ -x "$CHROME" ] || { echo "csp-e2e: Chrome not found (set CHROME=...)"; exit 1; }
APP="$ROOT/.csp-e2e"   # inside the repo: turbopack refuses symlinks that leave the project root
rm -rf "$APP"; mkdir -p "$APP/app/static" "$APP/app/ui" "$APP/apps/probe" "$APP/node_modules"
trap 'kill "${PID:-0}" 2>/dev/null || true; rm -rf "$APP"' EXIT
for d in next react react-dom; do ln -s "$NM/$d" "$APP/node_modules/$d"; done
ln -s "$ROOT/packages/tvine" "$APP/node_modules/tvine"
cat > "$APP/package.json" <<'EOF'
{ "name": "csp-e2e", "private": true, "type": "module" }
EOF
cat > "$APP/next.config.mjs" <<EOF
export default { compress: false, turbopack: { root: '$ROOT' } }   // the documented setup: tvine compresses (BREACH-aware)
EOF
cat > "$APP/apps/probe/views.mjs" <<'EOF'
export {}
EOF
cat > "$APP/app/layout.jsx" <<'EOF'
export default function Root({ children }) { return <html><body>{children}</body></html> }
EOF
cat > "$APP/app/ui/Probe.jsx" <<'EOF'
'use client'
import { useEffect, useState } from 'react'
// hydration + a closed shadow root with a <style> element (what weft's presence overlay does) + the data fragment is readable
export default function Probe({ name }) {
  const [state, set] = useState('ssr')
  useEffect(() => {
    const host = document.createElement('div')
    const root = host.attachShadow({ mode: 'closed' })
    const style = document.createElement('style')
    style.textContent = '.x{color:rgb(1, 2, 3)}'
    const el = document.createElement('span'); el.className = 'x'
    root.append(style, el); document.body.append(host)
    const color = getComputedStyle(el).color
    const frag = document.querySelector('script[type="text/tvine"]')?.textContent ?? ''
    set(`hydrated ${name} style=${color === 'rgb(1, 2, 3)' ? 'ok' : color} fragment=${JSON.parse(frag).k}`)
  }, [name])
  return <p id="probe" style={{ fontWeight: 600 }}>{state}</p>
}
EOF
cat > "$APP/app/page.jsx" <<'EOF'
import { connection } from 'next/server'
import { headers } from 'next/headers'
import Script from 'next/script'
import { Suspense } from 'react'
import Probe from './ui/Probe'
// ~200 KB streamed after the shell (Suspense): the compressed stream must flow past zlib's buffer (C1)
async function Late() {
  await new Promise((r) => setTimeout(r, 300))
  return <section id="late">{Array.from({ length: 2000 }, (_, i) => <p key={i}>{`row ${i} ${Math.random().toString(36).repeat(3)}`}</p>)}</section>
}
export default async function Page() {
  await connection()   // dynamic: rendered per request, with the nonce
  const nonce = (await headers()).get('x-nonce') ?? undefined
  return <main>
    <script type="text/tvine" dangerouslySetInnerHTML={{ __html: '{"v":1,"k":"page","page":"home","title":"Home"}' }} />
    <Script id="own" nonce={nonce} strategy="afterInteractive">{`document.documentElement.dataset.own = 'ran'`}</Script>
    <Probe name="dynamic" />
    <Suspense fallback={<p>loading</p>}><Late /></Suspense>
  </main>
}
EOF
cat > "$APP/app/static/page.jsx" <<'EOF'
import Probe from '../ui/Probe'
export default function Static() {   // prerendered at build: no nonce, served with the static policy
  return <main><script type="text/tvine" dangerouslySetInnerHTML={{ __html: '{"v":1,"k":"page","page":"static","title":"S"}' }} /><Probe name="static" /></main>
}
EOF
echo "csp-e2e: building warp (tvine start runs dist/)"
(cd "$ROOT" && pnpm -C packages/tvine build > /dev/null)
cd "$APP"
echo "csp-e2e: next build $BUNDLER"
node node_modules/next/dist/bin/next build $BUNDLER > build.log 2>&1 || { cat build.log; exit 1; }
PORT=$((20000 + RANDOM % 20000))
TVINE_SECRET=$(openssl rand -hex 32) NODE_ENV=production node "$ROOT/packages/tvine/warp/bin/tvine.js" start --port "$PORT" > serve.log 2>&1 &
PID=$!
for _ in $(seq 1 50); do curl -s -o /dev/null "http://127.0.0.1:$PORT/tvine/health" && break; sleep 0.2; done
echo "csp-e2e: headers of /"
curl -s -D - -o /dev/null "http://127.0.0.1:$PORT/" | grep -iE '^(content-security-policy|x-frame-options|x-content-type-options|referrer-policy|cross-origin|permissions-policy|x-powered-by|content-encoding)' || true
# next.config compress: false → tvine compresses the streamed HTML (Suspense, > zlib's buffer); it must complete + decode
curl -s --max-time 15 -H 'accept-encoding: gzip' -D - -o /dev/null "http://127.0.0.1:$PORT/" | grep -iE '^(content-encoding|vary):' || true
body=$(curl -s --max-time 15 --compressed "http://127.0.0.1:$PORT/") || { echo "csp-e2e: compressed streamed page did not complete"; exit 1; }
echo "$body" | grep -q 'id="probe"' && echo "$body" | grep -q 'row 1999' || { echo "csp-e2e: gzip body did not decode"; exit 1; }
echo "csp-e2e: streamed page ${#body} bytes, compressed by tvine"
curl -s -H 'accept-encoding: br' -H 'sec-fetch-site: same-origin' --max-time 15 -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:$PORT/" | grep -q 200 || { echo "csp-e2e: br stream failed"; exit 1; }
fail=0
for path in / /static; do
  dom=$("$CHROME" --headless=new --disable-gpu --no-first-run --virtual-time-budget=5000 --dump-dom "http://127.0.0.1:$PORT$path" 2>/dev/null)
  probe=$(echo "$dom" | grep -o '<p id="probe"[^<]*' | sed 's/.*>//')
  echo "csp-e2e: $path → $probe"
  case "$probe" in "hydrated "*" style=ok fragment=page") ;; *) fail=1 ;; esac
  if [ "$path" = / ]; then echo "$dom" | grep -q 'data-own="ran"' || { echo "csp-e2e: nonced next/script did not run"; fail=1; }; fi
done
sleep 0.5
if grep -q 'csp violation' serve.log; then echo "csp-e2e: CSP violations reported:"; grep 'csp violation' serve.log; fail=1; fi
[ $fail = 0 ] && echo "csp-e2e: OK ($BUNDLER)" || { echo "csp-e2e: FAILED"; cat serve.log; }
exit $fail
