// Email (Django django.core.mail; docs/design/conventions/email.md). settings.email picks the backend:
// console (dev: prints to stdout), smtp (mail/smtp.ts), file (one .log per send under email.filePath),
// memory (mail.outbox, the default under tests: Django's locmem), dummy (drops everything).
//
// Messages are built 7-bit clean: RFC 2047 encoded-words for non-ASCII headers / display names, quoted-printable
// text bodies when needed, base64 attachments. A CR or LF in any header value or address is refused (BadHeaderError).
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, join } from 'node:path'
import type { EmailSettings, Settings } from '../core/types.js'
import { onCommit } from '../data/engine.js'
import { DEFAULTS, emailBackendDefault } from '../settings.js'
import { smtpSend } from './smtp.js'

export class BadHeaderError extends Error {
  constructor(msg: string) { super(msg); this.name = 'BadHeaderError' }
}

// ---- config ------------------------------------------------------------------------------------
interface Reg { conf: EmailSettings; outbox: EmailMessage[] }
const REG = Symbol.for('tvine.mail')
const reg: Reg = ((globalThis as { [REG]?: Reg })[REG] ??= { conf: { ...DEFAULTS.email, backend: emailBackendDefault() }, outbox: [] })

export function configureMail(settings: Pick<Settings, 'email'>): void { reg.conf = settings.email }

// mail.outbox: what the memory backend sent (tests empty it with mail.outbox.length = 0)
export const mail = {
  get outbox(): EmailMessage[] { return reg.outbox },
  get settings(): EmailSettings { return reg.conf },
}

// ---- encoding helpers --------------------------------------------------------------------------
const CRLF = '\r\n'
const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s)
function noNewline(name: string, v: string): string {
  if (/[\r\n]/.test(v)) throw new BadHeaderError(`header ${name} holds a newline (header injection refused)`)
  return v
}

// RFC 2047 base64 encoded-words, each <= 75 chars, split on whole characters
export function encodeWord(s: string): string {
  if (isAscii(s)) return s
  const words: string[] = []
  let cur = ''
  for (const ch of s) {
    if (Buffer.byteLength(cur + ch) > 45) { words.push(cur); cur = '' }
    cur += ch
  }
  words.push(cur)
  return words.map((w) => `=?utf-8?b?${Buffer.from(w).toString('base64')}?=`).join(`${CRLF} `)
}

// 'Name <a@b>' | 'a@b' → { name, addr }
function parseAddr(a: string, field: string): { name: string; addr: string } {
  noNewline(field, a)
  const m = /^\s*(.*?)\s*<([^<>\s]+)>\s*$/.exec(a)
  const name = m ? m[1]!.replace(/^"(.*)"$/, '$1') : ''
  const addr = (m ? m[2]! : a).trim()
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(addr)) throw new BadHeaderError(`${field}: "${addr.slice(0, 100)}" is not an email address`)
  return { name, addr }
}
function formatAddr(a: string, field: string): string {
  const { name, addr } = parseAddr(a, field)
  if (!name) return addr
  return `${isAscii(name) ? `"${name.replace(/["\\]/g, '\\$&')}"` : encodeWord(name)} <${addr}>`
}

export function quotedPrintable(s: string): string {
  return s.split(/\r?\n/).map((line) => {
    const bytes = Buffer.from(line, 'utf8')
    let out = '', cur = ''
    bytes.forEach((b, i) => {
      const last = i === bytes.length - 1
      const tok = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last) ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`
      if (cur.length + tok.length > 75) { out += `${cur}=${CRLF}`; cur = '' }
      cur += tok
    })
    return out + cur
  }).join(CRLF)
}
const wrap76 = (b64: string) => b64.replace(/.{76}(?=.)/g, `$&${CRLF}`)

type Part = { headers: [string, string][]; body: string }
const render = (p: Part) => `${p.headers.map(([k, v]) => `${k}: ${v}`).join(CRLF)}${CRLF}${CRLF}${p.body}`

function textPart(text: string, subtype: string): Part {
  const plain = /^[\x00-\x7f]*$/.test(text) && text.split(/\r?\n/).every((l) => l.length <= 998)
  return {
    headers: [['Content-Type', `text/${subtype}; charset="utf-8"`], ['Content-Transfer-Encoding', plain ? '7bit' : 'quoted-printable']],
    body: plain ? text.replace(/\r?\n/g, CRLF) : quotedPrintable(text),
  }
}
function multipart(subtype: string, parts: Part[]): Part {
  const b = `=_tvine_${randomUUID()}`
  return { headers: [['Content-Type', `multipart/${subtype}; boundary="${b}"`]], body: `${parts.map((p) => `--${b}${CRLF}${render(p)}`).join(CRLF)}${CRLF}--${b}--` }
}

const TYPES: Record<string, string> = {
  txt: 'text/plain', html: 'text/html', csv: 'text/csv', json: 'application/json', pdf: 'application/pdf', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', zip: 'application/zip', ics: 'text/calendar',
}
const guessType = (name: string) => TYPES[name.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream'

export interface Attachment { filename: string; content: string | Uint8Array; mimetype?: string }

function attachmentPart(a: Attachment): Part {
  const name = noNewline('attachment filename', a.filename)
  const type = noNewline('attachment mimetype', a.mimetype ?? guessType(name))
  // RFC 2231 for a non-ASCII filename
  const disp = isAscii(name) ? `attachment; filename="${name.replace(/["\\]/g, '')}"` : `attachment; filename*=utf-8''${encodeURIComponent(name)}`
  return {
    headers: [['Content-Type', type], ['Content-Disposition', disp], ['Content-Transfer-Encoding', 'base64']],
    body: wrap76(Buffer.from(a.content).toString('base64')),
  }
}

// ---- messages ----------------------------------------------------------------------------------
const list = (v: string | string[] | undefined) => (v === undefined ? [] : [v].flat())

export interface MessageOpts {
  subject?: string; body?: string; from?: string
  to?: string | string[]; cc?: string | string[]; bcc?: string | string[]; replyTo?: string | string[]
  headers?: Record<string, string>; attachments?: Attachment[]
}

export class EmailMessage {
  subject: string; body: string; from: string
  to: string[]; cc: string[]; bcc: string[]; replyTo: string[]
  headers: Record<string, string>; attachments: Attachment[]
  alternatives: [string, string][] = []

  constructor(o: MessageOpts = {}) {
    this.subject = o.subject ?? ''
    this.body = o.body ?? ''
    this.from = o.from ?? reg.conf.defaultFrom
    this.to = list(o.to); this.cc = list(o.cc); this.bcc = list(o.bcc); this.replyTo = list(o.replyTo)
    this.headers = { ...o.headers }
    this.attachments = [...(o.attachments ?? [])]
  }

  attach(filename: string, content: string | Uint8Array, mimetype?: string): this {
    this.attachments.push({ filename, content, ...(mimetype && { mimetype }) })
    return this
  }
  attachFile(path: string, mimetype?: string): this { return this.attach(basename(path), readFileSync(path), mimetype) }

  recipients(): string[] { return [...this.to, ...this.cc, ...this.bcc].map((a) => parseAddr(a, 'recipient').addr) }

  // the RFC 5322 message (CRLF line ends); Bcc is never written
  message(): string {
    const h: [string, string][] = [
      ['From', formatAddr(this.from, 'From')],
      ...(this.to.length ? [['To', this.to.map((a) => formatAddr(a, 'To')).join(', ')] as [string, string]] : []),
      ...(this.cc.length ? [['Cc', this.cc.map((a) => formatAddr(a, 'Cc')).join(', ')] as [string, string]] : []),
      ...(this.replyTo.length ? [['Reply-To', this.replyTo.map((a) => formatAddr(a, 'Reply-To')).join(', ')] as [string, string]] : []),
      ['Subject', encodeWord(noNewline('Subject', this.subject))],
      ['Date', new Date().toUTCString().replace('GMT', '+0000')],
      ['Message-ID', `<${randomUUID()}@${hostname().replace(/[^\w.-]/g, '') || 'localhost'}>`],
      ['MIME-Version', '1.0'],
    ]
    for (const [k, v] of Object.entries(this.headers)) {
      if (!/^[\x21-\x39\x3b-\x7e]+$/.test(k)) throw new BadHeaderError(`header name "${k.slice(0, 50)}" is invalid`)
      const i = h.findIndex(([n]) => n.toLowerCase() === k.toLowerCase())
      const val = encodeWord(noNewline(k, v))
      if (i >= 0) h[i] = [k, val]; else h.push([k, val])
    }
    let content = textPart(this.body, 'plain')
    if (this.alternatives.length) content = multipart('alternative', [content, ...this.alternatives.map(([c, t]) => textPart(c, noNewline('alternative mimetype', t).replace(/^text\//, '')))])
    if (this.attachments.length) content = multipart('mixed', [content, ...this.attachments.map(attachmentPart)])
    return render({ headers: [...h, ...content.headers], body: content.body })
  }

  async send(failSilently = false): Promise<number> {
    if (!this.recipients().length) return 0
    return sendMessages([this], failSilently)
  }

  // what the background task carries (attachments as base64)
  toJSON(): MailJSON {
    return { subject: this.subject, body: this.body, from: this.from, to: this.to, cc: this.cc, bcc: this.bcc, replyTo: this.replyTo, headers: this.headers,
      alternatives: this.alternatives, attachments: this.attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64'), ...(a.mimetype && { mimetype: a.mimetype }) })) }
  }
  static fromJSON(j: MailJSON): EmailMessage {
    const m = new EmailMultiAlternatives({ ...j, attachments: j.attachments.map((a) => ({ ...a, content: Buffer.from(a.content, 'base64') })) })
    m.alternatives = j.alternatives
    return m
  }
}
export interface MailJSON {
  subject: string; body: string; from: string; to: string[]; cc: string[]; bcc: string[]; replyTo: string[]
  headers: Record<string, string>; alternatives: [string, string][]; attachments: { filename: string; content: string; mimetype?: string }[]
}

export class EmailMultiAlternatives extends EmailMessage {
  attachAlternative(content: string, mimetype: string): this { this.alternatives.push([content, mimetype]); return this }
}

// ---- backends ----------------------------------------------------------------------------------
async function deliver(conf: EmailSettings, msgs: EmailMessage[]): Promise<number> {
  switch (conf.backend) {
    case 'dummy': return msgs.length
    case 'memory': for (const m of msgs) { m.message(); reg.outbox.push(m) } return msgs.length   // message(): same refusals as a real send
    case 'console': for (const m of msgs) process.stdout.write(`${m.message()}\n${'-'.repeat(79)}\n`); return msgs.length
    case 'file': {
      mkdirSync(conf.filePath, { recursive: true })
      const f = join(conf.filePath, `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.log`)
      for (const m of msgs) appendFileSync(f, `${m.message()}\n${'-'.repeat(79)}\n`)
      return msgs.length
    }
    case 'smtp': return smtpSend(conf, msgs.map((m) => ({ from: parseAddr(m.from, 'From').addr, to: m.recipients(), data: m.message() })))
  }
}

// one connection for the batch (Django get_connection().send_messages)
export async function sendMessages(msgs: EmailMessage[], failSilently = false): Promise<number> {
  const todo = msgs.filter((m) => m.recipients().length)
  if (!todo.length) return 0
  try { return await deliver(reg.conf, todo) } catch (e) {
    if (failSilently) return 0
    throw e
  }
}

export interface SendMailOpts {
  subject: string; message: string; from?: string; to: string | string[]
  cc?: string | string[]; bcc?: string | string[]; replyTo?: string | string[]
  html?: string; attachments?: Attachment[]; headers?: Record<string, string>; failSilently?: boolean
}
export interface MailPending { pending: true; jobId?: string }

const build = (o: SendMailOpts): EmailMessage => {
  const m = new EmailMultiAlternatives({ subject: o.subject, body: o.message, from: o.from, to: o.to, cc: o.cc, bcc: o.bcc, replyTo: o.replyTo, headers: o.headers, attachments: o.attachments })
  if (o.html !== undefined) m.attachAlternative(o.html, 'text/html')
  return m
}

// Django send_mail. { background: true }: the tvine.tasks `tasks.sendMail` task when tvine.tasks is installed
// (enqueued after commit, retried); otherwise sent after commit in this process, failures logged.
export function sendMail(o: SendMailOpts): Promise<number>
export function sendMail(o: SendMailOpts, opts: { background: true }): Promise<MailPending>
export async function sendMail(o: SendMailOpts, opts: { background?: boolean } = {}): Promise<number | MailPending> {
  const m = build(o)
  if (!opts.background) return m.send(o.failSilently)
  m.message()   // refuse a bad header now, in the caller, not later in a worker
  return background(m)
}

const TASKS = Symbol.for('tvine.tasks.registry')
async function background(m: EmailMessage): Promise<MailPending> {
  const task = (globalThis as { [TASKS]?: Map<string, { delay(a: unknown): Promise<{ jobId: string }> }> })[TASKS]?.get('tasks.sendMail')
  if (task) return { pending: true, jobId: (await task.delay(m.toJSON())).jobId }
  onCommit(() => { setImmediate(() => { m.send().catch((e: unknown) => console.error(JSON.stringify({ level: 'error', msg: 'mail: background send failed', error: (e as Error).message }))) }) })
  return { pending: true }
}

// Django send_mass_mail: [subject, message, from, to][] over one connection
export async function sendMassMail(data: [string, string, string | undefined, string[]][], failSilently = false): Promise<number> {
  return sendMessages(data.map(([subject, body, from, to]) => new EmailMessage({ subject, body, from, to })), failSilently)
}

// Django mail_admins: settings.email.admins, from serverEmail, subject prefixed
export async function mailAdmins(subject: string, message: string, o: { html?: string; failSilently?: boolean } = {}): Promise<number> {
  const c = reg.conf
  if (!c.admins.length) return 0
  return sendMail({ subject: `${c.subjectPrefix}${subject}`, message, from: c.serverEmail, to: c.admins, html: o.html, failSilently: o.failSilently })
}
