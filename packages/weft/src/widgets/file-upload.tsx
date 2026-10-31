'use client'
import { useId, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent } from 'react'
import { defineWidget, type DefinedProps } from '../widget/defineWidget.js'
import type { ActionHandle, Control } from '../widget/types.js'
import { AutoOff, flag, headlessOf, inner, invalid, part, type Slots, type SlotProps } from './_parts.js'

// widgets/file-upload.md: native <input type=file> + a labelled drop zone. Agents send {name,type,dataBase64};
// the tab builds real Files and sets them through DataTransfer, so onChange/form submit see what a human pick
// gives. accept / maxBytes / maxFiles are checked before the input is touched (agents) and on every change
// (humans). Agent state lists name/type/size only, never contents. Headless: the form action's multipart `do`.
type C = Record<string, Control<any, any>>
type Meta = { name: string; type: string; size: number }
type S = { files: Meta[]; invalid?: string }
type FileArg = { name: string; type: string; dataBase64: string }
export type FileUploadProps = {
  name: string; label: string
  accept?: string; multiple?: boolean; maxBytes?: number; maxFiles?: number; required?: boolean
  onFilesChange?(files: File[]): void
  action?: ActionHandle
  className?: SlotProps<S>['className']; slots?: Slots<'root' | 'label' | 'dropzone' | 'list' | 'item' | 'remove' | 'error', S>
}
type Internal = FileUploadProps & { s: S }

// Visually hidden but focusable, so native `required` validation can still point at it.
const SR_ONLY = { position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' } as const
const UPLOAD_MAX = 5 * 1024 * 1024   // security.md: settings.agent.ui.uploadMaxBytes

// A file's type by extension. A MIME accept token ("image/*", "image/png") needs BOTH the declared type and the
// extension's type to match, so "evil.exe" sent as image/png is refused.
// ponytail: small fixed map; an extension missing here only passes ".ext" accept tokens. Extend as uploads need.
const EXT: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', heic: 'image/heic',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', zip: 'application/zip',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
const mimeOk = (tok: string, type: string) => tok.endsWith('/*') ? type.startsWith(tok.slice(0, -1)) : type === tok
// accept tokens: ".jpg", "image/*", "image/png" (same tokens as the browser's picker).
const accepts = (accept: string | undefined, f: Meta) => {
  if (!accept) return true
  const name = f.name.toLowerCase(), type = f.type.toLowerCase(), extType = EXT[name.slice(name.lastIndexOf('.') + 1)]
  return accept.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).some((t) =>
    t.startsWith('.') ? name.endsWith(t) : !!extType && mimeOk(t, extType) && (!type || mimeOk(t, type)))
}
// A plain file name: no path separators, no control characters, not "." / "..".
const BAD_NAME = /[\/\\\u0000-\u001f\u007f]/

function check(p: FileUploadProps, fs: Meta[]): string | undefined {
  if (!p.multiple && fs.length > 1) return 'only one file is allowed'
  if (p.maxFiles !== undefined && fs.length > p.maxFiles) return `at most ${p.maxFiles} files`
  for (const f of fs) {
    if (!f.name || f.name === '.' || f.name === '..' || BAD_NAME.test(f.name)) return `${JSON.stringify(f.name)} is not a plain file name`
    if (!accepts(p.accept, f)) return `${f.name}: type not accepted (${p.accept})`
    if (p.maxBytes !== undefined && f.size > p.maxBytes) return `${f.name} is larger than ${p.maxBytes} bytes`
  }
}
const meta = (f: File): Meta => ({ name: f.name, type: f.type, size: f.size })
const b64size = (s: string) => Math.floor((s.replace(/=+$/, '').length * 3) / 4)

function put(input: HTMLInputElement, files: File[]) {
  const dt = new DataTransfer()
  for (const f of files) dt.items.add(f)
  input.files = dt.files
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

const useFileUpload = defineWidget<Internal, S, C>({
  kind: 'file',
  state: (p) => p.s,
  controls: ({ props: p, el }) => {
    const field = (ctx: Parameters<Control['run']>[1]) => inner<HTMLInputElement>(ctx, el(), 'input[type=file]')
    const current = (ctx: Parameters<Control['run']>[1]) => [...(field(ctx).files ?? [])]
    const c: C = {
      upload: { kind: 'upload', params: { files: { type: 'file', multiple: true } }, run: async (a: { files: FileArg[] }, ctx) => {
        const fs = a.files
        if (!Array.isArray(fs) || !fs.length || fs.some((f) => !f || typeof f.name !== 'string' || typeof f.type !== 'string' || typeof f.dataBase64 !== 'string'))
          throw invalid('files', 'files: one or more {name, type, dataBase64}')
        // Sizes from the base64 length: refuse before decoding or touching the input.
        const metas = fs.map((f) => ({ name: f.name, type: f.type, size: b64size(f.dataBase64) }))
        const bad = check(p, metas) ?? (metas.reduce((n, f) => n + f.size, 0) > UPLOAD_MAX ? `files exceed ${UPLOAD_MAX} bytes` : undefined)
        if (bad) throw invalid('files', bad)
        let files: File[]
        try { files = fs.map((f) => new File([Uint8Array.from(atob(f.dataBase64), (ch) => ch.charCodeAt(0))], f.name, { type: f.type })) }
        catch { throw invalid('files', 'dataBase64 is not valid base64') }
        put(field(ctx), files)
      } },
    }
    if (p.s.files.length) {
      c.remove = { kind: 'clear', params: { name: { type: 'string', enum: p.s.files.map((f) => f.name) } },
        run: async (a: { name: string }, ctx) => {
          const fs = current(ctx), i = fs.findIndex((f) => f.name === a.name)   // the first match only, like one click on its ×
          put(field(ctx), fs.filter((_, k) => k !== i))
        } }
      c.clear = { kind: 'clear', run: async (_a, ctx) => { put(field(ctx), []) } }
    }
    return c
  },
  headless: (p) => { const h = headlessOf(p); return h ? { upload: h, remove: h, clear: h } : {} },
  describe: (p) => ({ label: p.label, summary: [[p.accept, p.maxBytes !== undefined && `≤${p.maxBytes} bytes`, p.maxFiles !== undefined && `≤${p.maxFiles} files`].filter(Boolean).join(', ')].filter(Boolean) }),
  spec: (p) => ({ name: p.name, changesContent: true }),
})

export function FileUpload(props: DefinedProps<FileUploadProps, C>) {
  const { name, label, accept, multiple, required, onFilesChange, disabled, className, slots } = props
  const [files, setFiles] = useState<File[]>([])
  const [err, setErr] = useState<string | undefined>()
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement | null>(null)
  const fid = useId()
  const s: S = { files: files.map(meta), ...(err && { invalid: err }) }
  const w = useFileUpload({ ...props, s } as Internal)

  const onChange = (e: ChangeEvent<HTMLInputElement>) => {
    const next = [...(e.target.files ?? [])]
    const bad = check(props, next.map(meta))
    setErr(bad)
    if (bad) { e.target.value = ''; if (files.length) { setFiles([]); onFilesChange?.([]) } return }   // never keep a refused file
    setFiles(next); onFilesChange?.(next)
  }
  const pickFiles = () => { if (!disabled) input.current?.click() }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFiles() } }
  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setDragging(false)
    if (!disabled && input.current && e.dataTransfer.files.length) put(input.current, [...e.dataTransfer.files])
  }
  const over = (e: DragEvent) => { e.preventDefault(); if (!disabled) setDragging(true) }

  return part('div', { ref: w.ref, ...w.props, 'data-tvine-widget': 'file', 'data-disabled': flag(disabled), 'data-invalid': flag(err), 'data-dragging': flag(dragging) }, { className, ...slots?.root }, s, <>
    {w.embed}
    <AutoOff>
      {part('label', { htmlFor: fid }, slots?.label, s, label)}
      {part('div', {
        role: 'button', tabIndex: disabled ? -1 : 0, 'aria-disabled': disabled || undefined, 'aria-label': `${label}: choose or drop files`,
        onClick: pickFiles, onKeyDown: onKey, onDragOver: over, onDragEnter: over, onDragLeave: () => setDragging(false), onDrop,
      }, slots?.dropzone, s, 'Choose or drop files')}
      <input ref={input} id={fid} type="file" name={name} accept={accept} multiple={multiple} required={required} disabled={disabled}
        aria-invalid={err ? true : undefined} aria-describedby={err ? `${fid}-e` : undefined} onChange={onChange} style={SR_ONLY} />
      {files.length > 0 && part('ul', { role: 'list' }, slots?.list, s, files.map((f) => part('li', { key: f.name, 'data-state': 'done' }, slots?.item, s, <>
        {f.name}
        {part('button', { type: 'button', disabled, 'aria-label': `Remove ${f.name}`, onClick: () => { if (input.current) put(input.current, files.filter((x) => x !== f)) } }, slots?.remove, s, '×')}
      </>)))}
      {err && part('p', { id: `${fid}-e`, role: 'alert' }, slots?.error, s, err)}
    </AutoOff>
  </>)
}
