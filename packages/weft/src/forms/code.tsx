'use client'
// Code input: a native <textarea> over a highlighted <pre> (same font metrics, the textarea text is transparent),
// a line-number gutter, Tab / Shift+Tab indent, a language label. The tokenizer is a few regexes per language
// (json / js / sql / html / css); its output is escaped text in <span class="tf-tok-*">, never markup from the value.
import { useRef, type KeyboardEvent } from 'react'
import type { FieldWidgetProps } from './types.js'

type Rule = [RegExp, string]
const STR: Rule = [/"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\.)*`?/y, 'str']
const NUM: Rule = [/-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/iy, 'num']
const RULES: Record<string, Rule[]> = {
  json: [[/"(?:[^"\\\n]|\\.)*"(?=\s*:)/y, 'key'], STR, NUM, [/\b(?:true|false|null)\b/y, 'kw'], [/[{}[\],:]/y, 'punct']],
  js: [[/\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y, 'com'], STR, NUM,
    [/\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|true|false|null|undefined|this|yield)\b/y, 'kw'], [/[{}()[\];,.=<>+\-*/!&|?:%]/y, 'punct']],
  sql: [[/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y, 'com'], [/'(?:[^']|'')*'?/y, 'str'], NUM,
    [/\b(?:select|from|where|and|or|not|insert|into|values|update|set|delete|create|table|drop|alter|join|left|right|inner|outer|on|group|by|order|having|limit|offset|as|distinct|null|is|in|like|between|union|all|case|when|then|else|end|asc|desc|primary|key|references|index)\b/iy, 'kw'], [/[(),;.*=<>]/y, 'punct']],
  html: [[/<!--[\s\S]*?(?:-->|$)/y, 'com'], [/<\/?[a-zA-Z][\w-]*/y, 'kw'], [/\s[\w-:]+(?==)/y, 'key'], [/"[^"]*"?|'[^']*'?/y, 'str'], [/\/?>/y, 'kw']],
  css: [[/\/\*[\s\S]*?(?:\*\/|$)/y, 'com'], STR, [/[\w-]+(?=\s*:)/y, 'key'], [/#[0-9a-fA-F]{3,8}\b|-?\d*\.?\d+(?:px|em|rem|%|vh|vw|s|ms)?/y, 'num'], [/[.#]?[\w-]+(?=[^{}]*\{)|@[\w-]+/y, 'kw'], [/[{}();:,>+~]/y, 'punct']],
}
RULES.ts = RULES.js!; RULES.javascript = RULES.js!; RULES.typescript = RULES.js!

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
export function highlight(code: string, lang?: string): string {
  const rules = RULES[(lang ?? '').toLowerCase()]
  if (!rules) return esc(code)
  let out = '', plain = '', i = 0
  outer: while (i < code.length) {
    for (const [re, cls] of rules) {
      re.lastIndex = i
      const m = re.exec(code)
      if (m && m[0].length) { out += esc(plain) + `<span class="tf-tok-${cls}">${esc(m[0])}</span>`; plain = ''; i += m[0].length; continue outer }
    }
    plain += code[i++]
  }
  return out + esc(plain)
}

const IND = '  '
export function CodeEditor(p: FieldWidgetProps) {
  const v: string = p.value ?? '', lang = p.meta.language
  const pre = useRef<HTMLPreElement>(null), gut = useRef<HTMLDivElement>(null)
  const lines = v.split('\n').length
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Tab' || e.altKey || e.metaKey || e.ctrlKey) return   // Esc then Tab leaves the field (keyboard users)
    e.preventDefault()
    const t = e.currentTarget, s = t.selectionStart, en = t.selectionEnd
    const ls = v.lastIndexOf('\n', s - 1) + 1
    if (!e.shiftKey && s === en) { p.onChange(v.slice(0, s) + IND + v.slice(en)); requestAnimationFrame(() => t.setSelectionRange(s + 2, s + 2)); return }
    const block = v.slice(ls, en), next = e.shiftKey ? block.replace(/^ {1,2}/gm, '') : block.replace(/^/gm, IND)
    p.onChange(v.slice(0, ls) + next + v.slice(en))
    requestAnimationFrame(() => t.setSelectionRange(ls, ls + next.length))
  }
  return <div className="tf-code" data-part="code" data-lang={lang}>
    <div className="tf-code-head">{lang ? lang.toUpperCase() : 'TEXT'} · {lines} line{lines === 1 ? '' : 's'}</div>
    <div className="tf-code-body">
      <div ref={gut} className="tf-code-gutter" aria-hidden="true">{Array.from({ length: lines }, (_, i) => <div key={i}>{i + 1}</div>)}</div>
      <div className="tf-code-area">
        <pre ref={pre} className="tf-code-hl" aria-hidden="true" dangerouslySetInnerHTML={{ __html: highlight(v, lang) + '\n' }} />
        <textarea className="tf-code-input" id={p.id} name={p.name} value={v} spellCheck={false} autoCapitalize="off" autoComplete="off" wrap="off"
          disabled={p.readOnly} required={p.meta.required} aria-invalid={p.invalid || undefined} aria-describedby={p.describedBy}
          onChange={(e) => p.onChange(e.target.value)} onKeyDown={onKey}
          onScroll={(e) => { const t = e.currentTarget; if (pre.current) { pre.current.scrollTop = t.scrollTop; pre.current.scrollLeft = t.scrollLeft } if (gut.current) gut.current.scrollTop = t.scrollTop }} />
      </div>
    </div>
  </div>
}
