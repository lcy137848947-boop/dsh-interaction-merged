import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

/**
 * Host double with the same events DSH emits around a turn:
 * `agent/inbox/inserted` -> `agent/inbox/claimed` -> `system-prompt/assemble`.
 * The claimed event is where a real turn id becomes available.
 */
function host(statePath, config = {}) {
  const handlers = new Map()
  const commands = new Map()
  const ctx = {
    logger: { info() {} },
    on(event, handler) { handlers.set(event, handler); return () => {} },
    effect(fn) { fn() },
    get(name) {
      return name === 'commands' ? { register(spec) { commands.set(spec.name, spec); return () => {} } } : undefined
    },
  }
  apply(ctx, { statePath, metrics: false, ...config })
  const agent = { session: { id: 'turn-session' } }
  return {
    agent,
    inbox(text) { handlers.get('agent/inbox/inserted')({ agent, message: { role: 'user', content: text } }) },
    claimed(turnId) { handlers.get('agent/inbox/claimed')?.({ agent, turn: { id: turnId }, message: { id: `m-${turnId}` } }) },
    event(type, data = {}) { handlers.get('session/event')?.(agent.session, { type, data }) },
    error() { handlers.get('agent/error')?.({ agent, error: new Error('boom') }) },
    async assemble() {
      const assembly = { sections: [] }
      await handlers.get('system-prompt/assemble')(assembly, { agent }, async () => assembly)
      return assembly.sections
    },
    command(name, rawInput) { return commands.get(name).handler({ agent, rawInput }) },
  }
}

test('同一 turn id 的二次装配不重复注入', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  h.claimed('turn-1')
  const first = await h.assemble()
  const second = await h.assemble()
  assert.ok(first.some((section) => section.name === 'itk:task'))
  assert.deepEqual(second, [])
})

test('流式重试：claimed 晚于第一次装配，也不重复注入', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  const first = await h.assemble()
  assert.ok(first.some((section) => section.name === 'itk:task'))
  // A late claim must not reopen the turn that was already injected.
  h.claimed('turn-1')
  const retry = await h.assemble()
  assert.deepEqual(retry, [])
})

test('新的 turn id 会重新注入', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  h.claimed('turn-1')
  await h.assemble()
  h.inbox('继续。')
  h.claimed('turn-2')
  const next = await h.assemble()
  assert.ok(next.some((section) => section.name === 'itk:task'))
})

test('没有宿主 turn id 时按本地轮次兜底，仍然只注入一次', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  const first = await h.assemble()
  const second = await h.assemble()
  assert.ok(first.length > 0)
  assert.deepEqual(second, [])
  assert.match(h.command('itk', '/itk why').text, /本地计数兜底/)
})
