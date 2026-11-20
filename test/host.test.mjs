import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { createStore } from '../lib/store.js'

function host(statePath, config = {}) {
  const handlers = new Map()
  const commands = new Map()
  let counts = { inbox: 0, assemble: 0 }
  const ctx = {
    logger: { info() {} },
    on(event, handler) {
      counts[event] = (counts[event] || 0) + 1
      handlers.set(event, handler)
      return () => {}
    },
    effect(fn) { fn() },
    get(name) {
      return name === 'commands' ? { register(spec) { commands.set(spec.name, spec); return () => {} } } : undefined
    },
  }
  apply(ctx, { statePath, metrics: false, maxChars: 620, ...config })
  const agent = { session: { id: 'merged' } }
  return {
    agent,
    counts,
    inbox(text) {
      handlers.get('agent/inbox/inserted')({ agent, message: { role: 'user', content: text } })
    },
    assistant(text) {
      handlers.get('session/event')(agent.session, { type: 'assistant/message', data: { message: { content: text } } })
    },
    async assemble() {
      const assembly = { sections: [] }
      await handlers.get('system-prompt/assemble')(assembly, { agent }, async () => assembly)
      return assembly.sections
    },
    command(name, rawInput) {
      return commands.get(name).handler({ agent, rawInput })
    },
    async preExecute(name) {
      const handler = handlers.get('tools/pre-execute')
      if (!handler) return { kind: 'allow' }
      return handler({ name, agent }, async () => ({ kind: 'allow' }))
    },
    compact() {
      const handler = handlers.get('session/event')
      if (handler) handler(agent.session, { type: 'compaction/completed', data: {} })
    },
  }
}

test('合并运行时只有一个 inbox 和一个 assemble 钩子', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  assert.equal(h.counts['agent/inbox/inserted'], 1)
  assert.equal(h.counts['system-prompt/assemble'], 1)
})

test('停止旧任务 + 同轮新任务：只注入一个 stop action，新任务可继续', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  h.inbox('我说的是插件。')
  await h.assemble()
  h.inbox('算了，不要自动整理了，结合所有文档总结一下。')
  const sections = await h.assemble()
  const names = sections.map((section) => section.name)
  assert.ok(names.includes('itk:action:stop'))
  assert.ok(names.includes('itk:task'))
  assert.equal(names.filter((name) => name === 'itk:action:stop').length, 1)
  assert.equal(names.includes('itk:correction'), false)
  const text = sections.map((section) => section.text).join('\n')
  assert.match(text, /结合所有文档/)
  assert.doesNotMatch(text, /插件清单/)
})

test('只停止不开新任务：不保留旧任务注入', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  await h.assemble()
  h.inbox('先不用，我先发给对方看。')
  const sections = await h.assemble()
  const names = sections.map((section) => section.name)
  assert.ok(names.includes('itk:action:stop'))
  assert.equal(names.includes('itk:task'), false)
})

test('纠正只由合并插件注入一次', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  await h.assemble()
  h.inbox('我说的是插件。')
  const sections = await h.assemble()
  const names = sections.map((section) => section.name)
  assert.equal(names.filter((name) => name === 'itk:correction').length, 1)
  assert.equal(names.some((name) => name.includes('action:correction')), false)
})

test('有等待上下文时“可以”只产生一个 confirm', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我选一个方案。')
  h.assistant('方案 A 和方案 B，你选哪个？')
  h.inbox('可以。')
  const sections = await h.assemble()
  const confirms = sections.filter((section) => section.name === 'itk:action:confirm')
  assert.equal(confirms.length, 1)
})

test('guard why 和 itk why 共用 traceId', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  h.inbox('我说的是插件。')
  await h.assemble()
  const itk = h.command('itk', '/itk why').text
  const guard = h.command('guard', '/guard why').text
  const a = (itk.match(/trace ([a-f0-9]+)/) || [])[1]
  const b = (guard.match(/trace ([a-f0-9]+)/) || [])[1]
  assert.ok(a)
  assert.equal(a, b)
})

test('联合总预算不超过 620；行动段保留', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  h.inbox('我说的是插件。')
  await h.assemble()
  h.inbox('算了，不要自动整理了，结合所有文档总结一下。')
  const sections = await h.assemble()
  const total = sections.reduce((sum, section) => sum + section.text.length, 0)
  assert.ok(total <= 620, `budget ${total}`)
  assert.ok(sections.some((section) => section.name === 'itk:action:stop'))
})

test('同轮重复 assemble 不重复停止和任务，下一用户回合恢复注入', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  await h.assemble()
  h.inbox('算了，不要自动整理了，结合所有文档总结一下。')
  const first = await h.assemble()
  const second = await h.assemble()
  assert.ok(first.some((section) => section.name === 'itk:action:stop'))
  assert.ok(first.some((section) => section.name === 'itk:task'))
  assert.deepEqual(second, [])
  assert.match(h.command('guard', '/guard').text, /"stop":1/)

  h.inbox('继续。')
  const nextTurn = await h.assemble()
  assert.ok(nextTurn.some((section) => section.name === 'itk:task'))
})

test('同轮重复 assemble 不重复纠正', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  await h.assemble()
  h.inbox('我说的是插件。')
  const first = await h.assemble()
  const second = await h.assemble()
  assert.equal(first.filter((section) => section.name === 'itk:correction').length, 1)
  assert.deepEqual(second, [])
})

test('同轮重复 assemble 不重复 defer，动作计数不增加', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('先别执行')
  const first = await h.assemble()
  const second = await h.assemble()
  assert.equal(first.filter((section) => section.name === 'itk:action:defer').length, 1)
  assert.deepEqual(second, [])
  assert.match(h.command('guard', '/guard').text, /"defer":1/)
})

test('运行时 traceId 包含真实轮次，相同输入跨回合不复用', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  const first = h.command('itk', '/itk why').text.match(/trace ([a-f0-9]+)/)?.[1]
  h.inbox('帮我整理插件清单。')
  const second = h.command('itk', '/itk why').text.match(/trace ([a-f0-9]+)/)?.[1]
  assert.ok(first)
  assert.ok(second)
  assert.notEqual(first, second)
})

test('否定动作写入禁止项，“继续”不带错误对象', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  h.inbox('我不是让你删除文件。')
  const first = await h.assemble()
  const text = first.map((section) => section.text).join('\n')
  assert.match(text, /禁止/)
  assert.match(text, /删除文件/)
  assert.doesNotMatch(text, /对象是「删除文件」/)
  h.inbox('继续。')
  const second = await h.assemble()
  const continued = second.map((section) => section.text).join('\n')
  assert.match(continued, /禁止/)
  assert.match(continued, /删除文件/)
})

test('“这个才是我的目录”保留原任务，继续仍带原任务', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  h.inbox('这个才是我的目录。')
  const first = await h.assemble()
  const text = first.map((section) => section.text).join('\n')
  assert.match(text, /整理插件清单/)
  assert.match(text, /目录/)
  h.inbox('继续。')
  const second = await h.assemble()
  assert.match(second.map((section) => section.text).join('\n'), /整理插件清单/)
})

test('“另外，这次帮我检查发票”换任务，继续接发票', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  h.inbox('另外，这次帮我检查发票。')
  const first = await h.assemble()
  const names = first.map((section) => section.name)
  assert.ok(names.includes('itk:task'))
  assert.equal(names.includes('itk:temp'), false)
  assert.match(first.map((section) => section.text).join('\n'), /发票/)
  h.inbox('继续。')
  const second = await h.assemble()
  assert.match(second.map((section) => section.text).join('\n'), /发票/)
})

test('“我以后有空再看”不写偏好、不改任务', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  h.inbox('我以后有空再看。')
  assert.equal((await h.assemble()).length, 0)
  const status = h.command('itk', '/itk').text
  assert.match(status, /任务：帮我整理插件清单/)
  assert.match(status, /偏好：0 条/)
})

test('无上下文“可以”：澄清前工具被宿主拦截', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('可以。')
  const sections = await h.assemble()
  assert.ok(sections.some((section) => section.name === 'itk:clarify'))
  assert.equal(sections.some((section) => section.name === 'itk:task'), false)
  assert.equal((await h.preExecute('read')).kind, 'deny')
  assert.equal((await h.preExecute('pwsh')).kind, 'deny')
  assert.equal((await h.preExecute('ask_user_question')).kind, 'allow')
})

test('正常任务不拦截工具', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  assert.equal((await h.preExecute('read')).kind, 'allow')
})

test('完成后继续不复活，新任务可以开始', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  h.inbox('完成了。')
  assert.equal((await h.assemble()).length, 0)
  h.assistant('好的，已完成。')
  assert.match(h.command('itk', '/itk').text, /等待：completed/)
  h.inbox('继续。')
  const continued = await h.assemble()
  assert.equal(continued.some((section) => section.name === 'itk:task'), false)
  assert.match(continued.map((section) => section.text).join('\n'), /已完成/)
  h.inbox('帮我检查发票。')
  const next = await h.assemble()
  assert.match(next.map((section) => section.text).join('\n'), /发票/)
})

test('取消任务后继续不复活，另一任务接续', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  h.inbox('取消任务。')
  assert.equal((await h.assemble()).length, 0)
  assert.match(h.command('itk', '/itk').text, /等待：cancelled/)
  h.inbox('继续。')
  const continued = await h.assemble()
  assert.equal(continued.some((section) => section.name === 'itk:task'), false)
  assert.match(continued.map((section) => section.text).join('\n'), /已取消/)
  h.inbox('另外，帮我检查发票。')
  const next = await h.assemble()
  assert.match(next.map((section) => section.text).join('\n'), /发票/)
})

test('等待输入时的“可以”不确认，工具被拦', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我检查发票。')
  h.assistant('请把发票路径发给我。')
  h.inbox('可以。')
  const sections = await h.assemble()
  assert.ok(sections.some((section) => section.name === 'itk:clarify'))
  assert.equal(sections.some((section) => section.name === 'itk:task'), false)
  assert.match(h.command('itk', '/itk').text, /等待：awaiting_input/)
  assert.equal((await h.preExecute('read')).kind, 'deny')
})

test('等待确认时的“可以”生效，工具不拦', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  h.assistant('确认按方案 A 执行吗？')
  h.inbox('可以。')
  assert.equal((await h.preExecute('read')).kind, 'allow')
})

test('两次纠正合并：新对象与原禁令同时保留', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理文档。')
  h.inbox('我不是让你删除文件。')
  h.inbox('我指的是插件清单，不是测试记录。')
  h.inbox('继续。')
  const text = (await h.assemble()).map((section) => section.text).join('\n')
  assert.match(text, /插件清单/)
  assert.match(text, /删除文件/)
  assert.doesNotMatch(text, /对象是「删除文件」/)
})

test('个人打算“我以后用电脑看”不写偏好', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  h.inbox('我以后用电脑看。')
  assert.equal((await h.assemble()).length, 0)
  assert.match(h.command('itk', '/itk').text, /偏好：0 条/)
})

test('合成尾部标记不会进入持久化状态', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'state.json')
  const h = host(path)
  const tail = 'TAIL_SHOULD_NOT_PERSIST_1234567890'
  h.inbox(`${'整理说明'.repeat(80)}${tail}`)
  await h.assemble()
  assert.equal(readFileSync(path, 'utf8').includes(tail), false)
})

test('/itk replace 保留原作用域，删除后不再列出', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('以后评方案先给结论。')
  const listed = h.command('itk', '/itk prefs').text
  const id = listed.match(/p_[a-z0-9_]+/)?.[0]
  assert.ok(id)
  const replaced = h.command('itk', `/itk replace ${id} 评方案先给结论和风险`).text
  assert.match(replaced, /范围：方案评审/)
  assert.match(h.command('itk', '/itk prefs').text, /结论和风险/)
  assert.match(h.command('itk', `/itk forget ${id}`).text, /已删除/)
})

test('提醒允许不写禁令；短追问/前置条件不覆盖任务', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我检查插件。')
  h.inbox('我不是让你看一下吗只是。')
  const permission = await h.assemble()
  const permissionText = permission.map((section) => section.text).join('\n')
  assert.doesNotMatch(permissionText, /禁止「看一下/)
  assert.match(permissionText, /允许|看一下/)
  assert.match(h.command('itk', '/itk').text, /任务：帮我检查插件/)

  h.inbox('我们做过很多项目。')
  assert.match(h.command('itk', '/itk').text, /任务：帮我检查插件/)
  h.inbox('图片呢')
  assert.equal((await h.assemble()).length, 0)
  assert.match(h.command('itk', '/itk').text, /任务：帮我检查插件/)
  h.inbox('已经完成授权。')
  assert.match((await h.assemble()).map((section) => section.text).join('\n'), /帮我检查插件/)
  h.inbox('那继续。')
  assert.match((await h.assemble()).map((section) => section.text).join('\n'), /帮我检查插件/)
})

test('压缩事件后继续仍接当前任务，不依赖内存 lastDecision', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  await h.assemble()
  h.compact()
  h.inbox('继续。')
  const sections = await h.assemble()
  assert.match(sections.map((section) => section.text).join('\n'), /整理插件清单/)
})

test('跨天等待超时后先重新确认，工具被拦', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const state = join(dir, 'state.json')
  const store = createStore(state)
  const session = store.session('merged', true)
  session.task = '检查发票'
  session.taskId = 't1'
  session.waitingState = 'awaiting_input'
  session.waitingSince = Date.now() - 13 * 60 * 60 * 1000
  store.touch()
  store.save()

  const h = host(state)
  h.inbox('继续。')
  const sections = await h.assemble()
  assert.match(sections.map((section) => section.text).join('\n'), /等待已过期/)
  assert.equal((await h.preExecute('read')).kind, 'deny')
})
