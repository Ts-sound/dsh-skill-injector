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
