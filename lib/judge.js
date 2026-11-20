/**
 * Joint contract prototype (offline only).
 *
 * It merges the existing pure classifiers; it does not register hooks, write
 * state, or inject prompts. This is the "shared judgment" fixture used to test
 * the contract before touching either plugin runtime.
 */
import { createHash } from 'node:crypto'
import { classify as guardClassify } from './recognize.js'
import { detectTurn } from './core.js'

const OPINION = /(风险|更低|更高|更好|更差|可以|应该|需要|建议|觉得|认为|问题|优点|缺点|价值)/
const NEW_TASK_VERB = /(结合|总结|整理|写|做|查|看|分析|生成|发|改|列|给)/

export function judge(raw, context = {}) {
  const text = String(raw || '').trim()
  const guard = guardClassify(text, { wakeWords: context.wakeWords })
  const toolkit = detectTurn(text, context)
  const speechActs = []
  const actions = []
  let correction = null
  let preference = null
  let temporary = null
  let taskChange = null

  const say = (value) => {
    if (value && !speechActs.includes(value)) speechActs.push(value)
  }
  const act = (type, target = 'current_task', reason = '') => {
    if (!actions.some((item) => item.type === type && item.target === target)) {
      actions.push({ type, target, scope: target === 'previous_task' ? 'turn' : 'task', reason })
    }
  }

  // Control wins before state writes. defer must beat stop; quote beats stop.
  if (guard.kind === 'defer') {
    say('defer')
    act('defer', 'current_task', 'wait for consequences/decision')
    return finish({ text, context, guard, toolkit, speechActs, actions, correction, preference, temporary, taskChange })
  }
  if (guard.kind === 'quote') {
    say('quote')
    act('read_only', 'current_task', 'quoted/translated content is not authorization')
    return finish({ text, context, guard, toolkit, speechActs, actions, correction, preference, temporary, taskChange })
  }
  if (guard.kind === 'limit') {
    say('limit')
    act('limit', 'current_task', 'scope limit, not stop')
    return finish({ text, context, guard, toolkit, speechActs, actions, correction, preference, temporary, taskChange })
  }

  // Explicit long-term preference beats the word "不用" in "不用每次都...".
  // The same message may also carry a one-off requirement ("这次先给结论").
  if (toolkit.kind === 'preference') {
    preference = toolkit.preference
    temporary = toolkit.temporary || null
    say('preference')
    return finish({ text, context, guard, toolkit, speechActs, actions, correction, preference, temporary, taskChange })
  }

  // Explicit completion/cancellation beats guard's broad "取消" stop match.
  if (toolkit.kind === 'complete') {
    say('complete')
    return finish({ text, context, guard, toolkit, speechActs, actions, correction, preference, temporary, taskChange })
  }
  if (toolkit.kind === 'cancel') {
    say('cancel')
    return finish({ text, context, guard, toolkit, speechActs, actions, correction, preference, temporary, taskChange })
  }

  // Stop suppresses the old task, but an explicit second task may start.
  if (guard.kind === 'stop' || toolkit.kind === 'stop') {
    say('stop')
    act('stop', 'previous_task', 'stop/pause the previous task')
    const newTask = extractNewTask(text, toolkit)
    if (newTask) {
      taskChange = { newTask, resetTemporary: true }
      say('task_change')
      act('start', 'new_task', 'start a new task after stopping the old one')
    }
    return finish({ text, context, guard, toolkit, speechActs, actions, correction, preference, temporary, taskChange })
  }

  // Correction is a shared fact, not a guard action. Toolkit owns the state.
  if (toolkit.kind === 'correction') {
    correction = toolkit.correction
    say('correction')
    act('continue', 'current_task', 'correct the old object, keep the task')
  } else if (guard.kind === 'correction' && !isOpinion(text)) {
    correction = {
      object: '',
      from: '',
      raw: text,
      source: 'guard-correction',
    }
    say('correction')
    act('continue', 'current_task', 'correct the old assumption')
  }

  if (toolkit.kind === 'temporary') {
    temporary = toolkit.temporary
    say('temporary')
  }

  // “评一下这两个方案”是评价任务，不是“确认未选方案”。
  // Guard 的 confirm 规则会因为“两个方案”命中；这里让明确的评价动词优先。
  if (toolkit.kind === 'task' && /(评|比较|分析|看看|评估|对比|推荐|选)/.test(text)) {
    say('task')
    act('start', 'new_task', 'evaluate/compare task, not a confirmation')
    return finish({ text, context, guard, toolkit, speechActs, actions, correction, preference, temporary, taskChange })
  }

  if (guard.kind === 'confirm' || toolkit.kind === 'confirm') {
    say('confirm')
    act('confirm', 'current_task', 'confirm only when prior context is pending')
    return finish({ text, context, guard, toolkit, speechActs, actions, correction, preference, temporary, taskChange })
  }

  if (toolkit.kind === 'task_change') {
    taskChange = { newTask: text, resetTemporary: true }
    say('task_change')
    act('start', 'new_task', 'explicit task change')
    return finish({ text, context, guard, toolkit, speechActs, actions, correction, preference, temporary, taskChange })
  }

  if (toolkit.kind === 'task' && !isOpinionStatement(text)) {
    say('task')
    act('start', 'new_task', 'ordinary task')
  } else if (toolkit.kind === 'continue') {
    say('continue')
    act('continue', 'current_task', 'continue the current task')
  } else if (toolkit.kind === 'question' || guard.kind === 'question' || guard.kind === 'explain') {
    say('question')
  } else if (!speechActs.length) {
    say('unknown')
  }

  return finish({ text, context, guard, toolkit, speechActs, actions, correction, preference, temporary, taskChange })
}

function finish({ text, context, guard, toolkit, speechActs, actions, correction, preference, temporary, taskChange }) {
  const both = Boolean(guard.rule) && toolkit.confidence >= 0.65
  const one = Boolean(guard.rule) || toolkit.confidence >= 0.65
  return {
    traceId: traceOf(text, context),
    kind: actions[0]?.type || speechActs[0] || 'unknown',
    speechActs,
    actions,
    correction,
    taskChange,
    temporary,
    preference,
    confidence: both ? 'high' : one ? 'medium' : 'low',
    requiresClarification: Boolean(toolkit.requiresClarification),
    evidence: [],
    reason: [guard.reason, ...(toolkit.reason || [])].filter(Boolean),
  }
}

function extractNewTask(text, toolkit) {
  if (toolkit.kind === 'task_change') return text.slice(0, 160)
  let after = text
    .replace(/^.*?(?:算了|先不用[，,]?)/, '')
    .trim()
  after = after.replace(/^(?:不要|别)[^，,。；;]*?了?[，,\s]*/, '').trim()
  if (!after || /^(我|先我|先给|先发|不要|别|先别|不用)/.test(after)) return ''
  const clauses = after.split(/[，,]/).map((part) => part.trim()).filter(Boolean)
  const candidate = clauses.find((part) => NEW_TASK_VERB.test(part)
    && !/^(我|不要|别|不用|先)/.test(part)
    && !/^(自动整理|整理归档)/.test(part))
  return candidate ? candidate.slice(0, 160) : ''
}

function isOpinion(text) {
  return /我的意思/.test(text) && OPINION.test(text)
}

function isOpinionStatement(text) {
  return /^我的意思/.test(text) && OPINION.test(text)
}

function traceOf(text, context) {
  return createHash('sha256')
    .update(JSON.stringify({
      text,
      sessionId: context.sessionId || '',
      turn: context.turn || 0,
      lastAssistant: context.lastAssistant || '',
      waitingState: context.waitingState || '',
    }))
    .digest('hex')
    .slice(0, 16)
}
