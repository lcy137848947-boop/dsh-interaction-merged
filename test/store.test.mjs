import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStore } from '../lib/store.js'

test('两个进程式 store 更新不同会话，重开后都保留', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'state.json')
  const a = createStore(path)
  a.session('session-a', true).task = '任务 A'
  a.touch()
  assert.equal(a.save().wrote, true)

  const b = createStore(path)
  b.session('session-b', true).task = '任务 B'
  b.touch()
  assert.equal(b.save().wrote, true)

  const c = createStore(path)
  const tasks = Object.values(c.state.sessions).map((session) => session.task).sort()
  assert.deepEqual(tasks, ['任务 A', '任务 B'])
})

test('另一个进程改全局开关，本进程写任务不会把开关还原', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'state.json')
  const a = createStore(path)
  const b = createStore(path)
  b.setGuardEnabled(false)
  b.setEnabled(false)
  a.session('flag-session', true).task = '任务不应覆盖开关'
  a.touch()
  assert.equal(a.save().wrote, true)
  const reopened = createStore(path)
  assert.equal(reopened.state.guardEnabled, false)
  assert.equal(reopened.state.enabled, false)
  assert.equal(Object.values(reopened.state.sessions)[0].task, '任务不应覆盖开关')
})

test('损坏状态保留可恢复原件，不静默覆盖', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'state.json')
  writeFileSync(path, '{"schema":"dsh-interaction-merged/1","sessions":{', 'utf8')
  createStore(path)
  const backups = readdirSync(dir).filter((name) => name.includes('.corrupt-'))
  assert.ok(backups.length >= 1)
  assert.match(readFileSync(join(dir, backups[0]), 'utf8'), /"sessions"/)
})

test('替换偏好保留原作用域，替换不存在的 ID 不新增', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = createStore(join(dir, 'state.json'))
  const old = store.addPreference({ text: '评方案先给结论', scope: '方案评审' })
  const replaced = store.replacePreference(old.id, '评方案先给结论和风险')
  assert.equal(replaced.reason, 'replaced')
  assert.equal(replaced.pref.scope, '方案评审')
  assert.equal(store.state.prefs.find((pref) => pref.id === old.id).status, 'superseded')

  const count = store.state.prefs.length
  const missing = store.replacePreference('p_missing', '新规则')
  assert.equal(missing.reason, 'not_found')
  assert.equal(store.state.prefs.length, count)
})

test('跨天恢复：等待输入超时转为重新确认，普通任务保留', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'state.json')
  let clock = Date.parse('2026-11-20T10:00:00Z')
  const day1 = createStore(path, { now: () => clock })
  const session = day1.session('cross-day', true)
  session.task = '整理插件清单'
  session.taskId = 't1'
  session.waitingState = 'awaiting_input'
  session.waitingSince = clock
  session.temp = { text: '今天短一点', expiresAt: clock - 1, active: true }
  day1.touch()
  day1.save()

  clock += 24 * 60 * 60 * 1000
  const day2 = createStore(path, { now: () => clock })
  assert.equal(day2.expireWaiting(), true)
  const reopened = Object.values(day2.state.sessions)[0]
  assert.equal(reopened.task, '整理插件清单')
  assert.equal(reopened.waitingState, 'awaiting_reconfirm')
  assert.equal(reopened.temp, null)
  assert.equal(reopened.pending.reconfirm, true)
})

test('opId 重试不会重复应用', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = createStore(join(dir, 'state.json'))
  const first = store.mutate('add-once', (draft) => {
    draft.enabled = false
    return 'ok'
  })
  const second = store.mutate('add-once', (draft) => {
    draft.enabled = true
    return 'again'
  })
  assert.equal(first.duplicate, false)
  assert.equal(second.duplicate, true)
  assert.equal(store.state.enabled, false)
})

test('残留的死进程锁会被清理，保存仍能完成', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'state.json')
  writeFileSync(`${path}.lock`, JSON.stringify({ pid: 999999, at: 0 }), 'utf8')
  const store = createStore(path)
  store.session('lock-test', true).task = '锁恢复'
  store.touch()
  assert.equal(store.save().wrote, true)
})

test('旧 schema 迁移到 schemaVersion 2 并保留任务', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'state.json')
  writeFileSync(path, JSON.stringify({
    schema: 'dsh-interaction-merged/1',
    enabled: true,
    guardEnabled: true,
    prefs: [],
    sessions: {
      abc123: { task: '旧任务', taskId: 't_old', turn: 1, waitingState: 'ready' },
    },
  }), 'utf8')
  const store = createStore(path)
  assert.equal(store.state.schemaVersion, 2)
  assert.equal(Object.values(store.state.sessions)[0].task, '旧任务')
})
