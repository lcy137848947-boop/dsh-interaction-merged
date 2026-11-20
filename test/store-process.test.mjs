import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from '../lib/store.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const fixture = join(root, 'scripts', 'fixtures', 'store-update.mjs')

function run(statePath, sessionId, task) {
  const result = spawnSync(process.execPath, [fixture, statePath, sessionId, task], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout.trim())
}

test('两个独立 Node 进程更新不同会话，重开后都保留', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-store-process-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const state = join(dir, 'state.json')
  run(state, 'proc-a', '进程 A 的任务')
  run(state, 'proc-b', '进程 B 的任务')
  const reopened = createStore(state)
  const tasks = Object.values(reopened.state.sessions).map((session) => session.task).sort()
  assert.deepEqual(tasks, ['进程 A 的任务', '进程 B 的任务'])
})
