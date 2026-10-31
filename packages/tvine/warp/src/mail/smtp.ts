// A small SMTP client on node:net / node:tls (RFC 5321): greeting, EHLO, STARTTLS (useTls) or implicit TLS
// (useSsl), AUTH PLAIN / LOGIN, then MAIL / RCPT / DATA (dot-stuffed) per message, QUIT. One connection per
// send() batch (Django's SMTP backend send_messages). Every wait is capped by email.timeoutMs.
// Messages are 7-bit clean (mail/index.ts encodes bodies and headers), so no 8BITMIME / SMTPUTF8.
import { connect as netConnect, type Socket } from 'node:net'
import { hostname } from 'node:os'
import { connect as tlsConnect } from 'node:tls'
import type { EmailSettings } from '../core/types.js'

export interface Envelope { from: string; to: string[]; data: string }
interface Reply { code: number; lines: string[] }

export class SmtpError extends Error {
  constructor(readonly code: number, msg: string) { super(msg); this.name = 'SmtpError' }
}

class Conn {
  private buf = ''
  private pending: string[] = []
  private replies: Reply[] = []
  private wait?: { res: (r: Reply) => void; rej: (e: Error) => void }
  private failed?: Error
  secure = false

  constructor(private sock: Socket, private timeoutMs: number) { this.bind(sock) }

  private bind(s: Socket) {
    s.setTimeout(this.timeoutMs, () => this.fail(new Error(`smtp: timeout after ${this.timeoutMs} ms`)))
    s.on('data', (d: Buffer) => this.onData(d))
    s.on('error', (e: Error) => this.fail(new Error(`smtp: ${e.message}`)))
    s.on('close', () => this.fail(new Error('smtp: connection closed')))
  }
  private onData(d: Buffer) {
    this.buf += d.toString('latin1')
    let i: number
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '')
      this.buf = this.buf.slice(i + 1)
      this.pending.push(line)
      if (/^\d{3}(?: |$)/.test(line)) {   // the last line of a (multi-line) reply
        const r = { code: Number(line.slice(0, 3)), lines: this.pending.map((l) => l.slice(4)) }
        this.pending = []
        if (this.wait) { const w = this.wait; this.wait = undefined; w.res(r) } else this.replies.push(r)
      }
    }
  }
  private fail(e: Error) {
    if (this.failed) return
    this.failed = e
    this.wait?.rej(e)
    this.wait = undefined
    this.sock.destroy()
  }
  private read(): Promise<Reply> {
    const r = this.replies.shift()
    if (r) return Promise.resolve(r)
    if (this.failed) return Promise.reject(this.failed)
    return new Promise((res, rej) => { this.wait = { res, rej } })
  }
  // label: what an error names (never AUTH secrets or the message itself)
  async expect(label: string, ...ok: number[]): Promise<Reply> {
    const r = await this.read()
    if (!ok.includes(r.code)) throw new SmtpError(r.code, `smtp: ${label} refused: ${r.code} ${r.lines.join(' ').slice(0, 200)}`)
    return r
  }
  cmd(line: string, label: string, ...ok: number[]): Promise<Reply> {
    this.sock.write(`${line}\r\n`)
    return this.expect(label, ...ok)
  }
  async startTls(host: string): Promise<void> {
    // anything that arrived after the 220 was sent in plain text before TLS (a STARTTLS injection): refuse it
    if (this.buf || this.pending.length || this.replies.length) throw new Error('smtp: the server sent data before TLS started')
    const raw = this.sock
    for (const ev of ['data', 'error', 'close']) raw.removeAllListeners(ev)
    raw.setTimeout(0)
    const t = tlsConnect({ socket: raw, servername: host })
    this.sock = t
    this.bind(t)
    await new Promise<void>((res, rej) => {
      t.once('secureConnect', () => { this.secure = true; res() })
      t.once('close', () => rej(this.failed ?? new Error('smtp: TLS handshake failed')))
    })
  }
  close() { this.failed ??= new Error('smtp: closed'); this.sock.destroy() }
}

const LOCAL = new Set(['localhost', '127.0.0.1', '::1'])
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64')
// RFC 5321 4.5.2: a line starting with '.' gets one more
export const dotStuff = (data: string) => data.replace(/(^|\r\n)\./g, '$1..')

async function ehlo(c: Conn): Promise<string[]> {
  const name = hostname().replace(/[^\w.-]/g, '') || 'localhost'
  return (await c.cmd(`EHLO ${name}`, 'EHLO', 250)).lines
}

export async function smtpSend(conf: EmailSettings, envelopes: Envelope[]): Promise<number> {
  const { host, port, timeoutMs } = conf
  const sock = conf.useSsl ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port })
  const c = new Conn(sock, timeoutMs)
  c.secure = conf.useSsl
  try {
    await c.expect('greeting', 220)
    let ext = await ehlo(c)
    if (conf.useTls) {
      await c.cmd('STARTTLS', 'STARTTLS', 220)
      await c.startTls(host)
      ext = await ehlo(c)
    }
    if (conf.user) {
      // credentials only over TLS; plain AUTH only to a local relay with email.allowPlainAuth
      if (!c.secure && !(conf.allowPlainAuth && LOCAL.has(host))) throw new Error('smtp: refusing AUTH on a connection without TLS (set email.useTls or useSsl; email.allowPlainAuth allows it for localhost only)')
      const mechs = (ext.find((l) => /^AUTH[ =]/i.test(l)) ?? '').toUpperCase().split(/[ =]/).slice(1)
      if (mechs.includes('PLAIN')) await c.cmd(`AUTH PLAIN ${b64(`\0${conf.user}\0${conf.password}`)}`, 'AUTH PLAIN', 235)
      else if (mechs.includes('LOGIN')) {
        await c.cmd('AUTH LOGIN', 'AUTH LOGIN', 334)
        await c.cmd(b64(conf.user), 'AUTH LOGIN user', 334)
        await c.cmd(b64(conf.password), 'AUTH LOGIN password', 235)
      } else throw new Error('smtp: the server offers neither AUTH PLAIN nor AUTH LOGIN')
    }
    let sent = 0
    for (const e of envelopes) {
      await c.cmd(`MAIL FROM:<${e.from}>`, 'MAIL FROM', 250)
      for (const r of e.to) await c.cmd(`RCPT TO:<${r}>`, `RCPT TO ${r}`, 250, 251)
      await c.cmd('DATA', 'DATA', 354)
      // line ends normalized to CRLF before dot-stuffing: no bare CR / LF reaches the wire
      await c.cmd(`${dotStuff(e.data.replace(/\r\n|\r|\n/g, '\r\n').replace(/\r\n$/, ''))}\r\n.`, 'message', 250)
      sent++
    }
    await c.cmd('QUIT', 'QUIT', 221).catch(() => undefined)
    return sent
  } finally { c.close() }
}
