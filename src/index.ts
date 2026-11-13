/**
 * dsh-skill-injector — host half (skeleton).
 *
 * Owns the injector's configuration (mode + selected skills + showDock) and
 * injects them into sessions two ways:
 *   - `each-prompt`: a systemPrompt.section re-rendered every assembly,
 *   - `start-only`: agent.inject() on `agent/created` (one durable user/message
 *     stamped per skill, deduped against session history).
 * Serves the snapshot to the client bundle over HTTP
 * (`/dsh-skill-injector/api`) and accepts selection writes
 * (`PUT /dsh-skill-injector/api/config`).
 *
 * Skeleton only: real injection / routing / scope logic lands in later tasks.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-skill-injector'

/**
 * The plugin's Config — this schema IS the settings namespace under DSH >= 0.2.
 * Fields are temporarily NOT `.volatile()`; later tasks add volatile so a Save
 * commits in place instead of reloading the entry.
 */
export const Config = z.object({
  mode: z.union([z.const('each-prompt'), z.const('start-only')]).default('each-prompt'),
  selected: z.array(z.string()).default([]),
  showDock: z.boolean().default(true),
})

// Hard deps, same service set as the reference plugin.
export const inject = ['webServer', 'settings', 'skills', 'systemPrompt']

export function apply(ctx: Context): void {
  // Placeholder — routes, section, agent/created stamping land in later tasks.
  void ctx
}
