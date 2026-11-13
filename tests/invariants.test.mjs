/**
 * Key invariants for dsh-skill-injector — the ~16 contracts from
 * docs/design/README.md, written before the implementation (red first).
 *
 * Contract tests 1-7 cover the pure helpers in src/helpers.ts; tests 8-16 the
 * host half in src/index.ts (appended by Task 4). Tests run against the build
 * output (`lib/`), so `pnpm build` must run first.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  MAX_SELECTED,
  isSkillName,
  validateSelection,
  escapePromptBraces,
  buildInjectionMessage,
  classifySelection,
  applyBodies,
  cachedSuffix,
  mergeSelection,
  workspaceForCwd,
} from '../lib/helpers.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = JSON.parse(readFileSync(join(here, 'fixtures', 'sample-skill.json'), 'utf8'))

// --- Contract 1: validateSelection ---------------------------------------
test('contract 1: validateSelection validates, dedupes, caps, and defaults showDock', () => {
  const ok = validateSelection({ mode: 'each-prompt', selected: ['caveman', 'ponytail', 'caveman'] })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.config, { mode: 'each-prompt', selected: ['caveman', 'ponytail'], showDock: true })

  const many = Array.from({ length: MAX_SELECTED + 1 }, (_, i) => 'skill-' + i)
  const over = validateSelection({ mode: 'each-prompt', selected: many })
  assert.equal(over.ok, false)
  assert.match(over.error, /16/)

  const capAfterDedupe = validateSelection({ mode: 'each-prompt', selected: [...many.slice(0, MAX_SELECTED), 'skill-0'] })
  assert.equal(capAfterDedupe.ok, true)

  assert.equal(validateSelection({ mode: 'start-only', selected: ['Caveman'] }).ok, false)
  assert.match(validateSelection({ mode: 'start-only', selected: ['Caveman'] }).error, /kebab/)
  assert.equal(validateSelection({ mode: 'sometimes', selected: [] }).ok, false)
  assert.match(validateSelection({ mode: 'sometimes', selected: [] }).error, /mode/)
  assert.equal(validateSelection({ mode: 'each-prompt', selected: [], showDock: 'yes' }).ok, false)

  const off = validateSelection({ mode: 'each-prompt', selected: [], showDock: false })
  assert.equal(off.config.showDock, false)
  assert.equal(validateSelection({ mode: 'each-prompt', selected: [] }).config.showDock, true)
})

// --- Contract 2: escapePromptBraces -------------------------------------
test('contract 2: escapePromptBraces escapes only double open braces', () => {
  assert.equal(escapePromptBraces('use {{model}} here'), 'use &#123;&#123;model}} here')
  assert.equal(escapePromptBraces('{{a}} and {{b}}'), '&#123;&#123;a}} and &#123;&#123;b}}')
  assert.equal(escapePromptBraces('no braces'), 'no braces')
})

// --- Contract 3: buildInjectionMessage ----------------------------------
test('contract 3: buildInjectionMessage returns the skill-invocation shape', () => {
  const rendered = '<skill_content name="' + fixture.name + '">' + fixture.content + '</skill_content>'
  const msg = buildInjectionMessage(fixture.name, rendered)
  assert.deepEqual(msg, {
    content: [{ type: 'text', text: rendered }],
    source: { kind: 'skill-invocation', name: 'caveman', form: 'instructions' },
  })
})

// --- Contract 4: classifySelection --------------------------------------
test('contract 4: classifySelection maps five states; incomplete/unscoped never unknown', () => {
  const ready = classifySelection({
    selected: ['alpha', 'ghost', 'beta'],
    catalog: { kind: 'scoped', names: ['alpha', 'beta'], complete: true },
    scoped: true,
    loads: new Map([
      ['alpha', { ok: true }],
      ['beta', { ok: false, reason: 'EACCES' }],
    ]),
  })
  assert.deepEqual(ready, [
    { name: 'alpha', state: 'ready' },
    { name: 'ghost', state: 'unknown', reason: 'not in the skill catalog' },
    { name: 'beta', state: 'load-failed', reason: 'EACCES' },
  ])

  const incomplete = classifySelection({
    selected: ['ghost'],
    catalog: { kind: 'scoped', names: [], complete: false },
    scoped: true,
    loads: new Map(),
  })
  assert.equal(incomplete[0].state, 'unavailable')

  const unscoped = classifySelection({
    selected: ['ghost'],
    catalog: { kind: 'scoped', names: [], complete: true },
    scoped: false,
    loads: new Map(),
  })
  assert.equal(unscoped[0].state, 'no-scope')

  const errored = classifySelection({
    selected: ['alpha'],
    catalog: { kind: 'error', reason: 'boom' },
    scoped: true,
    loads: new Map(),
  })
  assert.deepEqual(errored, [{ name: 'alpha', state: 'unavailable', reason: 'boom' }])

  // An advertised name stays resolvable even while discovery is incomplete.
  const advertised = classifySelection({
    selected: ['alpha'],
    catalog: { kind: 'scoped', names: ['alpha'], complete: false },
    scoped: true,
    loads: new Map([['alpha', { ok: true }]]),
  })
  assert.deepEqual(advertised, [{ name: 'alpha', state: 'ready' }])

  // An empty load reason is no reason; rows keep selection order.
  const blank = classifySelection({
    selected: ['beta', 'alpha'],
    catalog: { kind: 'scoped', names: ['alpha', 'beta'], complete: true },
    scoped: true,
    loads: new Map([
      ['alpha', { ok: false, reason: '' }],
      ['beta', { ok: true }],
    ]),
  })
  assert.deepEqual(blank, [
    { name: 'beta', state: 'ready' },
    { name: 'alpha', state: 'load-failed', reason: 'skill body could not be loaded' },
  ])
})

// --- Contract 5: applyBodies ---------------------------------------------
test('contract 5: applyBodies replaces ready, drops unknown/deselected, keeps transient last-good', () => {
  const prev = new Map([
    ['alpha', 'old-alpha'],
    ['beta', 'old-beta'],
    ['ghost', 'old-ghost'],
  ])
  const next = applyBodies(
    prev,
    [
      { name: 'alpha', state: 'ready' },
      { name: 'beta', state: 'unavailable', reason: 'provider discovery incomplete' },
      { name: 'ghost', state: 'unknown', reason: 'not in the skill catalog' },
    ],
    new Map([['alpha', 'new-alpha']]),
  )
  assert.deepEqual([...next], [
    ['alpha', 'new-alpha'],
    ['beta', 'old-beta'],
  ])

  // Deselected names disappear; a ready row without a fresh body invents nothing.
  const trimmed = applyBodies(prev, [{ name: 'alpha', state: 'load-failed', reason: 'boom' }], new Map())
  assert.deepEqual([...trimmed], [['alpha', 'old-alpha']])
  assert.deepEqual([...applyBodies(prev, [{ name: 'alpha', state: 'ready' }], new Map())], [])
})

// --- Contract 6: cachedSuffix --------------------------------------------
test('contract 6: cachedSuffix describes a held body per mode, empty without a cache', () => {
  assert.equal(
    cachedSuffix({ mode: 'each-prompt', injected: [], name: 'ponytail', cached: true }),
    ' · still injecting the last loaded copy',
  )
  assert.equal(
    cachedSuffix({ mode: 'start-only', injected: ['ponytail'], name: 'ponytail', cached: true }),
    ' · already in this session',
  )
  assert.equal(
    cachedSuffix({ mode: 'start-only', injected: [], name: 'ponytail', cached: true }),
    ' · last loaded copy retained',
  )
  assert.equal(cachedSuffix({ mode: 'each-prompt', injected: [], name: 'ponytail', cached: false }), '')
  assert.equal(cachedSuffix({ mode: 'each-prompt', injected: [], name: 'ponytail', cached: undefined }), '')
})

// --- Contract 7: isSkillName ---------------------------------------------
test('contract 7: isSkillName accepts kebab-case and rejects others', () => {
  assert.equal(isSkillName('caveman'), true)
  assert.equal(isSkillName('deep-caveman-2'), true)
  assert.equal(isSkillName('Caveman'), false)
  assert.equal(isSkillName('caveman_ponytail'), false)
  assert.equal(isSkillName('-leading'), false)
  assert.equal(isSkillName(''), false)
})

// =========================================================================
// Host half (contracts 8-16). Drives the real apply() with a stub Cordis
// context: the settings ARE the Loader Config, presented as volatile refs.
// =========================================================================

const { apply, name: pluginName, inject: injectDeps, Config } = await import('../lib/index.js')

const PONYTAIL = {
  name: 'ponytail',
  description: 'lazy senior dev',
  content: 'BODY-PONYTAIL',
  provider: 'filesystem',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'user-agents',
}

const LLMTRIM = {
  name: 'llmtrim',
  description: 'trim llm context',
  content: 'BODY-LLMTRIM',
  provider: 'filesystem',
  invocation: { modelInvocable: true, userInvocable: true },
  source: 'user-agents',
}

/** Advertised by the catalog, but not model invocable, so never `available`. */
const HIDDEN = {
  name: 'secret',
  description: 'not model invocable',
  content: 'BODY-SECRET',
  provider: 'filesystem',
  invocation: { modelInvocable: false, userInvocable: true },
  source: 'user-agents',
}

/** A live Config as the Loader presents it: schemastery `.volatile()` refs. */
function makeConfig(initial) {
  let mode = initial.mode
  let selected = initial.selected
  let showDock = initial.showDock ?? true
  let workspaces = initial.workspaces ?? {}
  return {
    config: {
      mode: { get: () => mode },
      selected: { get: () => selected },
      showDock: { get: () => showDock },
      workspaces: { get: () => workspaces },
    },
    current: () => ({ mode, selected, showDock, workspaces }),
    commit(patch) {
      if (patch.mode !== undefined) mode = patch.mode
      if (patch.selected !== undefined) selected = patch.selected
      if (patch.showDock !== undefined) showDock = patch.showDock
      if (patch.workspaces !== undefined) workspaces = patch.workspaces
    },
  }
}

/** Stub ctx exposing only the seams the host half dereferences. */
function makeHarness(initial, skills, services = {}) {
  const store = makeConfig(initial)
  const routes = new Map()
  const listeners = new Map()
  const sections = []
  const updates = []
  const configured = []
  let updateThrows = false

  const emit = async (event, payload) => {
    for (const fn of listeners.get(event) ?? []) await fn(payload)
  }

  const ctx = {
    effect: (fn) => {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    // Optional-service lookup: `loader` (entry id) and `agents` (scope recovery).
    get: (serviceName) => services[serviceName],
    logger: { warn: () => {} },
    webServer: {
      register: (route) => {
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    settings: {
      configure: (presentation) => {
        configured.push(presentation)
        return () => {}
      },
      // The real service merges the patch into the entry Config, which for
      // volatile fields means updating the live refs and announcing it.
      update: async (ns, patch) => {
        if (updateThrows) throw new Error('settings store exploded')
        updates.push([ns, patch])
        store.commit(patch)
        await emit('loader/volatile-update', [['mode'], ['selected'], ['showDock']])
      },
    },
    skills,
    systemPrompt: {
      section: (section) => {
        sections.push(section)
        return () => {}
      },
    },
    on: (event, fn) => {
      const set = listeners.get(event) ?? []
      set.push(fn)
      listeners.set(event, set)
      return () => {
        const i = set.indexOf(fn)
        if (i >= 0) set.splice(i, 1)
      }
    },
  }

  return {
    ctx,
    config: store.config,
    routes,
    sections,
    updates,
    configured,
    services,
    emit,
    current: store.current,
    setUpdateThrows: (v) => {
      updateThrows = v
    },
    listenerCount: (event) => (listeners.get(event) ?? []).length,
  }
}

function makeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(body) {
      this.body = body
    },
  }
}

/** GET the snapshot route and parse the JSON body. */
async function snapshot(routes) {
  const res = makeRes()
  await routes.get('/dsh-skill-injector/api')({}, res)
  assert.equal(res.status, 200)
  return JSON.parse(res.body)
}

/** A live-agent stub with the DSH >= 0.2 history accessor. */
function makeAgent(id, injected, events = [], cwd = 'C:/work') {
  return {
    id,
    session: { header: { cwd }, ownEvents: () => events },
    inject: (message) => injected.push(message),
  }
}

/** A registry that only answers a scoped read, like the real filesystem provider.
 *  `cwd` is required too: the repo contract is `{ scope, cwd }`, so a regression
 *  that drops the cwd must fail this suite. */
function scopedRegistry(advertised) {
  const scoped = (options) => options !== undefined && options.cwd === 'C:/work'
  return {
    snapshot: async (options) =>
      scoped(options) ? { skills: advertised, complete: true } : { skills: [], complete: true },
    list: async (options) => (scoped(options) ? advertised : []),
    get: async (name, options) => (scoped(options) ? advertised.find((s) => s.name === name) : undefined),
  }
}

// --- Contract 8: Config is volatile and names the new namespace ----------
test('contract 8: Config exposes three volatile fields and the new entry name', () => {
  assert.equal(pluginName, 'dsh-skill-injector')
  assert.deepEqual(injectDeps, ['webServer', 'settings', 'skills', 'systemPrompt'])

  // cordis validates a plugin Config through the Standard-Schema probe.
  const std = Config['~standard']
  assert.equal(typeof std?.validate, 'function')

  // Every field must be volatile: `settings.update()` refuses a non-volatile
  // field, and the Loader only commits volatile-only changes in place.
  const resolved = std.validate({}).value
  assert.deepEqual(resolved.mode.get(), 'each-prompt')
  assert.deepEqual(resolved.selected.get(), [])
  assert.deepEqual(resolved.showDock.get(), true, 'the dock line stays visible unless opted out')
  assert.deepEqual(Config({ mode: 'start-only' }).selected.get(), [])
  assert.ok(std.validate({ mode: 'nope' }).issues.length > 0, 'an unknown mode must be rejected')
})

// --- Contract 9: routes + GET snapshot shape -----------------------------
test('contract 9: GET snapshot is complete JSON and concurrent reads share one pass', async () => {
  const h = makeHarness({ mode: 'each-prompt', selected: ['ponytail'] }, scopedRegistry([PONYTAIL]))
  apply(h.ctx, h.config)
  assert.deepEqual(h.configured, [{ auto: false }])
  assert.ok(h.routes.has('/dsh-skill-injector/api'))
  assert.ok(h.routes.has('/dsh-skill-injector/api/config'))
  assert.equal(typeof h.sections[0]?.text, 'function')
  assert.equal(h.sections[0].name, 'dsh-skill-injector:active')
  assert.equal(h.sections[0].order, 150)

  const snap = await snapshot(h.routes)
  assert.deepEqual(Object.keys(snap).sort(), [
    'activeWorkspaceId',
    'available',
    'canRemove',
    'effective',
    'injected',
    'mode',
    'ok',
    'selected',
    'showDock',
    'truncated',
    'unresolved',
    'workspaces',
  ])
  assert.equal(snap.ok, true)

  // Identical concurrent triggers share one catalog read (in-flight memo).
  let reads = 0
  const scoped = (options) => options !== undefined && options.cwd === 'C:/work'
  const counting = {
    snapshot: async (options) => {
      reads += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return scoped(options) ? { skills: [PONYTAIL], complete: true } : { skills: [], complete: true }
    },
    list: async (options) => (scoped(options) ? [PONYTAIL] : []),
    get: async (name, options) => (scoped(options) && name === 'ponytail' ? PONYTAIL : undefined),
  }
  const shared = makeHarness({ mode: 'each-prompt', selected: ['ponytail'] }, counting)
  apply(shared.ctx, shared.config)
  await shared.emit('agent/created', { agent: makeAgent('s1', []), source: 'new' })
  await snapshot(shared.routes)
  const before = reads
  await Promise.all([snapshot(shared.routes), snapshot(shared.routes)])
  assert.equal(reads - before, 1, 'two concurrent GETs must share one in-flight pass')
})

// --- Contract 10: PUT paths ----------------------------------------------
test('contract 10: PUT validates, persists to the entry id, and always answers JSON', async () => {
  const h = makeHarness({ mode: 'each-prompt', selected: [] }, scopedRegistry([PONYTAIL]), {
    loader: { entries: () => [{ options: { id: 'renamed-entry', name: 'dsh-skill-injector' } }] },
  })
  apply(h.ctx, h.config)

  const put = async (body) => {
    const res = makeRes()
    await h.routes.get('/dsh-skill-injector/api/config')([body], res)
    return { status: res.status, snap: JSON.parse(res.body) }
  }

  const ok = await put(JSON.stringify({ mode: 'start-only', selected: ['ponytail'] }))
  assert.equal(ok.status, 200)
  assert.equal(ok.snap.ok, true)
  assert.deepEqual(ok.snap.selected, ['ponytail'])
  assert.equal(ok.snap.showDock, true, 'a body without showDock keeps the default')
  assert.deepEqual(h.updates, [['renamed-entry', { mode: 'start-only', selected: ['ponytail'], showDock: true }]])

  const malformed = await put('{not json')
  assert.equal(malformed.status, 400)
  assert.equal(malformed.snap.ok, false)

  const invalid = await put(JSON.stringify({ mode: 'nope', selected: [] }))
  assert.equal(invalid.status, 400)
  assert.equal(invalid.snap.ok, false)

  h.setUpdateThrows(true)
  const exploded = await put(JSON.stringify({ mode: 'each-prompt', selected: ['ponytail'] }))
  assert.equal(exploded.status, 500)
  assert.equal(exploded.snap.ok, false)
  assert.match(exploded.snap.error, /exploded/)
})

// --- Contract 11: last-good body vs unknown ------------------------------
test('contract 11: a transient failure keeps the last-good body; only unknown drops it', async () => {
  let advertised = [PONYTAIL]
  let complete = true
  let getThrows = false
  let snapshotThrows = false
  const scoped = (options) => options !== undefined && options.cwd === 'C:/work'
  const skills = {
    snapshot: async (options) => {
      if (snapshotThrows) throw new Error('registry exploded')
      return scoped(options) ? { skills: advertised, complete } : { skills: [], complete: true }
    },
    list: async (options) => (scoped(options) ? advertised : []),
    get: async (name, options) => {
      if (!scoped(options) || name !== 'ponytail') return undefined
      if (getThrows) throw new Error('EACCES')
      return PONYTAIL
    },
  }
  const h = makeHarness({ mode: 'each-prompt', selected: ['ponytail', 'llmtrim'] }, skills)
  apply(h.ctx, h.config)
  const section = () => h.sections[0].text()
  assert.equal(section(), '')

  // Scope arrives, then a clean pass renders the body into the section.
  await h.emit('agent/created', { agent: makeAgent('s1', []), source: 'new' })
  await snapshot(h.routes)
  assert.match(section(), /BODY-PONYTAIL/)

  // A failing body load is transient: reported per skill, still injected.
  getThrows = true
  const failed = await snapshot(h.routes)
  assert.deepEqual(failed.unresolved, [
    { name: 'ponytail', state: 'load-failed', reason: 'EACCES', cached: true },
    { name: 'llmtrim', state: 'unknown', reason: 'not in the skill catalog', cached: false },
  ])
  assert.match(section(), /BODY-PONYTAIL/)

  // A failed catalog read is unavailable with the thrown message, still transient.
  snapshotThrows = true
  const errored = await snapshot(h.routes)
  assert.deepEqual(errored.unresolved.map((u) => [u.name, u.state, u.reason]), [
    ['ponytail', 'unavailable', 'registry exploded'],
    ['llmtrim', 'unavailable', 'registry exploded'],
  ])
  assert.match(section(), /BODY-PONYTAIL/)
  snapshotThrows = false

  // Incomplete discovery is transient too, and must never read as a deletion.
  getThrows = false
  advertised = []
  complete = false
  const partial = await snapshot(h.routes)
  assert.deepEqual(partial.unresolved.map((u) => [u.name, u.state, u.reason]), [
    ['ponytail', 'unavailable', 'provider discovery incomplete'],
    ['llmtrim', 'unavailable', 'provider discovery incomplete'],
  ])
  assert.match(section(), /BODY-PONYTAIL/)

  // Only a complete, scoped read that no longer advertises the name drops it.
  complete = true
  const gone = await snapshot(h.routes)
  assert.equal(gone.unresolved[0].state, 'unknown')
  assert.equal(section(), '')

  // The section escapes braces while a stamped message stays raw.
  const braced = { ...PONYTAIL, content: 'uses {{model}} verbatim' }
  const eachPrompt = makeHarness({ mode: 'each-prompt', selected: ['ponytail'] }, scopedRegistry([braced]))
  apply(eachPrompt.ctx, eachPrompt.config)
  await eachPrompt.emit('agent/created', { agent: makeAgent('b1', []), source: 'new' })
  await snapshot(eachPrompt.routes)
  assert.match(eachPrompt.sections[0].text(), /&#123;&#123;model}}/)
  assert.ok(!eachPrompt.sections[0].text().includes('{{model}}'))

  const startOnly = makeHarness({ mode: 'start-only', selected: ['ponytail'] }, scopedRegistry([braced]))
  apply(startOnly.ctx, startOnly.config)
  const injected = []
  await startOnly.emit('agent/created', { agent: makeAgent('b2', injected), source: 'new' })
  assert.equal(injected.length, 1)
  assert.match(injected[0].content[0].text, /\{\{model\}\}/)
})

// --- Contract 12: two-pass stamp + resume dedupe -------------------------
test('contract 12: start-only stamps a cold cache in two passes and never doubles on resume', async () => {
  const h = makeHarness({ mode: 'start-only', selected: ['ponytail', 'llmtrim'] }, scopedRegistry([PONYTAIL, HIDDEN]))
  apply(h.ctx, h.config)

  // A session starts with a cold cache: pass 1 stamps nothing, pass 2 must stamp.
  const injected = []
  await h.emit('agent/created', { agent: makeAgent('session-1', injected), source: 'new' })
  assert.equal(injected.length, 1)
  assert.equal(injected[0].source.name, 'ponytail')

  // Re-firing the same session must not double-stamp.
  await h.emit('agent/created', { agent: makeAgent('session-1', injected), source: 'resume' })
  await snapshot(h.routes)
  assert.equal(injected.length, 1)

  // A different session whose log already carries the stamp must not stamp again.
  const second = []
  await h.emit('agent/created', {
    agent: makeAgent('session-2', second, [
      {
        type: 'user/message',
        data: { source: { kind: 'skill-invocation', name: 'ponytail', form: 'instructions' } },
      },
    ]),
    source: 'new',
  })
  await snapshot(h.routes)
  assert.equal(second.length, 0)

  // The host never rewrites the stored selection; only the PUT route may.
  assert.equal(h.updates.length, 0)
})

// --- Contract 13: canRemove gates on a scoped resolve --------------------
test('contract 13: canRemove stays false until a scoped resolve has run', async () => {
  const h = makeHarness({ mode: 'each-prompt', selected: ['ponytail'] }, scopedRegistry([PONYTAIL]))
  apply(h.ctx, h.config)

  const boot = await snapshot(h.routes)
  assert.equal(boot.canRemove, false)
  assert.deepEqual(boot.available, [])
  assert.deepEqual(boot.unresolved, [
    { name: 'ponytail', state: 'no-scope', reason: 'waiting for a session to establish scope', cached: false },
  ])

  await h.emit('agent/created', { agent: makeAgent('s1', []), source: 'new' })
  const scoped = await snapshot(h.routes)
  assert.equal(scoped.canRemove, true)
  assert.deepEqual(scoped.available, [{ name: 'ponytail', description: 'lazy senior dev', source: 'user-agents' }])
  assert.deepEqual(scoped.unresolved, [])
})

// --- Contract 14: disposal clears the scope, registry recovers one ------
test('contract 14: a live agent supplies the scope after re-apply; disposal clears it', async () => {
  const skills = scopedRegistry([PONYTAIL])
  // No `agent/created` ever fired for this instance: exactly the state a reload
  // leaves behind (the Loader re-applies the plugin on a non-volatile change).
  const agent = makeAgent('survivor', [])
  let live = [agent]
  const h = makeHarness({ mode: 'each-prompt', selected: ['ponytail'] }, skills, { agents: { list: () => live } })
  apply(h.ctx, h.config)

  const recovered = await snapshot(h.routes)
  assert.equal(recovered.canRemove, true)
  assert.deepEqual(recovered.available, [{ name: 'ponytail', description: 'lazy senior dev', source: 'user-agents' }])
  assert.deepEqual(recovered.unresolved, [])

  // A disposed agent must stop being the scope: the plugin reverts to the
  // pre-scope posture instead of resolving against a dead scope.
  live = []
  await h.emit('agent/disposed', { agent })
  const disposed = await snapshot(h.routes)
  assert.deepEqual(disposed.unresolved, [
    { name: 'ponytail', state: 'no-scope', reason: 'waiting for a session to establish scope', cached: true },
  ])
})

// --- Contract 15: per-agent stamp ledger is bounded ----------------------
test('contract 15: the per-agent stamp ledger caps at 200 and evicts the oldest', async () => {
  const h = makeHarness({ mode: 'start-only', selected: ['ponytail'] }, scopedRegistry([PONYTAIL]))
  apply(h.ctx, h.config)

  for (let i = 0; i < 201; i += 1) {
    await h.emit('agent/created', { agent: makeAgent('agent-' + i, []), source: 'new' })
  }

  // The first agent's ledger entry was evicted, so a resume of its empty log
  // stamps again; the most recent agent is still recorded and does not.
  const first = []
  await h.emit('agent/created', { agent: makeAgent('agent-0', first), source: 'resume' })
  assert.equal(first.length, 1, 'the evicted oldest agent stamps again')

  const last = []
  await h.emit('agent/created', { agent: makeAgent('agent-200', last), source: 'resume' })
  assert.equal(last.length, 0, 'a recently stamped agent is remembered')
})

// --- Contract 16: volatile save re-resolves without a reload -------------
test('contract 16: loader/volatile-update re-resolves the selection in place', async () => {
  let reads = 0
  const scoped = (options) => options !== undefined && options.cwd === 'C:/work'
  const skills = {
    snapshot: async (options) => {
      reads += 1
      return scoped(options) ? { skills: [PONYTAIL], complete: true } : { skills: [], complete: true }
    },
    list: async (options) => (scoped(options) ? [PONYTAIL] : []),
    get: async (name, options) => (scoped(options) && name === 'ponytail' ? PONYTAIL : undefined),
  }
  const h = makeHarness({ mode: 'each-prompt', selected: [] }, skills)
  apply(h.ctx, h.config)
  await h.emit('agent/created', { agent: makeAgent('s1', []), source: 'new' })
  await snapshot(h.routes)
  const section = () => h.sections[0].text()
  assert.equal(section(), '')

  // A Save touches only volatile fields: the Loader commits in place and emits.
  const before = reads
  const put = makeRes()
  await h.routes.get('/dsh-skill-injector/api/config')(
    [JSON.stringify({ mode: 'each-prompt', selected: ['ponytail'] })],
    put,
  )
  assert.equal(put.status, 200)
  assert.deepEqual(JSON.parse(put.body).selected, ['ponytail'])

  // The same instance now serves the new selection: no re-apply, no lost scope.
  const after = await snapshot(h.routes)
  assert.deepEqual(after.selected, ['ponytail'])
  assert.match(section(), /BODY-PONYTAIL/)
  assert.ok(reads > before, 'the save triggered at least one fresh resolve')

  // showDock is reported live and can be opted out without a reload.
  const off = makeRes()
  await h.routes.get('/dsh-skill-injector/api/config')(
    [JSON.stringify({ mode: 'each-prompt', selected: ['ponytail'], showDock: false })],
    off,
  )
  assert.equal(off.status, 200)
  assert.equal(JSON.parse(off.body).showDock, false)
  assert.equal((await snapshot(h.routes)).showDock, false)
})

// --- Contract 17: mergeSelection -----------------------------------------
test('contract 17: mergeSelection appends workspace extras after the global list', () => {
  const merged = mergeSelection(['ponytail', 'caveman'], ['caveman', 'llmtrim'])
  assert.deepEqual(merged.selected, ['ponytail', 'caveman', 'llmtrim'], 'global first, extras appended, no duplicates')
  assert.equal(merged.truncated, false)

  // A workspace list alone can overflow the cap: the overflow is reported.
  const big = Array.from({ length: MAX_SELECTED + 2 }, (_, i) => 'skill-' + i)
  const capped = mergeSelection([], big)
  assert.equal(capped.selected.length, MAX_SELECTED)
  assert.equal(capped.truncated, true)

  // Extras beyond the remaining room are dropped, not merged past the cap.
  const full = mergeSelection(Array.from({ length: MAX_SELECTED }, (_, i) => 'g-' + i), ['extra'])
  assert.equal(full.selected.length, MAX_SELECTED)
  assert.equal(full.truncated, true)
  assert.equal(full.selected.includes('extra'), false)
})

// --- Contract 18: workspace extras merge into the effective selection ----
test('contract 18: a workspace adds its extras on top of the global selection', async () => {
  const registry = {
    workspaceRegistry: { list: () => [{ id: 'ws-a', path: 'C:/work', title: 'Repo A' }] },
  }
  const h = makeHarness(
    { mode: 'each-prompt', selected: ['ponytail'], workspaces: { 'ws-a': ['llmtrim'] } },
    scopedRegistry([PONYTAIL, LLMTRIM]),
    registry,
  )
  apply(h.ctx, h.config)
  await h.emit('agent/created', { agent: makeAgent('s1', [], [], 'C:/work'), source: 'new' })
  const snap = await snapshot(h.routes)

  assert.deepEqual(snap.selected, ['ponytail'], 'the stored global selection is untouched')
  assert.deepEqual(snap.effective, ['ponytail', 'llmtrim'], 'the workspace extra is appended')
  assert.equal(snap.activeWorkspaceId, 'ws-a')
  assert.equal(snap.truncated, false)
  assert.deepEqual(snap.workspaces, [{ id: 'ws-a', title: 'Repo A', path: 'C:/work', selection: ['llmtrim'] }])
  assert.match(h.sections[0].text(), /BODY-PONYTAIL/)
  assert.match(h.sections[0].text(), /BODY-LLMTRIM/)
})

// --- Contract 19: cwd matching is a longest-prefix match -----------------
test('contract 19: a nested cwd resolves to the workspace whose path contains it', () => {
  const workspaces = [
    { id: 'root', path: 'C:/work' },
    { id: 'nested', path: 'C:/work/nested' },
  ]
  assert.equal(workspaceForCwd('C:/work/nested/src', workspaces), 'nested')
  assert.equal(workspaceForCwd('C:/Work/Nested/x', workspaces), 'nested', 'case-insensitive prefix')
  assert.equal(workspaceForCwd('C:\\work\\nested', workspaces), 'nested', 'backslashes normalise')
  assert.equal(workspaceForCwd('C:/workspace-x', workspaces), undefined, 'a sibling prefix must not match')
  assert.equal(workspaceForCwd(undefined, workspaces), undefined)
})

// --- Contract 20: no registry falls back to the global selection ---------
test('contract 20: without a workspace registry the global selection still applies', async () => {
  const h = makeHarness(
    { mode: 'each-prompt', selected: ['ponytail'], workspaces: { 'ws-a': ['llmtrim'] } },
    scopedRegistry([PONYTAIL, LLMTRIM]),
  )
  apply(h.ctx, h.config)
  await h.emit('agent/created', { agent: makeAgent('s1', [], [], 'C:/work'), source: 'new' })
  const snap = await snapshot(h.routes)

  assert.equal(snap.activeWorkspaceId, null)
  assert.deepEqual(snap.workspaces, [])
  assert.deepEqual(snap.effective, ['ponytail'], 'unmatched workspace extras never leak in')
  assert.equal(snap.truncated, false)
})

// --- Contract 21: PUT persists workspaces and prunes dead ids ------------
test('contract 21: PUT persists workspace selections and drops ids the registry no longer has', async () => {
  const registry = {
    workspaceRegistry: { list: () => [{ id: 'ws-a', path: 'C:/work', title: 'Repo A' }] },
  }
  const h = makeHarness({ mode: 'each-prompt', selected: [] }, scopedRegistry([PONYTAIL]), registry)
  apply(h.ctx, h.config)

  const put = async (body) => {
    const res = makeRes()
    await h.routes.get('/dsh-skill-injector/api/config')([typeof body === 'string' ? body : JSON.stringify(body)], res)
    return { status: res.status, snap: JSON.parse(res.body) }
  }

  const ok = await put({ mode: 'each-prompt', selected: [], workspaces: { 'ws-a': ['ponytail'], gone: ['x'] } })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.snap.workspaces, { 'ws-a': ['ponytail'] }, 'the orphan id is pruned before saving')
  assert.deepEqual(h.updates.at(-1)[1].workspaces, { 'ws-a': ['ponytail'] })

  const snapAfter = await snapshot(h.routes)
  assert.deepEqual(snapAfter.workspaces.map((w) => w.id), ['ws-a'], 'the snapshot offers the live workspace only')

  const bad = await put({ mode: 'each-prompt', selected: [], workspaces: { 'ws-a': [42] } })
  assert.equal(bad.status, 400, 'a non-string skill name is rejected')
})
