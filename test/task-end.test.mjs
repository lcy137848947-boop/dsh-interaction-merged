import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

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
  const agent = { session: { id: 'end-session' } }
  return {
    agent,
    inbox(text) { handlers.get('agent/inbox/inserted')({ agent, message: { role: 'user', content: text } }) },
    error() { handlers.get('agent/error')?.({ agent, error: new Error('boom') }) },
    event(type, data = {}) { handlers.get('session/event')?.(agent.session, { type, data }) },
    async assemble() {
      const assembly = { sections: [] }
      await handlers.get('system-prompt/assemble')(assembly, { agent }, async () => assembly)
      return assembly.sections
    },
    status() { return commands.get('itk').handler({ agent, rawInput: '/itk' }).text },
  }
}

test('任务失败也算结束：临时要求不带到下一项', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  h.inbox('这次只输出结论。')
  await h.assemble()
  // 临时要求从下一轮开始生效（创建当轮不注入）。
  h.inbox('继续。')
  const withTemp = await h.assemble()
  assert.ok(withTemp.some((section) => section.name === 'itk:temp'))

  h.error()
  assert.match(h.status(), /等待：failed/)
  assert.match(h.status(), /临时：无/)

  h.inbox('继续。')
  const next = await h.assemble()
  const text = next.map((section) => section.text).join('\n')
  assert.match(text, /上次没有完成/)
  assert.equal(next.some((section) => section.name === 'itk:temp'), false)
  assert.equal(next.some((section) => section.name === 'itk:task'), false)
})

test('取消任务同样释放临时要求', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  h.inbox('这次只输出结论。')
  await h.assemble()
  h.inbox('取消任务。')
  await h.assemble()
  assert.match(h.status(), /等待：cancelled/)
  assert.match(h.status(), /临时：无/)
})

test('turn 中断事件按失败处理，不假装完成', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  h.inbox('这次只输出结论。')
  await h.assemble()
  h.event('turn/interrupted', { turn: { status: 'interrupted' } })
  assert.match(h.status(), /等待：failed/)
  assert.match(h.status(), /临时：无/)
})

test('没有任务时的错误不写入失败状态', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.error()
  assert.doesNotMatch(h.status(), /等待：failed/)
})
