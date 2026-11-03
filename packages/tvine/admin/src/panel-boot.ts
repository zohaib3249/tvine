// Shared browser bootstrap for admin + shield panel shells (serve.ts stamps data-base / data-tvine-header).
import { devReload } from '../../weft/dist/runtime/devReload.js'

export function panelRoot(id: string): HTMLElement {
  return document.getElementById(id)!
}

export function panelBase(el: HTMLElement, fallback: string): string {
  return (el.dataset.base ?? fallback).replace(/\/$/, '')
}

export function panelHeader(): string {
  return document.documentElement.getAttribute('data-tvine-header') ?? 'x-tvine'
}

/** tvine dev only: shell sets data-dev-reload on the root. */
export function panelDevReload(el: HTMLElement): void {
  if (el.dataset.devReload) devReload(el.dataset.devReload)
}

export function panelQuery(): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(location.search))
}

export function panelSegments(base: string): string[] {
  return location.pathname.slice(base.length).split('/').filter(Boolean)
}
