# Bot protection: tvine.shield

Shield is Cloudflare-style protection built into Tvine. Every request gets signals (IP range, country, continent,
network/ASN, datacenter or not, Tor, browser header consistency, verified bots), a score from 1 (bot) to 99
(human), and your rules decide what happens: pass, challenge, block or rate-limit. Real people solve an invisible
check once and get a signed pass cookie, so they are not asked again on every page.

You manage it from its own panel at `/shield` (superusers by default): live analytics with a 3D globe, an event log,
IP profiles, rules (with a JavaScript code editor), allow/deny lists and settings.

## Set up

```ts
// config/settings/base.ts
installedApps: [..., 'tvine.shield'],
middleware: ['tvine.middleware.RequestId', 'tvine.middleware.AllowedHosts', 'tvine.middleware.Shield', ...],
shield: { mode: 'log' },   // 'log' (default): record what it would do · 'enforce': act · 'off'
```

```bash
tvine migrate
```

Open `/shield`, sign in as a superuser, and in **Settings** press **Update now** to download the free DB-IP Lite
country and ASN database (monthly, CC BY 4.0). Without it country, continent and network are empty. The
`shield.ipdb_update` (monthly) and `shield.ranges_update` (daily: AI-crawler IP ranges, Tor exits) tasks keep the
data fresh when `tvine.tasks` and a beat run.

Start in **log** mode: nothing is blocked, every response says what *would* have happened (`tvine-shield:
would-block`), and the panel shows it. Switch to **enforce** when the numbers look right.

## What happens out of the box

The built-in rules (editable in /shield → Rules; **Reset to defaults** restores them):

| Who | What happens |
|---|---|
| More than 300 requests a minute from one IP | 429 (rate limits always run first) |
| Spoofed bots (a Googlebot user agent that fails reverse DNS) | blocked |
| Verified search engines (Google, Bing, Apple, Yandex…) | allowed |
| AI agents acting for a user (Claude-User, ChatGPT-User, Tvine API tokens, Web Bot Auth agents) | allowed |
| Scanners (sqlmap, nikto…) | blocked |
| AI crawlers (GPTBot, ClaudeBot, CCBot, Bytespider…) | challenged |
| Score below 30 on a page | challenged |
| Any browser's first page load without a pass | invisible check, once |

- The AI stances come from `shield.aiDefaults` (`agents: 'allow'`, `crawlers: 'challenge'`, `search: 'allow'`) and
  can be changed per category in /shield → Bots & AI.
- Agent paths (`/mcp`, `/tvine/*`, `/.well-known/*`, `/llms.txt`) never get an HTML page: a JSON 403 / 429.
- The `/shield` panel, the admin and sign-in are never challenged. Signed-in staff are never rate-limited there.
- Static files and Next.js internals (`/_next/*`) skip Shield entirely.

## Challenges

A challenge is shown **in place, on the visitor's own URL** (no redirect). It picks the lightest level that fits:

| Level | What the visitor sees |
|---|---|
| `pow` | "Checking your browser…" for about a second. A small puzzle runs in the background, no click. |
| `checkbox` | "I am human" checkbox. |
| `captcha` | An image puzzle: pick the tiles with a shape, or solve a sum drawn as a picture. Both are noisy, warped images rendered by the server; no answer text reaches the browser. |

Every level also needs the background puzzle, and every answer is single-use. Passing sets the cookie
`__Host-tvine_shield` (dev: `tvine_shield`), tied to the visitor's IP range and browser, valid for
`shield.clearance.ttl` (30 minutes). Choose which levels may be used in /shield → Settings.

## The panel

| Page | What it is for |
|---|---|
| **Analytics** | Requests, served vs mitigated, solve rate, score. Drag on the chart to zoom. A 3D globe (or flat map) by country, a by-region card, and top-10 lists: countries, networks, paths, IPs, bots, rules, user agents, methods, status codes, TLS fingerprints, hosts. Click any value, or a country on the globe, to filter the whole page; filters live in the URL, so views can be shared. |
| **Events** | The request log (all blocks and challenges, plus a sample of passes). Click a row for the full story, then **Block IP**, **Allow IP**, **Open IP profile**, **Create rule from this** or **Test code with this event**. |
| **IP profile** (`/shield/ip/<ip>`) | Country, network, Tor, which lists it is on, its history, and what Shield would do to it right now. |
| **Rules** | Ordered rules with conditions and an action, hit counts and 24 h sparklines. While editing, a live preview says how many stored requests the rule would have matched. |
| **Bots & AI** | Allow / challenge / block per bot category. |
| **Lists** | IP, range (CIDR), country and network allow/deny lists. |
| **Test a request** | Type an IP, path and headers: see the signals, every rule checked and the final decision. Nothing is recorded. |
| **Settings** | Mode, pass lifetime, challenge levels, panel access, data storage and cleanup, the IP database. |

Who may open the panel is a condition on the user, set in Settings → Panel access (default `isSuperuser eq true`),
for example `isStaff eq true`, `groups contains security`, or any field on a custom user model. Every `shield.*`
action checks it again on the server, together with the admin hardening (`allowIps`, 2FA).

## Rules

A rule is **When** (conditions) + **Then** (an action). Rules run top to bottom and the first one that decides wins;
`log` and a rate limit that is not exceeded let the next rules run.

**Fields:** `ip`, `cidr`, `country`, `continent` (AF, AN, AS, EU, NA, OC, SA), `asn`, `asn.kind` (datacenter,
residential, mobile), `local` (your own machine or a private network), `tor`, `path`, `method`, `host`, `ua`,
`bot.name`, `bot.category`, `bot.verified`, `bot.spoofed`, `score`, `rate.ip`, `rate.asn`, `rate.path`, `tls.ja4`,
`header.<name>`, `clearance`, `page` (a GET for a page, not an agent path).

**Operators:** `eq`, `neq`, `in`, `notIn`, `contains`, `startsWith`, `endsWith`, `regex`, `gt`, `lt`, `cidr`.
Conditions combine with **all** / **any** groups and **NOT**.

**Actions:** allow, log, challenge (level + pass lifetime), block (403, 404, 429 or 451, with a message), rate limit
(N per window, counted by IP, network, path or IP + path), or **Code**.

**Regex** uses a safe subset, so no pattern can freeze the server: `^/wp-(admin|login)`, `\.(env|git|bak)$`,
`^/product/\d+$`, `bot|crawler|spider` all work. Quantified groups like `(a+)+` and lookarounds like `(?!…)` are
refused with a clear message.

### Lists or rules?

| | Lists | Rules |
|---|---|---|
| Matches | an IP, range, country or network | any field above, or your code |
| Does | allow or deny | anything |
| Order | checked first, always wins | after lists, top to bottom |
| Use for | "block this IP", "always allow our office" | "challenge /checkout when score < 30" |

An allow-list entry skips everything, rate limits included: only list addresses you fully trust.

### Country rules

| You want | Rule |
|---|---|
| Block some countries | Lists → country → Deny, or `country in CN, RU` → Block |
| Allow only some countries | all of: `country notIn PK, US, GB` and `local eq false` → Block (or Challenge) |
| Everything outside Europe gets a check | `continent neq EU` → Challenge |

A request with no known country (your own machine, an unknown IP) counts as "not in" the list. Keep the
`local eq false` line or the rule also blocks you on localhost. Keep the US on an allow-only list if Google should
index you.

## Code rules

Pick **Code** as the action and write one function. It gets a read-only copy of the request and returns an action,
or nothing to let the next rule decide:

```js
function (req) {
  if (req.path.startsWith('/admin') && req.country !== 'PK') return { type: 'challenge', level: 'auto' }
}
```

`function rule(req) { … }` and `(req) => …` work too. The editor (full screen) has highlighting, completion for
`req.` and the action shapes, errors as you type, a reference panel and a test bench (a sample request or a real
event, **Run** with Ctrl/Cmd+Enter, `console.log` output shown).

**`req` fields:** `ip`, `ipNet`, `country`, `continent`, `asn`, `asnOrg`, `asnKind`, `tor`, `local`, `path`, `query`,
`method`, `host`, `ua`, `uaFamily`, `bot { name, category, verified, spoofed }`, `score`, `headerScore`,
`tls { ja3, ja4 }`, `headers` (lower-case names; cookie and authorization are redacted), `rate { ip, asn, path }`,
`clearance`.

**Return one of:**

```js
{ type: 'allow' }
{ type: 'log' }
{ type: 'block', status: 403, message: 'no' }            // status 403 | 404 | 429 | 451
{ type: 'challenge', level: 'auto' }                     // auto | pow | checkbox | captcha
{ type: 'rateLimit', limit: 100, window: '1m', key: 'ip' }   // window 10s | 1m | 1h · key ip | asn | path
```

**Safety:**

- The code runs in [QuickJS](https://bellard.org/quickjs/), a separate JavaScript engine compiled to WebAssembly,
  in its own worker thread. It cannot reach Node, files, the network or environment variables.
- Each call has 5 ms (`shield.code.timeoutMs`, max 50) and the sandbox is capped at 128 MB.
- Syntax errors are shown with their line and the rule cannot be saved until they are fixed.
- **A broken rule never blocks traffic.** If the code throws, runs too long or returns something invalid, that rule is
  skipped for the request and the next rules decide. The rules list shows "12 errors / 1 h" with the last error. After
  100 errors in a minute the rule pauses itself for 60 seconds.
- Every save is written to the audit log as the rule and a fingerprint of the code (never the code itself).
- Turn code rules off with `shield: { code: { enabled: false } }`.

Rules can also be registered from app code, and then picked from a dropdown under **Code**:

```ts
import { shield } from 'tvinejs/contrib/shield/index'
shield.registerRule('vip', (req, s) => (s.country === 'IS' ? { type: 'allow' } : undefined))
```

## Rate limits: Shield and the framework

Two general limits exist:

| | Framework (`settings.limits.rate`) | Shield rate rules |
|---|---|---|
| Counts | action calls (`/tvine/api/*`, MCP, websocket) | every HTTP request |
| Default | 60 a minute per IP + session | 300 a minute per IP |
| Changed in | settings code | the /shield panel, live |

With both on, the lower one answers 429 first; `tvine check`, the dev server log and /shield → Rules warn about it.
To let Shield be the only general limit:

```ts
limits: { rate: { by: 'shield' } },
```

Then a request Shield rate-checked in enforce mode skips the framework's general bucket. Everything Shield did not
count keeps it: websocket messages, log mode, or when every Shield rate rule is disabled. Per-action limits (login,
password reset) always stay.

## What is stored

- Every block and challenge, plus 1% of passes (`events.samplePass`), or everything with `events.logAll: true`.
  At most `events.maxPerMinute` rows a minute are written; the rest are counted as dropped.
- Per event: time, ray id, IP (`events.storeIp`), its range, country, continent, network, method, host, path (no query
  string), user agent, bot, score, decision and rule. No cookies, auth headers or bodies.
- Charts come from hourly rollups (`stats.bucket`, `stats.retentionDays`). Old events are pruned after
  `events.retentionDays` (14) by the `shield.cleanup` task (needs `tvine.tasks` + a beat).
- Traffic from your own machine has no country. It shows as "Local network", and the globe says so.

### Sample traffic (dev)

```bash
tvine shield simulate --count 300 --hours 24   # realistic requests from public IPs in ~80 countries
tvine shield simulate --clear                  # remove them again
```

They go through your real rules and are tagged with the host `simulated.tvine`. Only runs with `debug` on. Pick the
24 h range or longer to see them.

## Headers

Every response carries:

- `tvine-ray`: look the request up in /shield → Events
- `tvine-shield`: `pass`, `challenge`, `block`, `log`, or `would-…` in log mode
- `Server-Timing: shield;dur=…`

## Locked out?

```bash
tvine shield mode off              # or log / enforce
tvine shield rules disable --all   # or one rule id
```

Running servers pick it up within 3 seconds.

## Behind a proxy or CDN

Set `trustProxy` to the number of proxies in front of the app, so Shield sees the real client IP. TLS fingerprints
(JA3/JA4) are read only from `shield.tlsHeader` (for example `cf-ja4`) and only through a trusted proxy.

## Settings reference

| Key | Default | Meaning |
|---|---|---|
| `shield.mode` | `'log'` | `off`, `log` or `enforce` (the panel can change it live) |
| `shield.clearance.ttl` | `'30m'` | how long a pass lasts |
| `shield.aiDefaults` | agents allow, crawlers challenge, search allow | stance per AI category |
| `shield.panel.path` | `'/shield'` | where the panel lives |
| `shield.panel.access` | superusers | who may open it (a condition on the user) |
| `shield.ipdb.dir` | `'./data/shield'` | where the IP database is kept (git-ignore it) |
| `shield.tlsHeader` | unset | proxy header carrying JA3/JA4 |
| `shield.events.samplePass` | `0.01` | share of passes stored |
| `shield.events.logAll` | `false` | store every request |
| `shield.events.storeIp` | `true` | keep the IP on events (its range is always kept) |
| `shield.events.retentionDays` | `14` | how long events are kept |
| `shield.stats.bucket` / `retentionDays` | `'1h'` / `90` | chart rollups |
| `shield.cleanup.enabled` / `schedule` | `true` / `'30 3 * * *'` | the prune task |
| `shield.webBotAuth.directories` | `[]` | trusted Web Bot Auth key directories (https origins) |
| `shield.code.enabled` / `timeoutMs` | `true` / `5` | code rules |
| `limits.rate.by` | `'framework'` | `'shield'` makes Shield's rules the only general rate limit |
