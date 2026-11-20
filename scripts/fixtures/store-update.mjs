import { createStore } from '../../lib/store.js'

const [statePath, sessionId, task] = process.argv.slice(2)
if (!statePath || !sessionId || !task) throw new Error('usage: store-update.mjs <statePath> <sessionId> <task>')
const store = createStore(statePath)
store.session(sessionId, true).task = task
store.touch()
const result = store.save()
if (!result.wrote) throw new Error('save failed')
console.log(JSON.stringify({ sessionId, task }))
