import { apply } from '../../index.js'

const [statePath, prompt] = process.argv.slice(2)
if (!statePath || !prompt) throw new Error('usage: restart-turn.mjs <statePath> <prompt>')

const handlers = new Map()
const ctx = {
  logger: { info() {} },
  on(event, handler) { handlers.set(event, handler); return () => {} },
  effect(fn) { fn() },
  get() { return undefined },
}
apply(ctx, { statePath, metrics: false })
const agent = { session: { id: 'restart' } }
handlers.get('agent/inbox/inserted')({ agent, message: { role: 'user', content: prompt } })
const assembly = { sections: [] }
await handlers.get('system-prompt/assemble')(assembly, { agent }, async () => assembly)

// Simulate the DSH lifetime event that used to delete session state.
const disposed = handlers.get('session/disposed')
if (disposed) disposed(agent.session)

console.log(JSON.stringify(assembly.sections.map((section) => section.name)))
