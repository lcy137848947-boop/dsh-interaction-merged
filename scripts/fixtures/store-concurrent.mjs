import { existsSync, writeFileSync } from 'node:fs'
import { createStore } from '../../lib/store.js'

const [statePath, readyFile, goFile, payloadJson] = process.argv.slice(2)
const payload = JSON.parse(payloadJson)
const store = createStore(statePath)
writeFileSync(readyFile, 'ready', 'utf8')
while (!existsSync(goFile)) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10) } catch { /* ignore */ }
}
const session = store.session(payload.sessionId, true)
if (payload.task !== undefined) session.task = payload.task
if (payload.temp !== undefined) session.temp = payload.temp
if (payload.correction !== undefined) session.correction = payload.correction
if (payload.guardEnabled !== undefined) store.setGuardEnabled(payload.guardEnabled)
if (payload.enabled !== undefined) store.setEnabled(payload.enabled)
if (payload.pref) store.addPreference(payload.pref)
store.touch()
const result = store.save()
if (!result.wrote) throw new Error('save failed')
console.log('ok')
