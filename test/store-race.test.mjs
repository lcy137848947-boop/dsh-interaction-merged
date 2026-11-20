import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from '../lib/store.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const fixture = join(root, 'scripts', 'fixtures', 'store-concurrent.mjs')

function child(state, ready, go, payload) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [fixture, state, ready, go, JSON.stringify(payload)], {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let err = ''
    p.stderr.on('data', (chunk) => { err += chunk })
    p.on('exit', (code) => code === 0 ? resolve() : reject(new Error(err || `exit ${code}`)))
  })
}

async function waitFor(path) {
  for (let i = 0; i < 300; i++) {
    if (existsSync(path)) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timeout waiting for ${path}`)
}

test('两个进程真正同时写同一会话不同字段，字段都保留', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-race-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const state = join(dir, 'state.json')
  const readyA = join(dir, 'a.ready')
  const readyB = join(dir, 'b.ready')
  const go = join(dir, 'go')
  const a = child(state, readyA, go, { sessionId: 'same', task: '任务 A' })
  const b = child(state, readyB, go, { sessionId: 'same', temp: { text: '临时 B', active: true } })
  await Promise.all([waitFor(readyA), waitFor(readyB)])
  writeFileSync(go, 'go', 'utf8')
  await Promise.all([a, b])
  const reopened = createStore(state)
  const session = Object.values(reopened.state.sessions)[0]
  assert.equal(session.task, '任务 A')
  assert.equal(session.temp.text, '临时 B')
  assert.doesNotThrow(() => JSON.parse(readFileSync(state, 'utf8')))
})

test('两个进程真正同时添加偏好，两条都保留', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-race-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const state = join(dir, 'state.json')
  const readyA = join(dir, 'pa.ready')
  const readyB = join(dir, 'pb.ready')
  const go = join(dir, 'pgo')
  const a = child(state, readyA, go, { sessionId: 'p', pref: { text: '偏好 A' } })
  const b = child(state, readyB, go, { sessionId: 'p', pref: { text: '偏好 B' } })
  await Promise.all([waitFor(readyA), waitFor(readyB)])
  writeFileSync(go, 'go', 'utf8')
  await Promise.all([a, b])
  const reopened = createStore(state)
  const texts = reopened.state.prefs.map((pref) => pref.text).sort()
  assert.deepEqual(texts, ['偏好 A', '偏好 B'])
})

test('两个进程真正同时改开关和写任务，开关不被旧快照还原', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-race-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const state = join(dir, 'state.json')
  const readyA = join(dir, 'fa.ready')
  const readyB = join(dir, 'fb.ready')
  const go = join(dir, 'fgo')
  const a = child(state, readyA, go, { sessionId: 'flag', task: '任务保留' })
  const b = child(state, readyB, go, { sessionId: 'flag', guardEnabled: false, enabled: false })
  await Promise.all([waitFor(readyA), waitFor(readyB)])
  writeFileSync(go, 'go', 'utf8')
  await Promise.all([a, b])
  const reopened = createStore(state)
  assert.equal(reopened.state.guardEnabled, false)
  assert.equal(reopened.state.enabled, false)
  assert.equal(Object.values(reopened.state.sessions)[0].task, '任务保留')
})
