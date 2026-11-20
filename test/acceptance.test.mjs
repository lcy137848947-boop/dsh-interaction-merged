import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { createStore } from '../lib/store.js'
import { stripName, classify } from '../lib/recognize.js'

function host(statePath, options = {}) {
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
  apply(ctx, { statePath, metrics: false, ...options })
  const agent = { session: { id: options.sessionId || 'acc-session' } }
  return {
    agent,
    inbox(text, source) {
      const message = { role: 'user', content: text }
      if (source) message.source = source
      handlers.get('agent/inbox/inserted')({ agent, message })
    },
    assistant(text) {
      handlers.get('session/event')(agent.session, { type: 'assistant/message', data: { message: { content: text } } })
    },
    async assemble() {
      const assembly = { sections: [] }
      await handlers.get('system-prompt/assemble')(assembly, { agent }, async () => assembly)
      return assembly.sections
    },
    command(name, rawInput) { return commands.get(name).handler({ agent, rawInput }) },
  }
}

async function waitingForFile(dir) {
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我检查报表。')
  await h.assemble()
  h.assistant('请把文件名发给我。')
  return h
}

test('三路对照 A：用户直接给出文件名，保留并接回原任务', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = await waitingForFile(dir)
  h.inbox('十一月销售.xlsx')
  const sections = await h.assemble()
  const text = sections.map((section) => section.text).join('\n')
  assert.match(text, /十一月销售\.xlsx/)
  assert.match(text, /帮我检查报表/)
})

test('三路对照 B：原生问答回复与直接输入同权', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = await waitingForFile(dir)
  h.inbox('十一月销售.xlsx', { kind: 'user-question-reply', callId: 'call-1', outcome: 'answered' })
  const sections = await h.assemble()
  const text = sections.map((section) => section.text).join('\n')
  assert.match(text, /十一月销售\.xlsx/)
  assert.match(text, /帮我检查报表/)
})

test('三路对照 C：记忆召回不覆盖当前任务', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = await waitingForFile(dir)
  h.inbox('十一月销售.xlsx', { kind: 'runtime-context' })
  assert.deepEqual(await h.assemble(), [])
  const status = h.command('itk', '/itk').text
  assert.match(status, /任务：帮我检查报表/)
  assert.match(status, /等待：awaiting_input/)
})

test('等待材料时的新指令不算答案', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = await waitingForFile(dir)
  h.inbox('帮我查一下另一个报表')
  const status = h.command('itk', '/itk').text
  assert.match(status, /任务：帮我查一下另一个报表/)
  assert.doesNotMatch(status, /（补充：/)
})

test('引用里的文件名不会被过滤掉', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('请检查“十一月销售.xlsx”。')
  const sections = await h.assemble()
  const text = sections.map((section) => section.text).join('\n')
  assert.match(text, /十一月销售\.xlsx/)
})

test('开关写入失败时命令报错并回滚', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const statePath = join(dir, 'state.json')
  mkdirSync(statePath) // 用目录占位：状态文件不可写
  const h = host(statePath)
  const result = h.command('itk', '/itk off')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /写入失败/)
  assert.match(h.command('itk', '/itk').text, /合并交互插件：已启用/)
})

test('配置层禁用时 /itk on 不谎报生效', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'), { enabled: false })
  const result = h.command('itk', '/itk on')
  assert.match(result.text, /配置层 enabled=false/)
  assert.match(h.command('itk', '/itk').text, /实际状态：不处理消息/)
})

test('一条消息里的临时要求和长期偏好分开存', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我整理插件清单。')
  await h.assemble()
  h.inbox('这次先给结论，以后都附出处。')
  await h.assemble()
  const prefs = h.command('itk', '/itk prefs').text
  assert.match(prefs, /附出处/)
  assert.doesNotMatch(prefs, /这次先给结论/)
  h.inbox('继续。')
  const sections = await h.assemble()
  const temp = sections.find((section) => section.name === 'itk:temp')
  assert.ok(temp, '临时要求应在本轮注入')
  assert.match(temp.text, /这次先给结论/)
})

test('只读状态命令不会占掉会话名额', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const statePath = join(dir, 'state.json')
  const a = host(statePath, { sessionId: 'session-a', maxSessions: 2 })
  a.inbox('帮我整理插件清单。')
  await a.assemble()
  const b = host(statePath, { sessionId: 'session-b', maxSessions: 2 })
  b.command('itk', '/itk')
  const c = host(statePath, { sessionId: 'session-c', maxSessions: 2 })
  c.command('itk', '/itk')
  assert.match(a.command('itk', '/itk').text, /任务：帮我整理插件清单/)
})

test('澄清轮要注入 itk:clarify，不能只拦工具不说话', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('可以。')
  const sections = await h.assemble()
  assert.ok(sections.some((section) => section.name === 'itk:clarify'))
})

test('回答轮必须把任务注入出去（quiet 不能挡住答案）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('可以。')
  await h.assemble()
  h.assistant('请把文件名发给我。')
  h.inbox('十一月销售.xlsx')
  const sections = await h.assemble()
  assert.ok(sections.some((section) => section.name === 'itk:task'))
  assert.match(sections.map((section) => section.text).join('\n'), /十一月销售\.xlsx/)
})

test('等待材料时“换个方案”不被当成材料拼进任务', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我检查报表。')
  await h.assemble()
  h.assistant('请把文件名发给我。')
  h.inbox('换个方案')
  const status = h.command('itk', '/itk').text
  assert.doesNotMatch(status, /（补充：换个方案）/)
})

test('任务接近上限时保留新答案而不是截掉它', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox(`帮我检查报表${'并逐项核对'.repeat(40)}。`)
  await h.assemble()
  h.assistant('请把文件名发给我。')
  h.inbox('十一月销售.xlsx')
  const status = h.command('itk', '/itk').text
  assert.match(status, /十一月销售\.xlsx/)
})

test('wakeWords 按调用生效，不互相覆盖', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.equal(stripName('阿甲，帮我整理清单。', ['阿甲']), '帮我整理清单。')
  assert.equal(stripName('阿甲，帮我整理清单。', ['阿乙']), '阿甲，帮我整理清单。')
  // 同一个文本，只有命中自己的称呼时才按“先不用”判成叫停。
  assert.equal(classify('阿甲，先不用，', { wakeWords: ['阿甲'] }).kind, 'stop')
  assert.notEqual(classify('阿甲，先不用，', { wakeWords: ['阿乙'] }).kind, 'stop')
})

test('澄清状态超过 5 分钟会自己过期，不再永久拦工具', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const statePath = join(dir, 'state.json')
  const h = host(statePath)
  h.inbox('可以。')
  await h.assemble()
  const raw = JSON.parse(readFileSync(statePath, 'utf8'))
  for (const key of Object.keys(raw.sessions)) raw.sessions[key].updatedAt = Date.now() - 10 * 60 * 1000
  h.inbox('帮我整理清单。')
  writeFileSync(statePath, JSON.stringify(raw, null, 2))
  const sections = await h.assemble()
  assert.equal(sections.some((section) => section.name === 'itk:clarify'), false)
})

test('带称呼的“继续”保持原任务', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'), { wakeWords: ['阿甲'] })
  h.inbox('帮我整理清单。')
  await h.assemble()
  h.inbox('阿甲，继续。')
  await h.assemble()
  assert.match(h.command('itk', '/itk').text, /任务：帮我整理清单/)
})

test('“哪一列”式追问按等待处理，回答不覆盖任务', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我检查报表。')
  await h.assemble()
  h.assistant('请说明要检查哪一列。')
  h.inbox('C列')
  await h.assemble()
  const status = h.command('itk', '/itk').text
  assert.match(status, /任务：帮我检查报表/)
  assert.match(status, /补充：C列/)
})

test('连续追问的回答都挂回原任务', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我检查报表。')
  await h.assemble()
  h.assistant('请把文件名发给我。')
  h.inbox('a.xlsx')
  await h.assemble()
  h.assistant('请说明要检查哪一列。')
  h.inbox('C列')
  await h.assemble()
  h.assistant('请说明口径。')
  h.inbox('按含税')
  await h.assemble()
  const status = h.command('itk', '/itk').text
  assert.match(status, /任务：帮我检查报表/)
  assert.match(status, /a\.xlsx/)
  assert.match(status, /C列/)
  assert.match(status, /按含税/)
})

test('等待材料时“谢谢”既不进材料也不开新任务', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  h.inbox('帮我检查报表。')
  await h.assemble()
  h.assistant('请把文件名发给我。')
  h.inbox('谢谢')
  await h.assemble()
  const status = h.command('itk', '/itk').text
  assert.match(status, /任务：帮我检查报表/)
  assert.doesNotMatch(status, /补充：谢谢/)
})

test('未知子命令报错而不是假装成功', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const h = host(join(dir, 'state.json'))
  const result = h.command('itk', '/itk 状态')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /未知子命令/)
})

test('诊断输出对外部提示块脱敏，raw 才显示原名', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const statePath = join(dir, 'state.json')
  const store = createStore(statePath)
  store.session('acc-session', true)
  store.setLastInjection('acc-session', ['itk:task', 'client-project-example'], 12, 'trace-x')
  const h = host(statePath)
  const safe = h.command('itk', '/itk why').text
  assert.match(safe, /外部块 1/)
  assert.doesNotMatch(safe, /client-project-example/)
  const raw = h.command('itk', '/itk why raw').text
  assert.match(raw, /client-project-example/)
})
