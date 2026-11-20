import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const fixture = join(root, 'scripts', 'fixtures', 'restart-turn.mjs')

function run(statePath, prompt) {
  const result = spawnSync(process.execPath, [fixture, statePath, prompt], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(result.stdout.trim())
}

test('跨进程重开后纠正轮仍带 task', () => {
  const dir = mkdtempSync(join(tmpdir(), 'merged-restart-'))
  try {
    const state = join(dir, 'state.json')
    const first = run(state, '帮我整理插件清单。')
    assert.ok(first.includes('itk:task'))
    const second = run(state, '我指的是插件，不是记录。')
    assert.ok(second.includes('itk:correction'), second.join(','))
    assert.ok(second.includes('itk:task'), second.join(','))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
