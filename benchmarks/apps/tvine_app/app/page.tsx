// The Tvine welcome page. Replace it with your own.
const css = `
.tv{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:48px 16px;box-sizing:border-box;
  font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;color:#e7e9f3;
  background:radial-gradient(1200px 600px at 20% -10%,#3b2a8a 0%,transparent 60%),radial-gradient(900px 500px at 110% 110%,#0e6b74 0%,transparent 55%),#0b0d17}
.tv-wrap{max-width:880px;width:100%}
.tv-logo{display:inline-flex;align-items:center;gap:10px;font-weight:700;letter-spacing:.02em;font-size:18px}
.tv-mark{width:30px;height:30px;border-radius:8px;background:linear-gradient(135deg,#8b7bff,#2dd4bf);display:grid;place-items:center;color:#0b0d17;font-weight:900}
.tv h1{font-size:clamp(32px,5vw,52px);line-height:1.05;margin:36px 0 12px;letter-spacing:-.02em}
.tv h1 em{font-style:normal;background:linear-gradient(90deg,#a99bff,#2dd4bf);-webkit-background-clip:text;background-clip:text;color:transparent}
.tv p.lead{color:#a8aec8;font-size:18px;max-width:620px;margin:0 0 32px}
.tv-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:28px}
.tv-card{display:flex;flex-direction:column;gap:6px;padding:18px;border-radius:14px;text-decoration:none;color:inherit;
  background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);transition:transform .15s,border-color .15s}
.tv-card:hover{transform:translateY(-2px);border-color:#8b7bff}
.tv-card span{color:#a8aec8;font-size:14px}
.tv-steps{background:rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:18px 20px}
.tv-steps h2{font-size:13px;text-transform:uppercase;letter-spacing:.12em;color:#8b93b5;margin:0 0 10px}
.tv-steps pre{margin:0;font:14px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;color:#d6dbff;white-space:pre-wrap}
.tv-steps .c{color:#6b7394}
.tv-foot{margin-top:22px;color:#6b7394;font-size:13px}
`

export default function Welcome() {
  return (
    <main className="tv">
      <style>{css}</style>
      <div className="tv-wrap">
        <div className="tv-logo"><span className="tv-mark">T</span>Tvine</div>
        <h1>Tvine App is <em>up and running.</em></h1>
        <p className="lead">The install worked. You see this page because <code>app/page.tsx</code> is the default welcome page. Every action you write is a web endpoint and an agent tool.</p>
        <div className="tv-grid">
        <a className="tv-card" href="/admin"><strong>Admin</strong><span>Manage your data. Create a login with tvine createsuperuser.</span></a>
        <a className="tv-card" href="/mcp"><strong>MCP endpoint</strong><span>Your actions as tools for Claude and other agents at /mcp.</span></a>
        <a className="tv-card" href="https://github.com/zohaib3249/tvine/blob/main/docs/getting-started.md"><strong>Docs</strong><span>Models, views, urls, admin, tasks, in TypeScript.</span></a>
        <a className="tv-card" href="/tvine/health"><strong>Health</strong><span>Is the server up? /tvine/health</span></a>
        </div>
        <div className="tv-steps">
          <h2>Next steps</h2>
          <pre>{`tvine startapp blog                `}<span className="c"># a new app in apps/blog</span>{`
tvine makemigrations && tvine migrate
claude                              `}<span className="c"># Claude Code reads .mcp.json: your actions are its tools</span></pre>
        </div>
        <p className="tv-foot">Connect Claude Code: <code>.mcp.json</code> points at http://localhost:3000/mcp.</p>
        <p className="tv-foot">Using an AI assistant? It reads <code>AGENTS.md</code> (layout, commands, recipes, rules): Claude Code, Cursor, Copilot, Codex.</p>
      </div>
    </main>
  )
}
