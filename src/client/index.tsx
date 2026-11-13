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
const GITHUB_URL = 'https://github.com/Ts-sound/dsh-skill-injector'
const BLURB = 'Auto-inject the skills you choose into every DSH session.'

/**
 * Directory label for one catalog row: the path below the nearest `skills`
 * root. A skill at `<root>/skills/diagram-design/SKILL.md` groups under
 * `Other`; one at `<root>/skills/skills-tong/engineering/grill-me/SKILL.md`
 * groups under `skills-tong / engineering`.
 */
function skillDirectory(path: string | undefined): string {
  if (path === undefined) return 'Other'
  const parts = path.replace(/\\/g, '/').split('/')
  // Drop `SKILL.md` and the skill's own directory to get its category directory.
  const dir = parts.slice(0, -2).join('/')
  const marker = '/skills/'
  const at = dir.lastIndexOf(marker)
  const rel = at >= 0 ? dir.slice(at + marker.length) : (dir.split('/').pop() ?? '')
  return rel === '' ? 'Other' : rel.split('/').join(' / ')
}

/** Top-level split of the catalog: global roots, project roots, everything else. */
type SkillScope = '全局空间' | '项目工具' | '其他'

const SCOPE_ORDER: SkillScope[] = ['全局空间', '项目工具', '其他']

function scopeOf(source: string | undefined): SkillScope {
  if (source === 'project-dsh' || source === 'project-agents') return '项目工具'
  if (source === undefined) return '其他'
  return '全局空间'
}

/** Mirrors the host's merge rule: base first, additions after, deduped and capped. */
const MAX_PREVIEW = 16

function mergePreview(base: string[], extra: string[]): string[] {
  const out: string[] = []
  for (const name of [...base, ...extra]) {
    if (!out.includes(name)) out.push(name)
  }
  return out.slice(0, MAX_PREVIEW)
}

/** Stable display order: alphabetical, with ungrouped rows last. */
function groupAvailable(
  available: AvailableSkill[],
): Array<{ scope: SkillScope; groups: Array<{ label: string; skills: AvailableSkill[] }> }> {
  const byName = (a: AvailableSkill, b: AvailableSkill): number => a.name.localeCompare(b.name)
  const scopes = new Map<SkillScope, Map<string, AvailableSkill[]>>()
  for (const skill of available) {
    const scope = scopeOf(skill.source)
    const label = skillDirectory(skill.path)
    const groups = scopes.get(scope) ?? new Map<string, AvailableSkill[]>()
    const bucket = groups.get(label)
    if (bucket === undefined) groups.set(label, [skill])
    else bucket.push(skill)
    scopes.set(scope, groups)
  }
  return SCOPE_ORDER.filter((scope) => scopes.has(scope)).map((scope) => ({
    scope,
    groups: [...(scopes.get(scope) ?? new Map<string, AvailableSkill[]>()).entries()]
      .map(([label, skills]) => ({ label, skills: skills.sort(byName) }))
      .sort((a, b) =>
        a.label === 'Other' ? (b.label === 'Other' ? 0 : 1) : b.label === 'Other' ? -1 : a.label.localeCompare(b.label),
      ),
  }))
}

interface AvailableSkill {
  name: string
  description: string
  /** Absolute SKILL.md path when the provider supplies one; used only for grouping. */
  path?: string
  /** Discovery source (`project-dsh`, `user-agents`, …); splits global from project skills. */
  source?: string
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
  /** The GLOBAL selection (what the panel edits under the global target). */
  selected: string[]
  /** Global + the active workspace's additions: what this session receives. */
  effective: string[]
  /** True when the merge hit MAX_SELECTED and some workspace skills were dropped. */
  truncated: boolean
  /** Workspaces the panel may target; empty when no registry is mounted. */
  workspaces: WorkspaceRow[]
  /** The workspace this session resolves to, or null outside every workspace. */
  activeWorkspaceId: string | null
  available: AvailableSkill[]
  unresolved: ClassifiedSkill[]
  injected: string[]
  /** Host-decided: Remove is offered only after a scoped resolve has run. */
  canRemove: boolean
  /** Omitted by a host that predates the dock toggle; treated as `true`. */
  showDock?: boolean
}

/** One registry workspace plus the additions stored for it. */
interface WorkspaceRow {
  id: string
  title: string
  path: string
  selection: string[]
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
    '.dsi-dash{display:flex;flex-direction:column;gap:14px;padding:8px 0;width:100%;max-width:720px;margin:0 auto;color:var(--dsw-alias-label-primary)}',
    '.dsi-title{font-size:16px;font-weight:600}',
    '.dsi-sub{font-size:12px;opacity:.55}',
    '.dsi-lead{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12px;opacity:.7}',
    '.dsi-lead a{color:inherit;text-decoration:underline}',
    '.dsi-section{display:flex;flex-direction:column;gap:4px}',
    '.dsi-section-title{display:flex;align-items:center;gap:6px;width:100%;padding:6px 0;margin:0;background:none;border:0;color:inherit;text-align:left;cursor:pointer;font-size:12px;font-weight:600;letter-spacing:.04em;opacity:.6;text-transform:uppercase}',
    '.dsi-section-title:hover{opacity:.9}',
    '.dsi-section-body{display:flex;flex-direction:column;gap:10px;padding:2px 0 6px 12px;border-left:1px solid var(--dsw-alias-border-l1)}',
    '.dsi-group{display:flex;flex-direction:column;gap:6px}',
    '.dsi-group-title{display:flex;align-items:center;gap:7px;width:100%;padding:6px 8px;margin:0 0 0 -8px;background:none;border:0;border-radius:6px;color:inherit;text-align:left;cursor:pointer;font-size:15px;font-weight:650;letter-spacing:.01em;opacity:.92;line-height:1.4}',
    '.dsi-group-title:hover{opacity:1;background:var(--dsw-alias-bg-layer-1)}',
    '.dsi-caret{display:inline-block;width:14px;font-size:14px;opacity:.8}',
    '.dsi-group-count{margin-left:auto;font-size:12px;font-weight:400;opacity:.6;font-variant-numeric:tabular-nums}',
    '.dsi-target{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12px}',
    '.dsi-target-label{font-size:12px;font-weight:600;opacity:.6;letter-spacing:.04em;text-transform:uppercase}',
    '.dsi-select{max-width:100%;padding:4px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px}',
    '.dsi-target-hint{font-size:12px;opacity:.6}',
    '.dsi-badge{margin-left:6px;padding:0 5px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);font-size:10px;font-weight:500;opacity:.7;letter-spacing:.03em;text-transform:none}',
    '.dsi-warn{padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-state-warning-primary,#b8860b);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#b8860b) 12%,transparent);font-size:12px}',
    '.dsi-list{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none}',
    '.dsi-item{display:flex;align-items:flex-start;gap:8px;padding:8px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1)}',
    '.dsi-item input{margin-top:2px}',
    '.dsi-item-name{font-size:13px;font-weight:600}',
    '.dsi-item-desc{font-size:12px;opacity:.6}',
    '.dsi-modes{display:flex;gap:16px;font-size:13px}',
    '.dsi-modes label{display:flex;gap:6px;align-items:center}',
    '.dsi-save{padding:6px 16px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}',
    '.dsi-status{font-size:12px;opacity:.7}',
    '.dsi-hint{font-size:12px;opacity:.55}',
    '.dsi-error{color:var(--dsw-alias-state-error-primary);font-size:12px}',
    '.dsi-urow{display:flex;align-items:center;gap:8px;font-size:12px}',
    '.dsi-urow>.dsi-status{flex:1;min-width:0;overflow-wrap:anywhere}',
    '.dsi-mini{padding:2px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12px}',
    '.dsi-mini:disabled{opacity:.5;cursor:default}',
    '.dsi-note{padding:16px;opacity:.7}',
    '.dsi-dock{font-size:12px;opacity:.65;padding:2px 0;white-space:nowrap}',
    '.dsi-glyph{display:block}',
    '.dsi-page{display:flex;flex-direction:column;gap:12px;padding:20px 24px;height:100%;overflow:auto;color:var(--dsw-alias-label-primary)}',
    '.dsi-page-inner{display:flex;flex-direction:column;gap:12px;width:100%;max-width:720px;margin:0 auto}',
    '.dsi-page-header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
    '.dsi-page-title{font-size:16px;font-weight:600}',
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
    const selected = Array.isArray(raw.selected) ? raw.selected : []
    return {
      ok: raw.ok === true,
      error: raw.error,
      mode: raw.mode === 'start-only' ? 'start-only' : 'each-prompt',
      selected,
      // A host that predates workspaces has no `effective`, so the global list
      // is the truthful fallback.
      effective: Array.isArray(raw.effective) ? raw.effective : selected,
      truncated: raw.truncated === true,
      workspaces: Array.isArray(raw.workspaces)
        ? raw.workspaces
            .filter((row) => typeof row?.id === 'string' && typeof row?.path === 'string')
            .map((row) => ({
              id: row.id,
              title: typeof row.title === 'string' && row.title !== '' ? row.title : row.id,
              path: row.path,
              selection: Array.isArray(row.selection) ? row.selection.filter((n) => typeof n === 'string') : [],
            }))
        : [],
      activeWorkspaceId: typeof raw.activeWorkspaceId === 'string' ? raw.activeWorkspaceId : null,
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
        effective: [],
        truncated: false,
        workspaces: [],
        activeWorkspaceId: null,
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
    // Per-workspace additions, mirrored locally and saved as a whole map.
    const [workspaces, setWorkspaces] = React.useState<Record<string, string[]>>({})
    /** '' edits the global list; a workspace id edits that workspace's additions. */
    const [target, setTarget] = React.useState<string>('')
    const [saving, setSaving] = React.useState(false)
    const [checking, setChecking] = React.useState(false)
    const [error, setError] = React.useState<string | null>(null)
    const [saved, setSaved] = React.useState(false)
    // Sections and their directory groups start collapsed; state is per panel
    // instance, keyed by `section:<scope>` and `group:<scope>::<label>`.
    const [openGroups, setOpenGroups] = React.useState<Record<string, boolean>>({})

    // Keep local state in sync when a poll brings a newer selection.
    React.useEffect(() => {
      if (snap === null) return
      setSelected(snap.selected)
      setMode(snap.mode)
      setShowDock(snap.showDock !== false)
      setWorkspaces(Object.fromEntries(snap.workspaces.map((row) => [row.id, row.selection])))
      // A workspace that disappeared while being edited falls back to global.
      setTarget((prev) => (prev !== '' && !snap.workspaces.some((row) => row.id === prev) ? '' : prev))
    }, [snap?.mode, JSON.stringify(snap?.selected), snap?.showDock, JSON.stringify(snap?.workspaces)])

    const extra = target === '' ? [] : (workspaces[target] ?? [])
    // Bottom status follows the *target*: what the global list injects, or what
    // the chosen workspace receives after merging its additions onto the base.
    const preview = target === '' ? selected : mergePreview(selected, extra)
    const previewTitle = target === '' ? '' : (snap?.workspaces.find((row) => row.id === target)?.title ?? target)

    /** Checked means "injected for this target": global rows are a locked base. */
    function isChecked(name: string): boolean {
      return target === '' ? selected.includes(name) : selected.includes(name) || extra.includes(name)
    }

    /** Under a workspace target, global names are shown but cannot be unticked here. */
    function isLocked(name: string): boolean {
      return target !== '' && selected.includes(name)
    }

    function toggle(name: string, checked: boolean): void {
      setSaved(false)
      if (target === '') {
        setSelected((prev) => (checked ? [...prev, name] : prev.filter((n) => n !== name)))
        return
      }
      setWorkspaces((prev) => {
        const current = prev[target] ?? []
        const next = checked ? [...current, name] : current.filter((n) => n !== name)
        return { ...prev, [target]: next }
      })
    }

    async function save(overrides?: { selected?: string[]; workspaces?: Record<string, string[]> }): Promise<void> {
      setSaving(true)
      setError(null)
      try {
        const res = await fetch(API_CONFIG, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            mode,
            selected: overrides?.selected ?? selected,
            showDock,
            workspaces: overrides?.workspaces ?? workspaces,
          }),
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
      setSaved(false)
      if (target === '') {
        const next = selected.filter((n) => n !== name)
        setSelected(next)
        await save({ selected: next })
        return
      }
      const nextWorkspaces = { ...workspaces, [target]: (workspaces[target] ?? []).filter((n) => n !== name) }
      setWorkspaces(nextWorkspaces)
      await save({ workspaces: nextWorkspaces })
    }

    /** Drop this workspace's additions; the global selection still applies there. */
    async function clearWorkspace(): Promise<void> {
      if (target === '') return
      const next = { ...workspaces }
      delete next[target]
      setWorkspaces(next)
      setSaved(false)
      await save({ workspaces: next })
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

    function toggleOpen(key: string): void {
      setOpenGroups((prev) => ({ ...prev, [key]: prev[key] !== true }))
    }

    return h(
      'div',
      { className: 'dsi-dash' },
      bare ? null : h('div', { className: 'dsi-title' }, 'Skill Injector'),
      bare ? null : h('div', { className: 'dsi-sub' }, 'Inject chosen skills into every session. Choose skills and mode, then Save.'),
      bare ? null : h(Lead),
      snap.truncated
        ? h(
            'div',
            { className: 'dsi-warn' },
            'Skill cap reached (16): some workspace skills are not injected. Untick a few to make room.',
          )
        : null,
      snap.workspaces.length > 0
        ? h(
            'div',
            { className: 'dsi-target' },
            h('span', { className: 'dsi-target-label' }, 'Injection target'),
            h(
              'select',
              {
                className: 'dsi-select',
                value: target,
                onChange: (e: React.ChangeEvent<HTMLSelectElement>) => {
                  setTarget(e.target.value)
                  setSaved(false)
                },
              },
              h('option', { value: '' }, '全局 (all sessions)'),
              snap.workspaces.map((row) =>
                h(
                  'option',
                  { key: row.id, value: row.id },
                  row.title + (row.selection.length > 0 ? ' (+' + row.selection.length + ')' : '') + ' — ' + row.path,
                ),
              ),
            ),
            target !== '' ? h('span', { className: 'dsi-target-hint' }, 'adds on top of the global selection') : null,
          )
        : null,
      h(
        'div',
        null,
        groupAvailable(snap.available).map((section) => {
          const sectionOpen = openGroups['section:' + section.scope] === true
          const sectionTotal = section.groups.reduce((n, group) => n + group.skills.length, 0)
          const sectionPicked = section.groups.reduce(
            (n, group) => n + group.skills.filter((skill) => isChecked(skill.name)).length,
            0,
          )
          return h(
            'div',
            { key: section.scope, className: 'dsi-section' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsi-section-title',
                'aria-expanded': sectionOpen,
                onClick: () => toggleOpen('section:' + section.scope),
              },
              h('span', { className: 'dsi-caret' }, sectionOpen ? '\u25be' : '\u25b8'),
              h('span', null, section.scope),
              h('span', { className: 'dsi-group-count' }, (sectionPicked > 0 ? sectionPicked + '/' : '') + sectionTotal),
            ),
            sectionOpen
              ? h(
                  'div',
                  { className: 'dsi-section-body' },
                  section.groups.map((group) => {
                    const key = 'group:' + section.scope + '::' + group.label
                    const open = openGroups[key] === true
                    const picked = group.skills.filter((skill) => isChecked(skill.name)).length
                    return h(
                      'div',
                      { key: group.label, className: 'dsi-group' },
                      h(
                        'button',
                        { type: 'button', className: 'dsi-group-title', 'aria-expanded': open, onClick: () => toggleOpen(key) },
                        h('span', { className: 'dsi-caret' }, open ? '\u25be' : '\u25b8'),
                        h('span', null, group.label),
                        h('span', { className: 'dsi-group-count' }, (picked > 0 ? picked + '/' : '') + group.skills.length),
                      ),
                      open
                        ? h(
                            'div',
                            { className: 'dsi-list' },
                            group.skills.map((skill) =>
                              h(
                                'label',
                                { key: skill.name, className: 'dsi-item' },
                                h('input', {
                                  type: 'checkbox',
                                  checked: isChecked(skill.name),
                                  disabled: isLocked(skill.name),
                                  onChange: (e: React.ChangeEvent<HTMLInputElement>) => toggle(skill.name, e.target.checked),
                                }),
                                h(
                                  'div',
                                  null,
                                  h(
                                    'div',
                                    { className: 'dsi-item-name' },
                                    skill.name,
                                    isLocked(skill.name) ? h('span', { className: 'dsi-badge' }, 'global') : null,
                                  ),
                                  h('div', { className: 'dsi-item-desc' }, skill.description),
                                ),
                              ),
                            ),
                          )
                        : null,
                    )
                  }),
                )
              : null,
          )
        }),
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
      target !== ''
        ? h(
            'button',
            { className: 'dsi-mini', onClick: () => void clearWorkspace(), disabled: saving || extra.length === 0 },
            'Clear this workspace’s additions',
          )
        : null,
      h('button', { className: 'dsi-save', onClick: () => void save(), disabled: saving }, saving ? 'Saving…' : 'Save'),
      error !== null ? h('div', { className: 'dsi-error' }, error) : null,
      saved ? h('div', { className: 'dsi-status' }, 'Saved') : null,
      h(
        'div',
        { className: 'dsi-status' },
        (target === '' ? 'Global injection: ' : 'Workspace injection (' + previewTitle + '): ') +
          (preview.length > 0 ? preview.join(', ') : 'none'),
      ),
      target === '' ? null : h('div', { className: 'dsi-hint' }, 'This session receives (host): ' + (snap.effective.length > 0 ? snap.effective.join(', ') : 'none')),
    )
  }

  function DockLine(): React.ReactElement | null {
    const snap = useSnapshot()
    if (snap === null || !snap.ok) return null
    // User opt-out: the settings page carries the same information inline.
    if (snap.showDock === false) return null
    const names = snap.effective.length > 0 ? snap.effective.join(', ') : 'none'
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

  /** One-line plugin identity: what it does plus the repository link. */
  function Lead(): React.ReactElement {
    return React.createElement(
      'div',
      { className: 'dsi-lead' },
      React.createElement('span', null, BLURB),
      React.createElement('a', { href: GITHUB_URL, target: '_blank', rel: 'noreferrer' }, 'GitHub ↗'),
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
        { className: 'dsi-page-inner' },
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
        h(Lead),
        h(SettingsPanel, { bare: true }),
      ),
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
