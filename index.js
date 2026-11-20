/**
 * Merged interaction plugin: guard + task-state in one runtime.
 *
 * One inbox hook -> one judge -> one shared state file -> one assemble hook.
 * No model calls, no network, no third-party deps.
 */
import {
  relevantPreferences,
  renderClarify,
  renderCorrection,
  renderPreference,
  renderTask,
  renderTemporary,
} from './lib/core.js'
import { judge } from './lib/judge.js'
import { createStore } from './lib/store.js'

const NAME = 'dsh-interaction-merged'
const MAX_CHARS = 620
const ACTION_ORDER = 8400
const PREFS_ORDER = 8500
const DYNAMIC_ORDER = 8800
const STATE_ORDER = 8700
const PENDING_MAX_AGE_MS = 5 * 60 * 1000

function nowMs() { return Number(process.hrtime.bigint() / 1000000n) }

function endOfDay() {
  const date = new Date()
  date.setHours(23, 59, 59, 999)
  return date.getTime()
}

function log(ctx, message) {
  const line = `${NAME}: ${message}`
  try { if (typeof ctx?.logger?.info === 'function') ctx.logger.info(line) } catch { /* ignore */ }
  try { console.error(`[${line}]`) } catch { /* ignore */ }
}

function textOf(message) {
  if (typeof message?.content === 'string') return message.content
  if (!Array.isArray(message?.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
}

function sessionIdOf(value) {
  return value?.session?.id || value?.id || ''
}

function isSubagent(value) {
  const header = value?.session?.header || value?.header
  if (!header) return false
  return header.origin === 'subagent'
    || (typeof header.delegationDepth === 'number' && header.delegationDepth > 0)
}

function shortId(value) { return String(value || '').slice(-6) || 'unknown' }

// Messages a host injects on its own (memory recall, compaction checkpoints,
// scheduled context…) are not authored by the human: they must not create a
// turn, overwrite the current task, or answer a clarification. A native question
// reply carries the user's answer even when it is not a plain user message.
const CONTEXT_SOURCE_KINDS = new Set([
  'runtime-context',
  'untrusted-memory',
  'compact-checkpoint',
  'skill-invocation',
  'session-reference',
  'schedule',
  'plan-mode',
  'goal',
  'ptc-mode',
  'retry',
  'cordis-host-runner',
  'webhook',
])
const QUESTION_REPLY_KIND = 'user-question-reply'

function sourceKindOf(message) {
  return String(message?.source?.kind || '')
}

function isHumanMessage(message) {
  const kind = sourceKindOf(message)
  if (kind === QUESTION_REPLY_KIND) return true
  if (kind && CONTEXT_SOURCE_KINDS.has(kind)) return false
  return message?.role === 'user'
}

function turnIdOf(value) {
  const id = value?.id ?? value?.turnId ?? value?.turn_id
  return id === undefined || id === null ? '' : String(id)
}

/**
 * Idempotency key for "one injection per turn".
 * Prefer the host turn id: a streaming retry may assemble the same turn twice,
 * and a timestamp or a re-derived hash cannot tell those apart. The local turn
 * counter is only a fallback for hosts that do not expose a turn id.
 */
function sessionTurnKey(session, sessionId) {
  if (session?.turnKey) return session.turnKey
  return `${sessionId}#${session?.turn ?? 0}`
}

function inferWaiting(text) {
  const value = String(text || '').slice(-500)
  if (!value) return 'ready'
  if (/(请|麻烦)(你)?[^。；;\n]{0,20}(提供|发我|告诉我|给我|贴|补充)|需要你[^。；;\n]{0,20}(提供|确认|补充)/.test(value)) {
    return 'awaiting_input'
  }
  if (/[?？]\s*$|(要不要|是否|哪一个|哪个|确认|可以吗|好吗|行吗)/.test(value)) {
    return 'awaiting_confirmation'
  }
  return 'ready'
}

const ACTION_TEXT = {
  defer: '【联合】用户要求先说明后果、等待决定：只回答影响，不执行，也不要把状态记为已授权。',
  stop: '【联合】用户叫停/暂停旧任务：先停旧任务，不要继续注入旧任务的目标；若同一轮明确开了新任务，新任务可以继续。',
  read_only: '【联合】用户是在引用、翻译或询问一句话/术语，不是授权执行。只解释，不执行。',
  limit: '【联合】用户在给任务划范围，不是叫停。按已明确范围继续；超出范围或大改前先问。',
  confirm: '【联合】用户已确认但没指定方案：若上一轮只有一个明确方案，直接继续；多个方案只问一个关键问题。',
}

export function apply(ctx, config = {}) {
  const enabledByConfig = config.enabled !== false
  const store = createStore(config.statePath, { maxSessions: config.maxSessions })
  const maxPrefs = Number.isFinite(config.maxPrefs) ? Math.max(0, config.maxPrefs) : 2
  const maxChars = Number.isFinite(config.maxChars) ? Math.max(180, config.maxChars) : MAX_CHARS
  const metricsEnabled = config.metrics !== false
  const quiet = new Map()

  // Sessions evicted by the LRU leave their quiet flag behind; prune occasionally
  // so a long-running process does not accumulate one entry per dead session.
  function pruneQuiet() {
    if (quiet.size <= 32) return
    for (const key of quiet.keys()) if (!store.peek(key)) quiet.delete(key)
  }

  log(ctx, `active v0.3.1 (state=${store.file})`)

  // Host-level guard: when the only correct next move is a clarification,
  // block environment/write tools before dispatch. The model can still ask in
  // text, or use the dedicated question tool.
  try {
    ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
      if (!enabled()) return next()
      const agent = exec?.agent
      if (isSubagent(agent)) return next()
      const sessionId = sessionIdOf(agent)
      if (!sessionId) return next()
      const session = store.session(sessionId, false)
      if (!session?.pending?.clarify && !session?.pending?.reconfirm && session?.waitingState !== 'awaiting_reconfirm') return next()
      if (exec?.name === 'ask_user_question') return next()
      log(ctx, `tool blocked name=${exec?.name || 'unknown'} reason=clarify_first`)
      return { kind: 'deny', reason: '缺少必要上下文：不要先调用工具。请直接用一句话问用户所指的对象或下一步。' }
    }))
  } catch (err) { log(ctx, `tools/pre-execute unavailable: ${err?.message || String(err)}`) }


  function enabled() { return enabledByConfig && store.state.enabled }

  function save() {
    const result = store.save()
    if (metricsEnabled && result.wrote) log(ctx, `save ms=${result.ms} bytes=${result.bytes}`)
    return result
  }

  function contextOf(session) {
    return {
      task: session.task,
      taskId: session.taskId,
      lastAssistant: session.lastAssistant,
      waitingState: session.waitingState,
      pendingAction: session.pendingAction,
      correction: session.correction,
      temp: session.temp,
      lastUser: session.lastUser,
    }
  }

  function beginTurn(session, sessionId, hostTurnKey) {
    session.turn += 1
    session.turnKey = hostTurnKey || `${sessionId}#${session.turn}`
    session.turnKeyFromHost = Boolean(hostTurnKey)
  }

  /**
   * A task ends for more reasons than “完成”. Cancelling, failing, or an
   * interrupted turn must release task-bound temporary requirements too;
   * otherwise the boundary leaks into the next task.
   */
  function endTask(session, outcome) {
    session.task = ''
    session.taskId = null
    session.correction = null
    session.temp = null
    session.pending = outcome === 'completed'
      ? { complete: true }
      : outcome === 'cancelled'
        ? { cancel: true }
        : { failed: true }
    session.waitingState = outcome
    session.updatedAt = Date.now()
  }

  // While the assistant is waiting for a specific piece of information, a short
  // user message is that piece of information. It must keep the original task
  // and attach the answer instead of replacing the task with the raw value.
  function isAnswerTurn(session, text, decision) {
    const awaiting = Boolean(session.pending?.clarify) || session.waitingState === 'awaiting_input'
    if (!awaiting) return false
    const value = String(text || '').trim()
    if (!value || value.length > 200) return false
    const blocking = ['stop', 'complete', 'cancel', 'defer', 'question']
    if (blocking.some((kind) => decision.speechActs.includes(kind))) return false
    // “可以/好的” alone is not the missing material; it needs clarification.
    if (decision.requiresClarification) return false
    if (decision.actions.some((action) => action.type === 'stop' || action.type === 'defer')) return false
    // An explicit “ask first” state accepts the reply as the answer.
    if (session.pending?.clarify) return true
    // Otherwise only a value-shaped reply counts: path, file name, number, or a
    // short noun. A new instruction (“换个方案”, “查日志”) stays a normal turn.
    return looksLikeValue(value)
  }

  function looksLikeValue(value) {
    if (/[\\/]/.test(value)) return true
    if (/\.[A-Za-z0-9]{1,8}$/.test(value)) return true
    if (/\d/.test(value) && value.length <= 40) return true
    if (/(?:帮我|麻烦|请问|请|把|查|换|改|删|打开|执行|做|整理|分析|生成|继续|算了|取消|看看)/.test(value)) return false
    return value.length <= 24
  }

  function applyAnswer(session, sessionId, text, decision, hostTurnKey) {
    // The previous turn may still be flagged quiet; the answer must reach the
    // next assembly, otherwise the model never sees the updated task.
    quiet.delete(sessionId)
    beginTurn(session, sessionId, hostTurnKey)
    session.lastUser = String(text).slice(0, 220)
    session.lastDecision = decision
    session.pendingAction = 'ready'
    const answer = String(text).trim().slice(0, 120)
    if (session.task) {
      // Keep the answer, trim the task body: the new material matters more.
      const suffix = `（补充：${answer}）`
      const room = Math.max(0, 260 - suffix.length)
      session.task = `${session.task.slice(0, room)}${suffix}`.slice(0, 260)
      if (!session.taskId) session.taskId = `t_${session.turn}`
    } else {
      session.task = storeTask(answer)
      session.taskId = `t_${session.turn}`
    }
    session.pending = { task: true }
    session.waitingState = 'ready'
    session.waitingSince = null
    session.updatedAt = Date.now()
  }

  function observe(agent, text, meta = {}) {
    if (!enabled() || !text) return null
    if (isSubagent(agent)) return null
    const sessionId = sessionIdOf(agent)
    if (!sessionId) return null
    const started = nowMs()
    const refreshed = store.refresh()
    if (refreshed) quiet.delete(sessionId)
    store.expireWaiting()
    pruneQuiet()
    const session = store.session(sessionId, true)
    const hostTurnKey = turnIdOf(meta?.turn) || turnIdOf(meta?.message) || turnIdOf(meta?.turnId)
    const decision = judge(text, {
      ...contextOf(session),
      sessionId,
      turn: session.turn + 1,
      wakeWords: config.wakeWords,
    })
    const hasAction = decision.actions.length > 0 || decision.speechActs.includes('preference')

    // A short reply while the helper is waiting for material is the answer to
    // that question, not a new task. Native question replies (source kind
    // `user-question-reply`) take the same path as plain user messages.
    if (isAnswerTurn(session, text, decision)) {
      applyAnswer(session, sessionId, text, decision, hostTurnKey)
      store.metrics.observeMs = nowMs() - started
      save()
      log(ctx, `answer accepted source=${sourceKindOf(meta?.message) || 'plain'} chars=${String(text).length}`)
      return decision
    }

    if (!hasAction && decision.confidence === 'low') {
      if (decision.requiresClarification) {
        beginTurn(session, sessionId, hostTurnKey)
        session.lastUser = String(text).slice(0, 220)
        session.lastDecision = decision
        session.waitingState = 'awaiting_input'
        session.pending = { clarify: true }
        store.touch()
        save()
      }
      quiet.set(sessionId, { decision, at: Date.now() })
      store.metrics.observeMs = nowMs() - started
      log(ctx, `quiet kind=${decision.kind}${decision.requiresClarification ? ' clarify' : ''}`)
      return decision
    }
    quiet.delete(sessionId)

    beginTurn(session, sessionId, hostTurnKey)
    session.lastUser = String(text).slice(0, 220)
    session.lastDecision = decision
    session.pendingAction = decision.actions[0]?.type || null
    store.touch()

    const types = new Set(decision.actions.map((action) => action.type))
    const stop = types.has('stop')

    if (stop) {
      session.correction = null
      session.temp = null
      if (decision.taskChange?.newTask) {
        session.task = storeTask(decision.taskChange.newTask)
        session.taskId = `t_${session.turn}`
        session.waitingState = 'ready'
        session.pending = { action: true, task: true }
      } else {
        session.task = ''
        session.taskId = null
        session.waitingState = 'stopped'
        session.pending = { action: true }
      }
    } else if (types.has('defer') || types.has('read_only') || types.has('limit')) {
      session.pending = { action: true }
      session.waitingState = types.has('defer') ? 'awaiting_input' : 'ready'
      if (types.has('limit')) session.pendingAction = 'limit'
    } else if (decision.correction) {
      const previous = session.correction || {}
      const next = decision.correction
      session.correction = {
        ...previous,
        ...next,
        object: next.object || previous.object || '',
        from: next.from || previous.from || '',
        forbidden: next.forbidden || previous.forbidden || '',
        raw: next.raw || previous.raw || '',
        taskId: session.taskId,
        at: session.turn,
      }
      if (/(?:现在|已经)?可以(?:删除|删|改|动)|允许(?:删除|删|改|动)|不用再禁止/.test(String(text))) {
        session.correction.forbidden = ''
      }
      session.pending = { correction: true, task: true }
      session.waitingState = 'ready'
    } else if (decision.preference) {
      const pref = store.addPreference({
        text: decision.preference.text,
        scope: decision.preference.scopeLabel || '通用',
        sourceTurn: session.turn,
        forbidden: decision.preference.forbidden || ['不要扩大到别的任务或对象'],
      })
      if (decision.temporary) {
        // “这次先给结论，以后都附出处。”: keep the one-off part on this task,
        // persist only the long-term clause as a preference.
        const todayOnly = /(今天|今日)/.test(String(decision.temporary.text || ''))
        session.temp = {
          ...decision.temporary,
          taskId: session.taskId,
          boundTask: session.task,
          createdTurn: session.turn,
          active: true,
          scope: todayOnly ? 'day' : 'task',
          expiresAt: todayOnly ? endOfDay() : null,
          lastInjectedTurn: null,
        }
        session.pending = { tempNext: true }
        log(ctx, `mixed message: pref=${pref?.id || 'none'} temp=${session.temp.text}`)
      } else {
        session.pending = { skipPrefs: true }
      }
      session.waitingState = 'ready'
      log(ctx, `pref saved id=${pref?.id || 'none'} scope=${pref?.scope || '通用'}`)
    } else if (decision.temporary) {
      const todayOnly = /(今天|今日)/.test(String(text))
      session.temp = {
        ...decision.temporary,
        taskId: session.taskId,
        boundTask: session.task,
        createdTurn: session.turn,
        active: true,
        scope: todayOnly ? 'day' : 'task',
        expiresAt: todayOnly ? endOfDay() : null,
        lastInjectedTurn: null,
      }
      session.pending = { tempNext: true }
    } else if (types.has('confirm')) {
      session.pending = { action: true, task: true }
      session.waitingState = 'ready'
    } else if (decision.speechActs.includes('complete')) {
      endTask(session, 'completed')
    } else if (decision.speechActs.includes('cancel')) {
      endTask(session, 'cancelled')
    } else if (types.has('start')) {
      session.correction = null
      session.temp = null
      session.task = storeTask(decision.taskChange?.newTask || text)
      session.taskId = `t_${session.turn}`
      session.pending = { task: true }
      session.waitingState = 'ready'
    } else if (decision.speechActs.includes('question')) {
      session.pending = null
    } else if (decision.speechActs.includes('correction')) {
      session.pending = { correction: true, task: true }
    } else if (session.waitingState === 'awaiting_reconfirm') {
      session.pending = { reconfirm: true }
    } else {
      session.pending = { task: true }
    }
    session.updatedAt = Date.now()
    if (['awaiting_input', 'awaiting_confirmation', 'awaiting_reconfirm'].includes(session.waitingState)) {
      if (!session.waitingSince) session.waitingSince = Date.now()
    } else {
      session.waitingSince = null
    }

    store.metrics.observeMs = nowMs() - started
    save()
    log(ctx, `kind=${decision.kind} actions=${decision.actions.map((action) => action.type).join(',') || 'none'}`)
    return decision
  }

  function sectionsFor(sessionId, text) {
    const started = nowMs()
    const done = () => { store.metrics.assembleMs = nowMs() - started }
    store.refresh()
    store.expireWaiting()
    const session = store.session(sessionId)
    const decision = session.lastDecision
    // A pending clarification must reach the model even when the judge stayed
    // quiet: the guard already blocked tools, so the model needs the guidance.
    const clarifyPending = Boolean(session.pending?.clarify)
    if (!decision || (quiet.has(sessionId) && !clarifyPending)) {
      done()
      return []
    }

    // Exactly one injection per turn, keyed by the host turn id. A streaming
    // retry can assemble the same turn twice; a re-derived hash cannot tell a
    // retry from a new turn, but the turn id can. This also covers itk:state.
    const turnKey = sessionTurnKey(session, sessionId)
    if (session.lastInjectedTurnKey === turnKey) {
      done()
      return []
    }

    if (session.waitingState === 'awaiting_reconfirm') {
      done()
      return [{
        name: 'itk:state',
        order: STATE_ORDER,
        protect: true,
        text: '上一轮等待已过期；不要直接执行旧动作。先问用户是否继续，或让用户补齐所需信息。',
      }]
    }

    if (['completed', 'cancelled', 'failed'].includes(session.waitingState)) {
      done()
      if (!decision.speechActs.includes('continue')) return []
      const label = { completed: '已完成', cancelled: '已取消', failed: '上次没有完成' }[session.waitingState]
      const tail = session.waitingState === 'failed'
        ? '不要假装它已完成，也不要静默重跑；先说清上次停在哪里，或确认是否按原目标重试。'
        : '不要恢复旧任务；先确认新目标，或问是否收尾。'
      return [{
        name: 'itk:state',
        order: STATE_ORDER,
        protect: true,
        text: `上一任务${label}，当前没有进行中的任务。用户只说“继续”时，${tail}`,
      }]
    }

    const pending = session.pending || {}
    // A stale “ask first” state must not keep blocking tools. `pending` carries
    // no creation time, so use the session's last activity instead.
    if (pending.clarify && Date.now() - Number(session.updatedAt || 0) > PENDING_MAX_AGE_MS) {
      session.pending = null
      store.touch()
      done()
      return []
    }

    const sections = []
    const types = new Set(decision.actions.map((action) => action.type))
    const add = (name, order, body, protect = false) => {
      if (!body) return
      sections.push({ name, order, text: body, protect })
    }

    // 1) Control/action block; never truncated by the 620 budget.
    for (const action of decision.actions) {
      if (!store.state.guardEnabled) break
      const body = ACTION_TEXT[action.type] || ''
      if (!body) continue
      if (!actionAllowed(action.type)) continue
      add(`itk:action:${action.type}`, ACTION_ORDER, body, true)
    }

    // 2) Stop suppresses old task/correction/temp/prefs. A same-turn new task is allowed.
    if (!types.has('stop')) {
      if (decision.correction && session.correction) {
        add('itk:correction', DYNAMIC_ORDER, renderCorrection(session.correction))
      }
      if (session.pending?.task || types.has('start') || types.has('limit') || types.has('confirm')) {
        if (session.task) {
          add('itk:task', DYNAMIC_ORDER, renderTask(session.task, session.correction, { waitingState: session.waitingState }))
        }
      }
      if (session.temp && session.temp.active !== false
        && session.turn > (session.temp.createdTurn || 0)
        && (!session.temp.taskId || session.temp.taskId === session.taskId)
        && session.temp.lastInjectedTurn !== session.turn) {
        add('itk:temp', DYNAMIC_ORDER, renderTemporary(session.temp.text))
      }
      if (!session.pending?.skipPrefs && session.prefsInjectedTurn !== session.turn) {
        const prefs = relevantPreferences(store.state.prefs, text || session.task, maxPrefs)
        if (prefs.length) {
          add('itk:prefs', PREFS_ORDER, prefs.map((pref) => renderPreference(pref.text, pref)).join('\n'))
          session.lastPrefs = prefs.map((pref) => pref.text)
        }
      }
    } else if (decision.taskChange?.newTask) {
      add('itk:task', DYNAMIC_ORDER, renderTask(session.task, null, { waitingState: 'ready' }))
    }

    if (session.pending?.clarify && !decision.correction) {
      add('itk:clarify', DYNAMIC_ORDER, renderClarify())
    }

    // One budget. Protected control sections are always kept; low-priority blocks are trimmed first.
    let used = 0
    const protectedSections = sections.filter((section) => section.protect)
    const usedProtected = protectedSections.reduce((sum, section) => sum + section.text.length, 0)
    used = usedProtected
    const kept = protectedSections.slice()
    for (const section of sections) {
      if (section.protect) continue
      const remaining = maxChars - used
      if (remaining <= 0) continue
      if (section.text.length > remaining) {
        section.text = section.text.slice(0, Math.max(0, remaining - 1)) + '…'
      }
      used += section.text.length
      if (section.text.length) kept.push(section)
    }
    kept.sort((a, b) => a.order - b.order)
    store.metrics.assembleMs = nowMs() - started
    return kept
  }

  function actionAllowed(type) {
    // Safety actions are never rate-limited; one merged runtime already prevents
    // duplicate injection within a turn.
    return Boolean(store.state.guardEnabled && type)
  }

  function markAction(session, types) {
    if (!types.size) return
    session.lastRuleTurn = session.turn
    for (const type of types) {
      session.ruleCounts[type] = Number(session.ruleCounts[type] || 0) + 1
    }
  }

  try {
    ctx.effect(() => ctx.on('agent/inbox/inserted', (payload) => {
      try {
        if (!isHumanMessage(payload?.message)) return
        observe(payload.agent, textOf(payload.message), payload)
      } catch (err) { log(ctx, `inbox failed: ${err?.message || String(err)}`) }
    }))
  } catch (err) { log(ctx, `inbox hook failed: ${err?.message || String(err)}`) }

  // The host claims the message for a turn after insertion; that is where the
  // real turn id becomes available. Adopt it only before the turn is injected,
  // so a retry that assembles again is still recognised as the same turn.
  try {
    ctx.effect(() => ctx.on('agent/inbox/claimed', ({ agent, turn, message }) => {
      try {
        if (!enabled() || isSubagent(agent)) return
        const sessionId = sessionIdOf(agent)
        if (!sessionId) return
        const key = turnIdOf(turn) || turnIdOf(message)
        if (!key) return
        const session = store.peek(sessionId)
        if (!session || session.turnKeyFromHost) return
        if (session.lastInjectedTurnKey === sessionTurnKey(session, sessionId)) return
        session.turnKey = key
        session.turnKeyFromHost = true
        store.touch()
      } catch (err) { log(ctx, `inbox claimed failed: ${err?.message || String(err)}`) }
    }))
  } catch (err) { log(ctx, `inbox claimed hook failed: ${err?.message || String(err)}`) }

  // A failed turn ends the task just like 完成/取消: a task-bound temporary
  // requirement must not leak into the next task.
  try {
    ctx.effect(() => ctx.on('agent/error', ({ agent }) => {
      try {
        if (!enabled() || isSubagent(agent)) return
        const sessionId = sessionIdOf(agent)
        if (!sessionId) return
        const session = store.peek(sessionId)
        if (!session || ['completed', 'cancelled'].includes(session.waitingState)) return
        const hadTask = Boolean(session.task || session.taskId || session.temp)
        if (!hadTask) return
        endTask(session, 'failed')
        session.waitingSince = Date.now()
        store.touch()
        save()
        log(ctx, 'task failed: task-bound state released')
      } catch (err) { log(ctx, `agent error failed: ${err?.message || String(err)}`) }
    }))
  } catch (err) { log(ctx, `agent error hook failed: ${err?.message || String(err)}`) }

  try {
    ctx.effect(() => ctx.on('session/event', (session, event) => {
      try {
        const sessionId = sessionIdOf(session)
        // Compaction may replace the model-visible transcript; state is read
        // from disk again instead of trusting in-memory quiet/lastDecision.
        if (sessionId && event?.type && /compaction/i.test(String(event.type))) {
          quiet.delete(sessionId)
          store.refresh()
          return
        }
        // A turn that fails, is interrupted, or is aborted also ends the task.
        const status = String(event?.data?.turn?.status || event?.data?.status || '').toLowerCase()
        const failedType = Boolean(event?.type) && /(fail|error|abort|interrupt)/i.test(String(event.type))
        if (sessionId && enabled() && !isSubagent(session)
          && (failedType || ['failed', 'interrupted', 'aborted', 'canceled', 'cancelled'].includes(status))) {
          const current = store.peek(sessionId)
          const hadTask = Boolean(current && (current.task || current.taskId || current.temp))
          if (hadTask && !['completed', 'cancelled'].includes(current.waitingState)) {
            endTask(current, status === 'canceled' || status === 'cancelled' ? 'cancelled' : 'failed')
            current.waitingSince = Date.now()
            store.touch()
            save()
          }
          return
        }
        if (!enabled() || event?.type !== 'assistant/message' || isSubagent(session)) return
        const text = textOf(event.data?.message)
        if (!sessionId || !text) return
        const current = store.session(sessionId)
        // Terminal lifecycle states are not overwritten by a closing sentence.
        if (current.waitingState === 'completed' || current.waitingState === 'cancelled') {
          current.lastAssistant = text.slice(0, 300)
          store.touch()
          save()
          return
        }
        const waiting = inferWaiting(text)
        if (current.lastAssistant === text.slice(0, 300) && current.waitingState === waiting) return
        current.lastAssistant = text.slice(0, 300)
        current.waitingState = waiting
        current.pendingAction = waiting
        store.touch()
        save()
      } catch (err) { log(ctx, `session event failed: ${err?.message || String(err)}`) }
    }))
  } catch (err) { log(ctx, `session event hook failed: ${err?.message || String(err)}`) }

  // Do not delete session state on DSH 'session/disposed': headless runs dispose
  // the session when the process exits, and the next --session-id turn must still
  // see the task/correction. LRU eviction handles abandoned sessions instead.

  try {
    ctx.effect(() => ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      try {
        const sessionId = sessionIdOf(context?.agent)
        if (enabled() && sessionId && assembly && Array.isArray(assembly.sections)) {
          const current = store.session(sessionId)
          const text = textOf(context?.message) || current.lastUser
          const sections = sectionsFor(sessionId, text)
          const existing = new Set(assembly.sections.filter(Boolean).map((section) => section.name))
          for (const section of sections) {
            if (existing.has(section.name)) continue
            assembly.sections.push({
              name: section.name,
              order: section.order,
              text: section.text,
              interpolate: false,
            })
          }
          if (sections.length) {
            const session = store.session(sessionId)
            // A pending clarification keeps blocking tools until the user
            // answers; every other section is one-shot.
            if (!sections.some((section) => section.name === 'itk:clarify')) session.pending = null
            session.lastInjectedTurn = session.turn
            session.lastInjectedTurnKey = sessionTurnKey(session, sessionId)
            session.lastInjectedTraceId = session.lastDecision?.traceId || null
            if (sections.some((section) => section.name === 'itk:temp') && session.temp) {
              session.temp.lastInjectedTurn = session.turn
            }
            if (sections.some((section) => section.name === 'itk:prefs')) {
              session.prefsInjectedTurn = session.turn
            }
            const actionTypes = new Set(sections
              .filter((section) => section.name.startsWith('itk:action:'))
              .map((section) => section.name.slice('itk:action:'.length)))
            markAction(session, actionTypes)
            store.touch()
            const chars = sections.reduce((sum, section) => sum + section.text.length, 0)
            store.setLastInjection(sessionId, sections.map((section) => section.name), chars, session.lastDecision?.traceId)
            log(ctx, `inject sections=${sections.map((section) => section.name).join(',')} chars=${chars} trace=${session.lastDecision?.traceId || 'none'}`)
          }
        }
      } catch (err) { log(ctx, `assemble failed: ${err?.message || String(err)}`) }
      return next()
    }))
  } catch (err) { log(ctx, `assemble hook failed: ${err?.message || String(err)}`) }

  try {
    const commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined
    if (commands && typeof commands.register === 'function') {
      ctx.effect(() => commands.register({
        name: 'itk',
        description: '合并交互插件：任务/偏好/临时要求（/itk、prefs、forget、replace、off、on、why）',
        input: { hint: 'status | prefs | forget <id> | replace <id> <规则> | off | on | why' },
        handler: (invocation) => handleCommand('itk', invocation),
      }))
      ctx.effect(() => commands.register({
        name: 'guard',
        description: '合并交互插件：护栏动作/预算/trace（/guard、on、off、why）',
        input: { hint: 'status | on | off | why' },
        handler: (invocation) => handleCommand('guard', invocation),
      }))
    }
  } catch (err) { log(ctx, `command failed: ${err?.message || String(err)}`) }

  function readSession(sessionId) {
    return store.peek(sessionId) || {
      task: '',
      taskId: null,
      turn: 0,
      correction: null,
      temp: null,
      pending: null,
      waitingState: 'ready',
      pendingAction: null,
      lastDecision: null,
      ruleCounts: {},
      lastInjected: null,
      lastPrefs: [],
      turnKey: null,
      turnKeyFromHost: false,
    }
  }

  // Diagnostics should be safe to paste in public. Our own section names stay
  // readable; anything else (a prompt block from another plugin, possibly named
  // after a client or an internal project) is shown as 外部块 N.
  function redactSections(sections) {
    let external = 0
    return (Array.isArray(sections) ? sections : []).map((name) => {
      if (/^itk:/.test(String(name))) return name
      external += 1
      return `外部块 ${external}`
    })
  }

  function effectiveText() {
    if (!enabledByConfig) return '不处理消息（配置层 enabled=false，需改配置后重启）'
    return store.state.enabled ? '处理消息' : '不处理消息（/itk off）'
  }

  function handleCommand(kind, invocation) {
    const sessionId = sessionIdOf(invocation?.agent)
    const raw = String(invocation?.rawInput || '').trim().replace(/^\/?(itk|guard)\s*/, '')
    if (kind === 'guard') {
      if (raw === 'off' || raw === 'on') {
        const result = store.setGuardEnabled(raw === 'on')
        if (result.error) {
          return {
            kind: 'error',
            text: `护栏开关写入失败（${result.message || '状态文件不可写'}）；实际仍是${result.guardEnabled ? '已启用' : '已暂停'}。`,
          }
        }
        return { kind: 'success', text: `护栏动作：${result.guardEnabled ? '已启用' : '已暂停'}（已写入状态文件；任务状态仍由合并插件维护）。` }
      }
      if (raw === 'why' || raw === 'why raw') return { kind: 'success', text: whyText(sessionId, { reveal: raw === 'why raw' }) }
      const session = readSession(sessionId)
      return {
        kind: 'success',
        text: [
          `合并护栏：${store.state.guardEnabled ? '已启用' : '已暂停'}`,
          `最近动作：${session.lastDecision?.actions?.map((action) => action.type).join('、') || '无'}`,
          `traceId：${session.lastDecision?.traceId || '无'}`,
          `规则计数：${JSON.stringify(session.ruleCounts || {})}`,
          `上次注入：${session.lastInjected ? redactSections(session.lastInjected.sections).join('、') : '无'}`,
        ].join('\n'),
      }
    }
    if (raw === 'off' || raw === 'on') {
      const result = store.setEnabled(raw === 'on')
      const lines = []
      if (result.error) {
        lines.push(`开关写入失败（${result.message || '状态文件不可写'}）；运行时仍是${result.enabled ? '已启用' : '已暂停'}。`)
      } else {
        lines.push(`合并交互插件：${result.enabled ? '已启用' : '已暂停'}（已写入状态文件）。`)
      }
      lines.push(`实际状态：${effectiveText()}`)
      return { kind: result.error ? 'error' : 'success', text: lines.join('\n') }
    }
    if (raw === 'prefs') {
      const prefs = store.state.prefs.filter((pref) => pref.status === 'active' && pref.enabled !== false)
      if (!prefs.length) return { kind: 'success', text: '还没有已保存的长期偏好。' }
      return { kind: 'success', text: prefs.map((pref) => `${pref.id}｜${pref.scope}｜${pref.text}`).join('\n') + '\n用 /itk forget <id> 删除。' }
    }
    if (raw.startsWith('forget ')) {
      const id = raw.slice(7).trim()
      const removed = store.removePreference(id)
      const result = save()
      if (result.error) return { kind: 'error', text: `删除偏好 ${id} 未能写入状态文件（${result.message || '写入失败'}）。` }
      return { kind: 'success', text: removed ? `已删除偏好 ${id}。` : `没有找到偏好 ${id}。` }
    }
    if (raw.startsWith('replace ')) {
      const rest = raw.slice(8).trim()
      const space = rest.indexOf(' ')
      if (space <= 0) return { kind: 'success', text: '用法：/itk replace <id> <新规则>' }
      const id = rest.slice(0, space).trim()
      const text = rest.slice(space + 1).trim()
      const result = store.replacePreference(id, text)
      if (result.reason === 'not_found') return { kind: 'error', text: `没有找到偏好 ${id}，未新增。` }
      if (result.reason === 'empty') return { kind: 'error', text: '新规则为空，未保存。' }
      const saved = save()
      if (saved.error) return { kind: 'error', text: `新偏好未能写入状态文件（${saved.message || '写入失败'}）。` }
      return { kind: 'success', text: `已用新偏好取代 ${id}：${result.pref.id}（范围：${result.pref.scope}）` }
    }
    if (raw === 'why' || raw === 'why raw') return { kind: 'success', text: whyText(sessionId, { reveal: raw === 'why raw' }) }
    const session = readSession(sessionId)
    return {
      kind: 'success',
      text: [
        `合并交互插件：${store.state.enabled ? '已启用' : '已暂停'}`,
        `实际状态：${effectiveText()}`,
        `任务：${session.task || '未记录'}（${session.taskId || '无 id'}）`,
        `等待：${session.waitingState}｜动作：${session.lastDecision?.actions?.map((action) => action.type).join('、') || '无'}`,
        `纠正：${session.correction?.forbidden ? `禁止「${session.correction.forbidden}」` : session.correction?.object || '无'}｜临时：${session.temp?.text || '无'}`,
        `偏好：${store.state.prefs.filter((pref) => pref.status === 'active').length} 条`,
        `traceId：${session.lastDecision?.traceId || '无'}`,
        `上次注入：${session.lastInjected ? redactSections(session.lastInjected.sections).join('、') : '无'}`,
      ].join('\n'),
    }
  }

  function whyText(sessionId, options = {}) {
    const session = readSession(sessionId)
    const decision = session.lastDecision || quiet.get(sessionId)?.decision
    const last = session.lastInjected || store.state.lastInjected
    const lines = []
    if (decision) {
      lines.push(`判断：${decision.kind}｜置信 ${decision.confidence}｜trace ${decision.traceId}`)
      lines.push(`speechActs：${decision.speechActs.join('、') || '无'}`)
      lines.push(`actions：${decision.actions.map((action) => `${action.type}:${action.target}`).join('、') || '无'}`)
      lines.push(`依据：${decision.reason.join('；') || '无'}`)
    } else {
      lines.push('本会话还没有可写的判断。')
    }
    if (last) {
      const names = options.reveal ? last.sections : redactSections(last.sections)
      lines.push(`上次注入：${names.join('、')}｜${last.chars} 字符｜trace ${last.traceId || '无'}`)
      if (!options.reveal) lines.push('（外部提示块已脱敏；本机排查用 /itk why raw 看原名）')
    }
    lines.push(`本轮偏好：${session.lastPrefs?.length ? session.lastPrefs.join('；') : '无'}`)
    lines.push(`轮次键：${sessionTurnKey(session, sessionId)}（${session.turnKeyFromHost ? '宿主 turn id' : '本地计数兜底'}）`)
    lines.push(`耗时：observe=${store.metrics.observeMs}ms assemble=${store.metrics.assembleMs}ms save=${store.metrics.saveMs}ms`)
    lines.push(`状态：${store.metrics.stateBytes} 字节｜会话 ${Object.keys(store.state.sessions).length}`)
    return lines.join('\n')
  }

  function storeTask(text) {
    return String(text || '').trim().slice(0, 260)
  }
}
