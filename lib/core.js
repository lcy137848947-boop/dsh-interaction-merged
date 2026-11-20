/**
 * v0.2 core: lightweight, context-aware turn classification.
 *
 * No model calls. The caller may pass a small context object:
 *   { task, taskId, lastAssistant, pendingAction, waitingState, correction, lastUser }
 *
 * The result is structured; `confidence` gates writes/injections. The old
 * `kind` and `correction/preference/temporary` fields stay backward-compatible
 * for existing callers and tests.
 */

const FUTURE = /(以后|今后|从现在开始|每次|一律)/
const PREFERENCE = /(以后|今后|从现在开始|每次|一律|都要|都按|默认(?:就|按|用|走|这样)|不用每次)/
const TEMP = /(这次|本轮|今天|暂时)/
const CONTINUE = /^(?:那(?:就)?|好|行|嗯)?[，,\s]*(?:继续|接着|然后|往下|按这个|就这样|继续吧|接着来)/
const TASK_CHANGE = /(换个话题|换个任务|另一个任务|新任务|另外|说点别的)/
const COMPLETE = /^(?:(?:任务|这个任务)?(?:已经|全部|都)?(?:做完|完成|搞定|结束)(?:了|啦)?|结束(?:这个)?任务)[。！!]?$/
const CANCEL = /^(?:取消(?:这个)?任务|这个任务不做了|不做了|不用继续了|任务取消)[。！!]?$/
const STOP = /(停止|停下|先停|先别|先不用|不用了|不用再问|别问了|算了|取消|不去了|没有必要了|没必要了)/
const QUESTION = /[?？]|(是否|能不能|可不可以|要不要|该不该|是不是|会不会|为什么|怎么|如何|什么|多少|哪个)/
const PRONOUN = /(这个|那个|它|这件事|那件事)/
const OPINION = /(风险|更低|更高|更好|更差|可以|应该|需要|建议|觉得|认为|问题|优点|缺点|价值)/
const HYPOTHETICAL = /(如果|假如|假设|要是|万一)/
const CONTEXT_SUPPLEMENT = /^(?:啊?我们(?:做过|已经|之前|上次|刚才|有)|(?:已经|已)(?:完成|给|提供|授权|确认|上传))/

const COMMON = new Set([
  '这个', '那个', '可以', '然后', '就是', '因为', '所以', '如果', '还是', '一个', '我们', '你们',
  '助手', '用户', '一下', '现在', '以后', '这次', '本轮', '每次', '默认', '都要', '都按',
])

export function normalize(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

export function detectTurn(raw, context = {}) {
  const text = normalize(raw)
  if (!text) return result('unknown', { confidence: 0.1, reason: ['空输入'] })

  const ctx = normalizeContext(context)
  // Experimental/instructional “看/检查……会不会/怎么回事” is an investigation task.
  if (/(?:看看|看|检查|测试|观察|验证)[^。；;\n]{0,30}(?:会不会|是否|有没有|怎么回事)/.test(text)) {
    return result('task', {
      confidence: 0.78,
      scope: 'task',
      targetTaskId: ctx.taskId,
      pendingAction: 'ready',
      shouldWrite: true,
      shouldInject: false,
      reason: ['调查/验证任务', '句中的会不会/怎么回事不是用户追问'],
    })
  }
  // 个人打算不是对助手的长期偏好，也不是新任务。
  if (/^我(?:以后|今后|之后)[^。；;\n]{0,24}(?:有空|再看|再说|再考虑|看情况|到时候|用[^。；;\n]{0,12}看)/.test(text)) {
    return result('unknown', {
      confidence: 0.3,
      scope: 'turn',
      targetTaskId: ctx.taskId,
      pendingAction: null,
      shouldWrite: false,
      shouldInject: false,
      reason: ['第一人称个人打算', '不写偏好、不改任务、不注入'],
    })
  }

  const correction = extractCorrection(text)
  if (!correction && CONTEXT_SUPPLEMENT.test(text)) {
    return result('continue', {
      confidence: 0.72,
      scope: 'task',
      targetTaskId: ctx.taskId,
      pendingAction: ctx.pendingAction,
      shouldWrite: Boolean(ctx.task || ctx.taskId),
      shouldInject: Boolean(ctx.task || ctx.taskId),
      reason: ['上下文补充/前置条件', '保留原任务，不覆盖'],
    })
  }
  if (correction && !isOpinionCorrection(text)) {
    return result('correction', {
      confidence: 0.9,
      scope: 'task',
      correction,
      targetTaskId: ctx.taskId,
      pendingAction: 'ready',
      shouldWrite: true,
      shouldInject: true,
      reason: ['显式对象纠正', correction.from ? `旧对象=${correction.from}` : '旧对象需上下文确认'],
    })
  }

  const preference = extractPreference(text)
  if (preference) {
    return result('preference', {
      confidence: 0.86,
      scope: 'persistent',
      preference,
      temporary: preference.mixedTemporary
        ? { ...preference.mixedTemporary, taskId: ctx.taskId, boundTask: ctx.task || '' }
        : null,
      targetTaskId: null,
      pendingAction: ctx.pendingAction,
      shouldWrite: true,
      shouldInject: false,
      reason: ['明确长期要求', /好吗|行吗|可以吗/.test(text) ? '确认语气不改变长期范围' : '非提问'],
    })
  }

  // 明确完成/取消：结束当前任务，后续“继续”不再复活。
  if (COMPLETE.test(text)) {
    return result('complete', {
      confidence: 0.86,
      scope: 'task',
      targetTaskId: ctx.taskId,
      pendingAction: 'completed',
      shouldWrite: true,
      shouldInject: false,
      reason: ['用户明确说任务完成', '清除任务/纠正/临时要求'],
    })
  }

  if (CANCEL.test(text)) {
    return result('cancel', {
      confidence: 0.86,
      scope: 'task',
      targetTaskId: ctx.taskId,
      pendingAction: 'cancelled',
      shouldWrite: true,
      shouldInject: false,
      reason: ['用户明确取消任务', '清除任务/纠正/临时要求'],
    })
  }

  // “另外/这次帮我检查发票”是另一项任务，不是旧任务的临时要求。
  if (TASK_CHANGE.test(text)) {
    return result('task_change', {
      confidence: 0.8,
      scope: 'task',
      targetTaskId: null,
      pendingAction: 'ready',
      shouldWrite: true,
      shouldInject: false,
      reason: ['显式换任务', '旧对象/临时要求应清除'],
    })
  }

  const temporary = extractTemporary(text)
  if (temporary) {
    return result('temporary', {
      confidence: 0.82,
      scope: 'task',
      temporary: { ...temporary, taskId: ctx.taskId, boundTask: ctx.task || '' },
      targetTaskId: ctx.taskId,
      pendingAction: 'ready',
      shouldWrite: true,
      shouldInject: false,
      reason: ['本轮/本次范围', ctx.task ? '绑定当前任务' : '尚无任务，等任务成立后再绑定'],
    })
  }

  if (isStop(text, ctx)) {
    return result('stop', {
      confidence: 0.84,
      scope: 'turn',
      targetTaskId: ctx.taskId,
      pendingAction: 'stopped',
      shouldWrite: true,
      shouldInject: false,
      reason: ['明确停止/先不用', ctx.pendingAction ? `此前等待=${ctx.pendingAction}` : '无等待状态'],
    })
  }

  if (isConfirm(text, ctx)) {
    return result('confirm', {
      confidence: 0.84,
      scope: 'task',
      targetTaskId: ctx.taskId,
      pendingAction: 'ready',
      shouldWrite: true,
      shouldInject: true,
      reason: ['上下文里有待确认方案', '用户确认继续'],
    })
  }

  if (CONTINUE.test(text)) {
    const hasAnchor = Boolean(ctx.task || ctx.taskId || ctx.temp)
    return result('continue', {
      confidence: 0.78,
      scope: 'task',
      targetTaskId: ctx.taskId,
      pendingAction: ctx.pendingAction,
      shouldWrite: hasAnchor,
      shouldInject: hasAnchor,
      reason: [hasAnchor ? '沿用当前任务/临时要求' : '继续但缺少任务锚点'],
    })
  }

  if (isQuestion(text)) {
    return result('question', {
      confidence: 0.72,
      scope: 'task',
      targetTaskId: ctx.taskId,
      pendingAction: ctx.pendingAction,
      shouldWrite: true,
      shouldInject: false,
      reason: ['问句/可行性问题', '保留当前任务，不写成偏好'],
    })
  }

  if (isBareConfirmation(text)) {
    return result('unknown', {
      confidence: 0.3,
      scope: 'turn',
      targetTaskId: null,
      pendingAction: null,
      shouldWrite: false,
      shouldInject: false,
      requiresClarification: true,
      reason: ['“可以/你看着办”缺少上一轮待确认上下文', '不得凭空确认'],
    })
  }

  return result('task', {
    confidence: HYPOTHETICAL.test(text) ? 0.55 : 0.66,
    scope: 'task',
    targetTaskId: ctx.taskId,
    pendingAction: 'ready',
    shouldWrite: !HYPOTHETICAL.test(text),
    shouldInject: false,
    reason: [HYPOTHETICAL.test(text) ? '假设/条件句，按普通输入处理' : '普通任务陈述'],
  })
}

export function extractCorrection(text) {
  const raw = String(text || '').slice(0, 260)
  const redirect = text.match(/(?:别管|不用管|不管)[^，,。；;\n]{0,20}[，,]\s*(?:直接)?(?:告诉|说|回答)/)
  if (redirect) {
    const target = text.match(/(?:直接)?(?:告诉|说|回答)(?:我|一下)?\s*([^，,。；;\n]+)/)
    return { object: clean(target?.[1] || ''), from: '题干假设', kind: 'redirect', raw, sourceTurn: null }
  }
  const reject = /(?:我不认|不接受|不认可|重来|重新回答|重新说)/.test(text)
  if (reject) return { object: '', from: '', kind: 'reject', raw, sourceTurn: null }
  const objectMatch = text.match(/我(?:指的|说的是|用的是|的意思(?:是|指|就是))是?\s*([^，,。；;\n]+)/)
  const fromMatch = text.match(/不是\s*([^，,。；;\n]+)/)
  if (objectMatch) {
    const object = clean(objectMatch[1])
    if (/我的意思/.test(text) && OPINION.test(object)) return null
    return { object, from: fromMatch ? clean(fromMatch[1]) : '', raw, sourceTurn: null }
  }
  const notBut = text.match(/不是\s*([^，,。；;\n]+)[，,]\s*是\s*([^，,。；;\n]+)/)
  if (notBut) return { object: clean(notBut[2]), from: clean(notBut[1]), raw, sourceTurn: null }
  const mistake = text.match(/我(?:输错|看错|搞错|记错|弄错)了?\s*([^，,。；;\n]+)/)
  if (mistake) return { object: clean(mistake[1]), from: '之前说错的值', raw, sourceTurn: null }
  // “我不是让你看一下吗”是提醒曾允许/要求该动作，不是禁止。
  const permissionReminder = text.match(/我(?:不是|没)让你\s*([^。？?]+?)(?:吗|嘛)/)
  if (permissionReminder) {
    return {
      object: '',
      from: '',
      permission: clean(permissionReminder[1]),
      kind: 'permission_reminder',
      raw,
      sourceTurn: null,
    }
  }
  // “我不是让你删除文件”：没有“吗”时才是禁止动作。
  const forbiddenLet = text.match(/我(?:不是|没有)让你\s*([^，,。；;\n]+)/)
  if (forbiddenLet) {
    return {
      object: '',
      from: '',
      forbidden: clean(forbiddenLet[1]),
      kind: 'forbidden_action',
      raw,
      sourceTurn: null,
    }
  }
  const demonstrative = text.match(/^(?:这个|那个|这才|这才是)\s*才是\s*(?:我的|你的|他的|她的)?\s*([^，,。；;\n]+)/)
  if (demonstrative) {
    return { object: clean(demonstrative[1]), from: '', kind: 'demonstrative', raw, sourceTurn: null }
  }
  const notLet = text.match(/我?不是让你\s*([^，,。；;\n]+)/)
  if (notLet) return { object: clean(notLet[1]), from: '扩大动作', raw, sourceTurn: null }
  if (/^不是/.test(text) && fromMatch) return { object: '', from: clean(fromMatch[1]), raw, sourceTurn: null }
  return null
}

export function extractPreference(text) {
  // Scoped response style: “只说我的插件，别扯…”“客观公正，不要画饼”.
  if (/^(?:只说|只讲|别扯|不要画饼|客观公正|客观地说)/.test(text)) {
    return { text: text.slice(0, 260), explicit: true, confirmationTagged: false, scopeLabel: '回答风格' }
  }
  // One message can carry both a one-off requirement and a long-term rule:
  // “这次先给结论，以后都附出处。” Only the long-term clause may persist.
  const mixed = splitMixedClauses(text)
  const source = mixed ? mixed.longText : text
  if (!PREFERENCE.test(source)) return null
  // “我以后有空再看”是个人打算，不是对助手的长期要求。
  if (/^我(?:以后|今后|之后)[^。；;\n]{0,24}(?:有空|再看|再说|再考虑|看情况|到时候|用[^。；;\n]{0,12}看)/.test(source)) return null
  if (TEMP.test(source) && !FUTURE.test(source)) return null
  if (HYPOTHETICAL.test(source)) return null
  // “以后我重启是不是就生效了”是问句；“以后……好吗”是确认语气的偏好。
  if (/(是不是|会不会|能不能|是否|什么时候|怎么|如何|多少|什么)/.test(source)) return null
  if (/[?？]/.test(source) && !/(好吗|行吗|可以吗)/.test(source)) return null
  if (/吗[?？]?\s*$/.test(source) && !/(好吗|行吗|可以吗|每次都要|以后都)/.test(source)) return null
  const scopeLabel = /(评方案|方案|评审)/.test(source)
    ? '方案评审'
    : /(回答|解释|说明)/.test(source)
      ? '回答风格'
      : /(整理|清单|目录)/.test(source)
        ? '整理输出'
        : '通用'
  const preference = {
    text: source.slice(0, 260),
    explicit: true,
    confirmationTagged: /好吗|行吗|可以吗/.test(source),
    scopeLabel,
  }
  if (mixed) preference.mixedTemporary = { text: mixed.tempText, remaining: 2, explicit: true, scope: 'task' }
  return preference
}

const TEMP_CLAUSE = /^(?:这次|这轮|本轮|今天|暂时)/
const LONG_CLAUSE = /(以后|今后|从现在开始|每次|一律|都要|都按|默认(?:就|按|用|走|这样))/

/**
 * Split “这次先给结论，以后都附出处。” into a one-off clause and a long-term
 * clause. Returns null unless both kinds are present, so single-purpose
 * messages behave exactly as before.
 */
export function splitMixedClauses(text) {
  const clauses = String(text || '')
    .split(/[。；;\n，,]/)
    .map((part) => part.trim())
    .filter(Boolean)
  if (clauses.length < 2) return null
  const temp = []
  const long = []
  for (const clause of clauses) {
    if (TEMP_CLAUSE.test(clause)) { temp.push(clause); continue }
    if (LONG_CLAUSE.test(clause)) { long.push(clause); continue }
    // A trailing modifier belongs to the clause before it.
    if (long.length) long.push(clause)
    else if (temp.length) temp.push(clause)
  }
  if (!temp.length || !long.length) return null
  return { tempText: temp.join('，'), longText: long.join('，') }
}

export function extractTemporary(text) {
  if (!TEMP.test(text)) return null
  if (/^先(别|不|停)/.test(text)) return null
  // “把这次故障整理一下”是任务内容，不是回答风格要求。
  if (/^(?:把|帮|给我|整理|生成|写|做|检查|分析|看看)/.test(text)
    && !/^(?:这次|本轮|今天)(?:回答|说|写|解释|用|只|简短|详细|短|慢|快)/.test(text)) return null
  if (isQuestion(text) && !/(这次|本轮|今天)/.test(text)) return null
  return { text: text.slice(0, 200), remaining: 2, explicit: true, scope: 'task' }
}

export function isContinuation(text) {
  return CONTINUE.test(normalize(text))
}

export function isTaskChange(text) {
  return TASK_CHANGE.test(normalize(text))
}

export function isQuestion(text) {
  const value = normalize(text)
  if (/^[^。；;\n]{1,12}呢\s*[?？]?$/.test(value)) return true
  return QUESTION.test(value)
}

export function hasAmbiguousPronoun(text) {
  return PRONOUN.test(normalize(text))
}

export function relevance(preference, text) {
  const a = grams(preference)
  const b = grams(text)
  if (!a.size || !b.size) return 0
  let overlap = 0
  for (const gram of a) if (b.has(gram)) overlap++
  return overlap
}

export function relevantPreferences(prefs, text, limit = 2) {
  return prefs
    .filter((pref) => pref && pref.enabled !== false && pref.status !== 'superseded' && relevance(pref.text || pref.rule, text) > 0)
    .sort((left, right) => relevance(right.text || right.rule, text) - relevance(left.text || left.rule, text))
    .slice(0, limit)
}

export function renderCorrection(correction) {
  if (correction?.kind === 'redirect') {
    return `用户要求跳过题干假设，直接回答「${correction.object || '新的焦点'}」。保留原任务，不要把它当成新任务。`
  }
  if (correction?.kind === 'reject') {
    return '用户不接受上一轮回答，要求重来；保留原任务，不要把“重来”当成新任务。'
  }
  if (correction?.permission) {
    return `用户是在提醒：你本来就被允许/被要求做「${correction.permission}」，不是禁止。保留原任务，只按后续范围收窄，不要把它当成新任务。`
  }
  if (correction?.forbidden) {
    return `用户明确禁止的动作：「${correction.forbidden}」。这不是对象纠正；不要把「${correction.forbidden}」当成对象，也不要执行它。`
  }
  const object = correction?.object || '用户刚指的对象'
  const from = correction?.from ? `，不是「${correction.from}」` : ''
  return `用户已把对象纠正为「${object}」${from}。继续原任务，不要把纠正当成新任务，也不要扩大到别的对象。`
}

export function renderTask(task, correction, context = {}) {
  const object = correction?.object ? `，对象是「${correction.object}」` : ''
  const forbidden = correction?.forbidden ? `；用户明确禁止「${correction.forbidden}」` : ''
  const from = correction?.from ? `；不是「${correction.from}」` : ''
  const waiting = context.waitingState ? `；当前状态=${context.waitingState}` : ''
  return `当前任务：${task || '沿用上一轮任务'}${object}${forbidden}${from}${waiting}。只补被纠正的部分，保留其他有效约束。能直接做就先做，未知字段可以留空；只有缺失信息会改变对象或交付结果时，才问一个能决定下一步的问题。`
}

export function renderPreference(text, pref = {}) {
  const scope = pref.scope ? `（范围：${pref.scope}）` : ''
  return `用户明确说过长期偏好${scope}：「${text}」。只在本轮相关任务里复用；不要把它扩成用户没说过的东西。`
}

export function renderTemporary(text) {
  return `当前任务的临时要求：「${text}」。只影响当前任务；任务完成、换任务、取消或会话结束后不再沿用。`
}

export function renderClarify() {
  return '用户用了“这个/那个/它”之类指代，当前对象可能不唯一。能从上文判断就直接做；只有两种理解会导致明显不同动作时，问一个能区分它们的问题，不要一次问一串。'
}

function result(kind, extra = {}) {
  return {
    kind,
    confidence: extra.confidence ?? 0.5,
    targetTaskId: extra.targetTaskId ?? null,
    scope: extra.scope ?? 'turn',
    correction: extra.correction ?? null,
    preference: extra.preference ?? null,
    temporary: extra.temporary ?? null,
    pendingAction: extra.pendingAction ?? null,
    shouldWrite: Boolean(extra.shouldWrite),
    shouldInject: Boolean(extra.shouldInject),
    requiresClarification: Boolean(extra.requiresClarification),
    reason: Array.isArray(extra.reason) ? extra.reason : [],
  }
}

function normalizeContext(context) {
  const task = String(context?.task || '').trim()
  const taskId = context?.taskId ? String(context.taskId) : null
  const waitingState = context?.waitingState || null
  const pendingAction = context?.pendingAction || waitingState || null
  const meaningfulWaiting = Boolean(waitingState && waitingState !== 'ready')
  const meaningfulPending = Boolean(pendingAction && pendingAction !== 'ready')
  return {
    task,
    taskId,
    waitingState,
    pendingAction,
    lastAssistant: String(context?.lastAssistant || ''),
    correction: context?.correction || null,
    temp: context?.temp || null,
    lastUser: String(context?.lastUser || ''),
    hasContext: Boolean(task || taskId || meaningfulWaiting || meaningfulPending || context?.lastAssistant || context?.lastUser || context?.correction || context?.temp),
  }
}

function isOpinionCorrection(text) {
  if (!/我的意思/.test(text)) return false
  return OPINION.test(text) && !/(不是|搞错|说错|指的是|说的是)/.test(text.replace(/我的意思(?:是|指|就是)?/, ''))
}

function isBareConfirmation(text) {
  return /^(可以|行|好的|好|嗯|对|是的|没问题|你看着办|你定|都行|都可以)[。！!…\s]*$/.test(text)
}

function isConfirm(text, ctx) {
  if (!isBareConfirmation(text)) return false
  if (/^(你看着办|你定|都行|都可以)[。！!…\s]*$/.test(text)) {
    return Boolean(ctx.task || ctx.taskId || ctx.waitingState === 'awaiting_confirmation' || ctx.pendingAction === 'awaiting_confirmation')
  }
  return Boolean(ctx.waitingState === 'awaiting_confirmation'
    || ctx.pendingAction === 'awaiting_confirmation')
}

function isStop(text, ctx) {
  if (!STOP.test(text)) return false
  // “不用每次都手动加”是长期改进要求，已在 preference 分支优先处理。
  if (/不用每次/.test(text)) return false
  // “不行”单独出现时先看上下文；无上下文不硬判停止。
  if (/^不行[。！!…\s]*$/.test(text)) return Boolean(ctx.waitingState || ctx.pendingAction || ctx.taskId || ctx.task)
  return true
}

function clean(value) {
  return String(value || '').replace(/[。；;，,、\s]+$/g, '').trim()
}

function grams(text) {
  const cleaned = String(text || '').toLowerCase().replace(/[^\p{Script=Han}a-z0-9]+/gu, '')
  if (cleaned.length < 2) return new Set(cleaned ? [cleaned] : [])
  const out = new Set()
  for (let index = 0; index < cleaned.length - 1; index++) {
    const gram = cleaned.slice(index, index + 2)
    if (!COMMON.has(gram)) out.add(gram)
  }
  return out
}
