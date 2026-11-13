/**
 * dsh-skill-injector — client half (browser bundle).
 *
 * Polls `/dsh-skill-injector/api` every 5s and renders into two DSH seats:
 *   - settings.section (id `dsh-skill-injector`) — checkbox list + mode radio + save
 *   - conversation.composer.dock (id `dsh-skill-injector-dock`) — active-skills line
 *
 * Ships as exports["./client"] (a CJS ModuleLoader factory) and is discovered
 * through the `dsh.client` declaration in package.json. It talks to the host
 * over HTTP only; all state lives in the host's Config.
 */
import React from 'react'
import type { Context } from '@deepseek-ai/cordis'
// Explicit `.ts` specifier: the client entry resolves this file itself and
// inlines it. With `../helpers.js` (the node entries' convention) rolldown
// leaves a `require("../helpers.js")` in the browser bundle, which the module
// table cannot resolve at runtime.
import { cachedSuffix } from '../helpers.ts'

export const inject = ['slots']

const POLL_MS = 5000
const API = '/dsh-skill-injector/api'
const API_CONFIG = '/dsh-skill-injector/api/config'
/** Sidebar entry id and the `main` panel key are the same value, by contract. */
const PANEL_ID = 'dsh-skill-injector'

interface AvailableSkill {
  name: string
  description: string
}

/** One selected skill the host could not inject. `cached` means the last
 *  successfully loaded body is still being injected in its place. */
interface ClassifiedSkill {
  name: string
  state: string
  reason?: string
  /** Omitted by a host that predates this field. */
  cached?: boolean
}

interface Snapshot {
  ok: boolean
  error?: string
  mode: 'each-prompt' | 'start-only'
  selected: string[]
  available: AvailableSkill[]
  unresolved: ClassifiedSkill[]
  injected: string[]
  /** Host-decided: Remove is offered only after a scoped resolve has run. */
  canRemove: boolean
  /** Omitted by a host that predates the dock toggle; treated as `true`. */
  showDock?: boolean
}

export function apply(ctx: Context): void {
  const slots = ctx.get('slots') as
    | {
        inject(name: string, callback: () => () => void): () => void
        register(
          options: {
            name: string
            id?: string
            key?: string
            order?: number
            label?: string
            locale?: string
            inject?: () => Record<string, unknown>
          },
          component: (props: unknown) => React.ReactNode,
        ): () => void
      }
    | undefined
  if (slots === undefined) return

  const layout = ctx.get('layout') as
    | { selectPanel(id: string | null): void }
    | undefined

  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-skill-injector'
  style.textContent = [
    '.dsi-dash{display:flex;flex-direction:column;gap:14px;padding:8px 0;color:var(--dsw-alias-label-primary)}',
    '.dsi-title{font-size:16px;font-weight:600}',
    '.dsi-sub{font-size:12px;opacity:.55}',
    '.dsi-list{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}',
    '.dsi-item{display:flex;align-items:flex-start;gap:8px;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}',
    '.dsi-item input{margin-top:2px}',
    '.dsi-item-name{font-size:13px;font-weight:600}',
    '.dsi-item-desc{font-size:12px;opacity:.6}',
    '.dsi-modes{display:flex;gap:16px;font-size:13px}',
    '.dsi-modes label{display:flex;gap:6px;align-items:center}',
    '.dsi-save{padding:6px 16px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}',
    '.dsi-status{font-size:12px;opacity:.7}',
    '.dsi-error{color:var(--dsw-alias-state-error-primary);font-size:12px}',
    '.dsi-urow{display:flex;align-items:center;gap:8px;font-size:12px}',
    '.dsi-urow>.dsi-status{flex:1;min-width:0;overflow-wrap:anywhere}',
    '.dsi-mini{padding:2px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px}',
    '.dsi-mini:disabled{opacity:.5;cursor:default}',
    '.dsi-note{padding:16px;opacity:.7}',
    '.dsi-dock{font-size:12px;opacity:.65;padding:2px 0;white-space:nowrap}',
    '.dsi-glyph{display:block}',
    '.dsi-page{display:flex;flex-direction:column;gap:12px;padding:20px 24px;height:100%;overflow:auto;color:var(--dsw-alias-label-primary)}',
    '.dsi-page-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
    '.dsi-page-title{font-size:16px;font-weight:600}',
    '.dsi-page-body{max-width:720px;width:100%}',
  ].join('')
  document.head.appendChild(style)
  ctx.effect(() => () => {
    style.remove()
  })

  let snapshot: Snapshot | null = null
  /** Monotonic request id: a slow response must never overwrite a newer one. */
  let pollSeq = 0
  const listeners = new Set<() => void>()

  /** Normalize a host body: this bundle can outlive the host that served it. */
  function normalize(raw: Partial<Snapshot>): Snapshot {
    return {
      ok: raw.ok === true,
      error: raw.error,
      mode: raw.mode === 'start-only' ? 'start-only' : 'each-prompt',
      selected: raw.selected ?? [],
      available: raw.available ?? [],
      unresolved: raw.unresolved ?? [],
      injected: raw.injected ?? [],
      canRemove: raw.canRemove === true,
      // Only an explicit `false` hides the line, so an older host that omits
      // the field keeps the pre-toggle behaviour.
      showDock: raw.showDock !== false,
    }
  }

  async function poll(): Promise<void> {
    const seq = ++pollSeq
    let next: Snapshot
    try {
      const res = await fetch(API, { cache: 'no-store' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      next = normalize((await res.json()) as Partial<Snapshot>)
    } catch (e) {
      next = {
        ok: false,
        error: String((e as Error)?.message ?? e),
        mode: 'each-prompt',
        selected: [],
        available: [],
        unresolved: [],
        injected: [],
        canRemove: false,
        showDock: true,
      }
    }
    if (seq !== pollSeq) return // superseded by a newer request
    snapshot = next
    for (const fn of listeners) fn()
  }
  void poll()
  const timer = setInterval(() => void poll(), POLL_MS)
  ctx.effect(() => () => {
    clearInterval(timer)
    listeners.clear()
  })

  function useSnapshot(): Snapshot | null {
    const [state, setState] = React.useState<Snapshot | null>(snapshot)
    React.useEffect(() => {
      const fn = () => setState(snapshot)
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    }, [])
    return state
  }

  function SettingsPanel(props: { bare?: boolean }): React.ReactElement | null {
    const bare = props.bare === true
    const snap = useSnapshot()
    const h = React.createElement
    const [selected, setSelected] = React.useState<string[]>(snap?.selected ?? [])
    const [mode, setMode] = React.useState<'each-prompt' | 'start-only'>(snap?.mode ?? 'each-prompt')
    const [showDock, setShowDock] = React.useState<boolean>(snap?.showDock ?? true)
    const [saving, setSaving] = React.useState(false)
    const [checking, setChecking] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)
    const [saved, setSaved] = React.useState(false)

    // Keep local state in sync when a poll brings a newer selection.
    React.useEffect(() => {
      if (snap === null) return
      setSelected(snap.selected)
      setMode(snap.mode)
      setShowDock(snap.showDock !== false)
    }, [snap?.mode, JSON.stringify(snap?.selected), snap?.showDock])

    function toggle(name: string, checked: boolean): void {
      setSaved(false)
      setSelected((prev) => (checked ? [...prev, name] : prev.filter((n) => n !== name)))
    }

    async function save(next?: string[]): Promise<void> {
      setSaving(true)
      setError(null)
      try {
        const res = await fetch(API_CONFIG, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mode, selected: next ?? selected, showDock }),
        })
        const body = (await res.json()) as { ok: boolean; error?: string }
        if (!body.ok) throw new Error(body.error ?? 'HTTP ' + res.status)
        setSaved(true)
        void poll()
      } catch (e) {
        setError(String((e as Error)?.message ?? e))
      } finally {
        setSaving(false)
      }
    }

    /** Remove a name the host could not resolve — the only way out of a stale selection. */
    async function remove(name: string): Promise<void> {
      const next = selected.filter((n) => n !== name)
      setSelected(next)
      setSaved(false)
      await save(next)
    }

    /** Re-run the same refresh the 5s poll performs, with visible feedback. */
    async function retry(): Promise<void> {
      setChecking(true)
      setSaved(false)
      try {
        await Promise.all([poll(), new Promise((resolve) => setTimeout(resolve, 400))])
      } finally {
        setChecking(false)
      }
    }

    if (snap === null) return h('div', { className: 'dsi-note' }, 'Loading skills…')
    if (!snap.ok) return h('div', { className: 'dsi-note dsi-error' }, 'Skill Injector unavailable: ' + String(snap.error))

    return h(
      'div',
      { className: 'dsi-dash' },
      bare ? null : h('div', { className: 'dsi-title' }, 'Skill Injector'),
      bare ? null : h('div', { className: 'dsi-sub' }, 'Inject chosen skills into every session. Choose skills and mode, then Save.'),
      h(
        'div',
        { className: 'dsi-list' },
        snap.available.map((skill) =>
          h(
            'label',
            { key: skill.name, className: 'dsi-item' },
            h('input', {
              type: 'checkbox',
              checked: selected.includes(skill.name),
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => toggle(skill.name, e.target.checked),
            }),
            h(
              'div',
              null,
              h('div', { className: 'dsi-item-name' }, skill.name),
              h('div', { className: 'dsi-item-desc' }, skill.description),
            ),
          ),
        ),
      ),
      snap.unresolved.length > 0
        ? h(
            'div',
            { className: 'dsi-list' },
            h('div', { className: 'dsi-sub' }, 'Unresolved (' + snap.unresolved.length + '):'),
            h(
              'ul',
              { className: 'dsi-list' },
              snap.unresolved.map((u) =>
                h(
                  'li',
                  { key: u.name, className: 'dsi-urow' },
                  h('span', { className: 'dsi-item-name' }, u.name),
                  h(
                    'span',
                    { className: 'dsi-status' },
                    (u.reason || u.state) +
                      cachedSuffix({ mode: snap.mode, injected: snap.injected, name: u.name, cached: u.cached }),
                  ),
                  h(
                    'button',
                    {
                      className: 'dsi-mini',
                      'aria-label': 'Retry ' + u.name,
                      onClick: () => void retry(),
                      disabled: checking,
                    },
                    checking ? 'Checking…' : 'Retry',
                  ),
                  snap.canRemove
                    ? h(
                        'button',
                        {
                          className: 'dsi-mini',
                          'aria-label': 'Remove ' + u.name,
                          onClick: () => void remove(u.name),
                          disabled: saving,
                        },
                        'Remove',
                      )
                    : null,
                ),
              ),
            ),
          )
        : null,
      h(
        'div',
        { className: 'dsi-modes' },
        h('label', null, h('input', { type: 'radio', name: 'dsi-mode', checked: mode === 'each-prompt', onChange: () => setMode('each-prompt') }), 'Inject every prompt'),
        h('label', null, h('input', { type: 'radio', name: 'dsi-mode', checked: mode === 'start-only', onChange: () => setMode('start-only') }), 'Inject once at session start'),
      ),
      h(
        'label',
        { className: 'dsi-modes' },
        h('input', {
          type: 'checkbox',
          checked: showDock,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
            setSaved(false)
            setShowDock(e.target.checked)
          },
        }),
        'Show the injected-skills line under the composer',
      ),
      h('button', { className: 'dsi-save', onClick: () => void save(), disabled: saving }, saving ? 'Saving…' : 'Save'),
      error !== null ? h('div', { className: 'dsi-error' }, error) : null,
      saved ? h('div', { className: 'dsi-status' }, 'Saved') : null,
      h(
        'div',
        { className: 'dsi-status' },
        'Active in this session: ' + (snap.injected.length > 0 ? snap.injected.join(', ') : 'none'),
      ),
    )
  }

  function DockLine(): React.ReactElement | null {
    const snap = useSnapshot()
    if (snap === null || !snap.ok) return null
    // User opt-out: the settings page carries the same information inline.
    if (snap.showDock === false) return null
    const names = snap.selected.length > 0 ? snap.selected.join(', ') : 'none'
    const unresolved = snap.unresolved.length
    return React.createElement(
      'div',
      { className: 'dsi-dock' },
      'Injected Skills: ' + names + ' · Mode: ' + snap.mode + (unresolved > 0 ? ' · ' + unresolved + ' unresolved' : ''),
    )
  }

  /** Left-sidebar nav icon: receives `{ size, active }` from `sidebar.panellist`. */
  function SkillsGlyph({ size = 16, active = false }: { size?: number; active?: boolean }): React.ReactElement {
    return React.createElement(
      'svg',
      {
        className: 'dsi-glyph',
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: active ? 1.8 : 1.4,
        strokeLinejoin: 'round',
        'aria-hidden': true,
      },
      React.createElement('path', {
        d: 'M8 2.2 9.6 5.7 13.4 6.2 10.7 8.8 11.3 12.6 8 10.8 4.7 12.6 5.3 8.8 2.6 6.2 6.4 5.7Z',
      }),
    )
  }

  /** Full-page panel opened from the sidebar entry; replaces the conversation area. */
  function SkillsPage(): React.ReactElement {
    const h = React.createElement
    return h(
      'div',
      { className: 'dsi-page' },
      h(
        'div',
        { className: 'dsi-page-header' },
        h('div', { className: 'dsi-page-title' }, 'Skill Injector'),
        h(
          'button',
          {
            className: 'dsi-mini',
            onClick: () => layout?.selectPanel(null),
          },
          'Back to conversation',
        ),
      ),
      h('div', { className: 'dsi-page-body' }, h(SettingsPanel, { bare: true })),
    )
  }

  // `slots.inject` owns the lifetime: its registrations are disposed when the
  // declaration collapses and reinstalled when it returns.
  slots.inject('settings.section', () =>
    slots.register(
      { name: 'settings.section', id: 'dsh-skill-injector', order: 60, label: 'Skill Injector' },
      () => React.createElement(SettingsPanel),
    ),
  )
  slots.inject('conversation.composer.dock', () =>
    slots.register(
      { name: 'conversation.composer.dock', id: 'dsh-skill-injector-dock', order: 10 },
      () => React.createElement(DockLine),
    ),
  )
  // Left-sidebar navigation entry. Its click selects the `main` panel keyed by
  // the same id; `layout.selectPanel` throws when that key is not registered,
  // so the entry and its target are always registered together.
  slots.inject('sidebar.panellist', () =>
    slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: 'Skill Injector' },
      (props) => React.createElement(SkillsGlyph, props as { size?: number; active?: boolean }),
    ),
  )
  slots.inject('main', () =>
    slots.register({ name: 'main', key: PANEL_ID }, () => React.createElement(SkillsPage)),
  )
}
