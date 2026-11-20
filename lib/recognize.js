/**
 * recognize.js — 纯规则识别（零依赖、零模型调用、零写盘）
 *
 * 只回答一个问题：这句用户消息更像「授权执行」，还是更像「引用/翻译/询问/纠正/确认/叫停/范围限制」？
 * 识别结果只用来决定要不要注入一条短提示；它本身不是授权，插件也从不执行任何操作。
 */

export const RULE_TEXT = {
  quote:
    '用户是在引用、翻译或询问一句话/术语的意思，不是授权执行。只解释，不执行；同一句里若有其他明确任务，照常做。',
  defer:
    '用户要求先说明后果、等待决定：只回答影响，不执行，也不要把状态记为已授权。',
  correction:
    '用户正在纠正上文的假设。撤回旧目标/旧对象，按最新说法继续；不要把纠正当成新的执行指令。',
  confirm:
    '用户已确认但没指定方案。若上一轮只有一个明确方案，直接继续；若有多个方案，只问一个关键问题，不替用户选。',
  stop:
    '用户可能是在叫停、暂停或限制这一步。先停一下当前动作，确认是要停下还是只限制范围；不要擅自扩大，也不要把整件事直接取消。',
  limit:
    '用户在给任务划范围（例如只允许备份/小修，或不要大动），不是叫停。按已明确的范围继续；超出范围或大改前先问，不要整体取消。',
}

export const RULE_LABEL = {
  quote: '引用/翻译/术语',
  defer: '先说明再决定',
  correction: '纠正旧假设',
  confirm: '确认但未选方案',
  stop: '叫停/暂停',
  limit: '范围限制',
}

const ACTION_WORD =
  '(?:关闭|关掉|收起|隐藏|禁用|停用|卸载|移除|删除|删掉|执行|运行|打开|启动|继续|\\bclose\\b|\\bdisable\\b|\\buninstall\\b|\\bremove\\b|\\bdelete\\b|\\brun\\b|\\bexecute\\b|\\bstart\\b|\\bopen\\b|\\bcontinue\\b)'
const ACTION_RE = new RegExp(ACTION_WORD, 'i')

const QUOTE_LEAD =
  /(翻译|译成|译为|转述|改述|引用|原文|引号|这几个字|这四个字|这句话|这句|文档里|界面上|页面上|写着|我只是把|只是把|发给你|转给你|不要执行|不是让你|别执行|只是问|什么意思|是什么意思|怎么读|怎么念|translate|translation|quote|quoted|what does .* mean|meaning of)/i

const TERM_QUESTION = /(?:是什么意思|什么意思|指什么|含义是什么)/

const DEFER =
  /(先(告诉我|说明|解释|说|讲).{0,16}(后果|影响|风险|区别|会发生什么)|等我(决定|确认|回复|答复|考虑)|再等我|我还没决定|我还没想好|先别执行|先不执行|只是问|只想(知道|了解)|先说明|先说清楚|先讲(一下)?(后果|影响)|(tell|explain|show) me .{0,40}(consequences|impact|risk).{0,30}(before|first|then wait)|wait for my (decision|confirmation)|before i decide|i haven'?t decided|just (want to )?know .{0,30}(consequences|impact))/i

const NEG =
  '(?:(?<![类区分特级性识告])别(?!的|人|处)|先别|先不要|不要|请勿|勿|禁止|不用|取消|暂缓|停手|停下)'
const STOP_ACTION =
  '(?:关闭|关掉|禁用|停用|卸载|移除|删除|删掉|执行|继续|修改|改|写|编辑|选择|选|(?<![手])动(?!物|作|态|画|词|机|漫|人|手)|弄|跑|开始|运行|打开|启动)'
const STOP = new RegExp(`(?:${NEG})[^。；;，,\\n]{0,12}${STOP_ACTION}`, 'i')
const PAUSE = /(?:别着急|别急)[^。；;，,\\n]{0,8}(?:等(?:我|一下).{0,4}(?:说完|讲完)|先听我说完)|等(?:我|一下).{0,4}(?:说完|讲完)|等我说完/
const STOP_STANDALONE = /^(?:先不用[，,]|不用了|算了|不做了|不去了|没有必要了|没必要了|停手|停下|停止|取消|暂停)[。！!…，,\s]*$|^(?:没什么用|没用了)[，,]?/i
const STOP_CMD = /(?:现在|立刻|马上|先)\s*停止|停止[，,]\s*(?:不用|不要|别再)问/
const TASK_CONSTRAINT = /(?:只读|只回复|只输出|调研任务|任务书|仓库|只做|不许写|不要(?:读取或)?(?:修改|改|动)(?:任何)?文件|不要(?:读取或)?修改任何文件|不要(?:读取或)?动任何文件|(?:其他|其余|其它|别的)[^。；;\n]{0,12}不要(?:改|动|删))/
const BUG_NOUN = /(?:取消|关闭|删除|修改|执行)[^。；;\n]{0,16}(?:按钮|逻辑|功能|组件|绑定|问题|报错|没生效|不生效)/
const LIMIT = /(?:不要大(?:动|改)|别大(?:动|改)|可以小修|只小修|小修|别改结构|不要改结构|只(?:改|修|动|做)[^。；;\n]{0,12}(?:不要|别)|允许[^。；;\n]{0,8}(?:备份|小修)|记得备份[^。；;\n]{0,12}(?:不要大动|小修)|范围(?:内|外)|只做小修)/i
const TRANSLATE_LEAD = /(翻译|译成|译为|翻译成|translate)/i
const QUOTED_RE = /[“"「『‘'][^”"」』’']{0,200}[”"」』’']/g
const CORRECTION_CUE = /(?:你|刚才|刚刚|上(?:一)?(?:轮|条|次)|这轮|上面|前面|我的意思|我指的是|我说的是|我用的是|我不是|没让你|只是让你|不对|错了|吗|啊)/

const CONFIRM_AMBIGUOUS =
  /(都行|都可以|二选一|选哪个|哪个方案|两个方案|A\s*还是\s*B|B\s*还是\s*A|方案[一二三1-3]|第一个还是第二个|就按(?:这个|那个|上述)(?:方案|建议)(?:处理|执行|做)?|按(?:这个|上述)方案(?:处理|执行)|按你的建议|按建议|按你说的|即可|做成默认|默认的|^是的[，,]|either|whatever)/i

const EXPLICIT_CHOICE =
  /(?:我)?(?:已经)?(?:选|选定|选择|挑)(?:了)?\s*(?:方案|第)?[一二三1-3甲乙丙丁A-Ca-c](?:个|号|套)?|(?:就|按|用|走)(?:方案|第)[一二三1-3A-Ca-c](?:个|号|套)?|^(?:方案|第)?[一二三1-3A-Ca-c](?:个|号|套)?(?:方案)?[。！!…\s]*$/

const COMPARISON_Q =
  /(区别|差异|不同|哪个好|哪個好|哪个.{0,4}好|哪个更好|更适合|优缺点|优劣|怎么选|如何选|对比|比较|风险|成本|影响)/
const CHOICE_Q = /(A\s*还是\s*B|B\s*还是\s*A|选哪个|哪个方案|二选一)/i

const EXPLAIN =
  /(解释|讲讲|说说|介绍|什么是|是什么|为什么|原理|怎么工作|如何工作|explain|what is|how does)/i

const QUESTION =
  /([吗呢]|[？?]|能不能|是否|会不会|该不该|可不可以|对不对|是不是|行不行|好不好|对吗)/

// 称呼前缀只影响措辞，不影响判断。默认只认通用称呼；本地叫法（人名、宠物名、
// 产品昵称）由宿主通过 config.wakeWords 传入，不写死在源码里。
// 编译结果按列表缓存；wakeWords 每次调用显式传入，避免实例之间共享全局状态。
const DEFAULT_WAKE_WORDS = ['助手', '小助手', 'assistant', 'deepseek', 'dsh']
const compiled = new Map()

function buildNameLead(words) {
  const list = (Array.isArray(words) ? words : [])
    .map((word) => String(word ?? '').trim())
    .filter(Boolean)
  if (!list.length) return null
  const key = list.join('\u0000')
  if (compiled.has(key)) return compiled.get(key)
  const escaped = list.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const lead = new RegExp(`^(?:${escaped.join('|')})[，,、：:\\s]+`, 'i')
  compiled.set(key, lead)
  return lead
}

/** 去掉无意义的称呼前缀；wakeWords 未传时使用通用默认表。 */
export function stripName(text, wakeWords) {
  const list = wakeWords === undefined ? DEFAULT_WAKE_WORDS : wakeWords
  const lead = buildNameLead(list)
  const value = String(text ?? '')
  return (lead ? value.replace(lead, '') : value).trim()
}

/** 规范文本：去首尾空白、压空白、去掉 headless 运行器给任务加的前缀。 */
export function normalize(text, wakeWords) {
  return stripName(text, wakeWords)
    .replace(/^\s*headless\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 噪声：空串 / 纯 Unicode 标点或符号 / 显式省略号。 */
export function isNoise(text) {
  const t = normalize(text)
  if (t === '') return true
  if (/^[\s\p{P}\p{S}]+$/u.test(t)) return true
  if (/^(省略号|没啥|无|略|跳过)$/i.test(t)) return true
  return false
}

/** 长文/粘贴块：长文档、日志、指令块，不按口语回合判断。 */
export function isPasted(text) {
  const t = normalize(text)
  if (t.length > 600) return true
  if (/^(?:#|##|<|```|\*\*|Error:|Traceback|Exception|思考了|AGENTS\.md|You are |系统提示|任务书|Current DSH|working-directory|untrusted-memory)/i.test(t)) return true
  if (t.length > 300 && /(?:^|\n)\s*(?:\d+[.、]|[-*]\s|\|)/.test(t)) return true
  if (t.length > 240 && /(?:^|\s)\d+[.、]\s/.test(t)) return true
  return false
}

/** 提取引号内的片段（支持中英文常见引号）。 */
export function quotedSegments(text) {
  const t = String(text ?? '')
  const out = []
  const re = /[“"「『‘']([^”"」』’']{1,60})[”"」』’']/g
  let m
  while ((m = re.exec(t)) !== null) out.push(m[1])
  return out
}

/** 整句只是一个被引号包住的命令。 */
export function isEntireQuotedCommand(text) {
  const t = String(text ?? '').trim()
  const m = t.match(/^[“"「『‘']([^”"」』’']{1,60})[”"」』’']$/)
  return !!m && ACTION_RE.test(m[1])
}

/** 引号里出现命令词，并且句子在引用/翻译/解释这句话。 */
export function hasQuotedCommand(text) {
  const segs = quotedSegments(text)
  if (segs.length === 0) return false
  return segs.some((s) => ACTION_RE.test(s))
}

/** 纠正：口语里的“不对/错了/我的意思/我不是让你/不是这个…”；陈述式的“不是 A 而是 B”不算。 */
export function isCorrection(text) {
  const raw = normalize(text)
  const t = raw.replace(QUOTED_RE, ' ')
  if (/^不是(?!.*而是)/.test(t)) return true
  if (/^不对|(?<![对])不对(?:啊|呀|吧)?(?:$|[，,。；;])/.test(t)) return true
  if (/(?:^|[，,。；;])\s*不对/.test(t)) return true
  if (/(?:我的意思(?:是|指|就)|我指的是|我说的是|我用的是|我不是用|我不是让你|我没让你|谁让你|只是让你)/.test(t)) return true
  if (/(?:回答错|答错|又[^。；;\n]{0,8}漂移|搞错|看错|漏了|数错|算错|理解错(?:了|我的意思)|弄错|反了|搞反|更正|纠正(?:一下|你|我|这个|刚才|说法|结论|错误))/.test(t)) return true
  if (/(?:我刚才|刚才|之前|上面|上一轮|上一条|这轮)说(?:的)?不是/.test(t)) return true
  if (/(?:你|我)没(?:有)?(?:让|说|要求|叫)/.test(t)) return true
  if (/(?:撤回|收回)[^。；;\n]{0,6}(?:假设|说法|刚才|判断|结论)/.test(t)) return true
  if (/不是[^。；;\n]{0,30}[，,]\s*(?:而是|是)/.test(t) && CORRECTION_CUE.test(t)) return true
  if (/^你(?:不是|不是说).*[吗？?]/.test(t)) return true
  if (/^你(?:在干嘛|干嘛|怎么又).{0,16}(?:只是|不要|别|又)/.test(t)) return true
  if (/(?:i mean|i meant|to clarify|correction:)/i.test(t)) return true
  if (/not\s+[^,.;]{0,30}\bbut\b/i.test(t)) return true
  if (/(not|isn'?t|wasn'?t)\s+[^,.;]{0,30}[,;]\s*(?:it'?s|i mean|i meant)/i.test(t)) return true
  return false
}

/** 叫停/暂停/否定执行；为什么类疑问、任务约束、工程名词、引用内容不按 stop。 */
export function isStop(text) {
  const t = normalize(text)
  if (/^(?:为什么|为何)/.test(t)) return false
  if (isPasted(t)) return false
  if (/^先不用[，,]/.test(t)) return true
  if (STOP_STANDALONE.test(t)) return true
  if (/(我)?(改主意|不做了|不想做)/.test(t)) return true
  if (/取消(这个|那个|刚才|当前|这|那)*(任务|操作|方案|执行|动作|计划)/.test(t)) return true
  if (PAUSE.test(t)) return true
  if (STOP_CMD.test(t)) return true
  if (/(?:能不能|可不可以|能否|可以不可以)[^。；;，,\n]{0,4}(?:不要|别|先别)/.test(t)) return true
  if (QUESTION.test(t) && !/^(?:先别|不要|别|请勿|停|取消)/.test(t)) return false
  if (BUG_NOUN.test(t)) return false
  if (TASK_CONSTRAINT.test(t) && !/(?:先别|停手|停下|取消|暂停)/.test(t)) return false
  const outside = t.replace(QUOTED_RE, ' ')
  return STOP.test(outside)
}

/** 引用/翻译/询问一条命令或术语，或明确说“只是转述/别执行”。 */
export function isQuote(text) {
  const t = normalize(text)
  if (isEntireQuotedCommand(t)) return true
  const cleaned = t
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[A-Za-z]:[\\/]\S+/g, ' ')
    .replace(/`[^`]*`/g, ' ')
  const outside = cleaned.replace(QUOTED_RE, ' ')
  const explicitCommand = new RegExp(`(?:现在|请|帮我|立即|直接|马上)[^。；;\\n]{0,12}(?:${ACTION_WORD}|照做)`)
  if (explicitCommand.test(outside)) return false
  if (TRANSLATE_LEAD.test(t) && quotedSegments(t).length > 0) return true
  if (TERM_QUESTION.test(t)) return true
  const hasQuote = QUOTE_LEAD.test(t)
  if (!hasQuote) return false
  return hasQuotedCommand(cleaned) || ACTION_RE.test(cleaned)
}

/** 范围限制：允许小修/备份，但不要大动；不是叫停。 */
export function isLimit(text) {
  return LIMIT.test(normalize(text))
}

/** 先说明后果、等待决定。 */
export function isDefer(text) {
  return DEFER.test(normalize(text))
}

/** 确认回合或确认但未指定方案；普通比较/选择问句、已明确选方案不算。 */
export function isAmbiguousConfirm(text) {
  const t = normalize(text)
  if (EXPLICIT_CHOICE.test(t)) return false
  if (COMPARISON_Q.test(t)) return false
  if (QUESTION.test(t) && !CHOICE_Q.test(t)) return false
  return CONFIRM_AMBIGUOUS.test(t)
}

/** 主入口：返回 {kind, rule, reason}。rule=null 表示不注入。 */
export function classify(text, options = {}) {
  const t = normalize(text, options.wakeWords)
  if (isNoise(t)) {
    return { kind: 'noise', rule: null, reason: '省略号/空输入：不触发任何状态修改' }
  }
  if (isPasted(t)) {
    return { kind: 'pasted', rule: null, reason: '长文/粘贴块：先当文档，不按口语回合注入' }
  }
  if (isCorrection(t)) {
    return { kind: 'correction', rule: 'correction', reason: '用户纠正旧说法：撤回旧假设，不把它当新指令' }
  }
  // defer 必须先于 stop：文档把「先别执行」定义为等待决定，而非永久取消。
  if (isDefer(t)) {
    return { kind: 'defer', rule: 'defer', reason: '用户要求先说明后果、等待决定：不是执行授权' }
  }
  // quote 必须先于 stop：引号里的“不要删除文件”只是被翻译/引用的内容，不是用户叫停。
  if (isQuote(t)) {
    return { kind: 'quote', rule: 'quote', reason: '引用/翻译/询问命令或术语：不是执行授权' }
  }
  if (isLimit(t)) {
    return { kind: 'limit', rule: 'limit', reason: '用户只限制范围：不是叫停，按范围继续' }
  }
  if (isStop(t)) {
    return { kind: 'stop', rule: 'stop', reason: '用户叫停/暂停：先停一下，确认范围' }
  }
  if (isAmbiguousConfirm(t)) {
    return { kind: 'confirm', rule: 'confirm', reason: '确认回合：单方案继续，多方案只问一个关键问题' }
  }
  if (EXPLAIN.test(t)) {
    return { kind: 'explain', rule: null, reason: '解释请求：正常回答，不注入' }
  }
  if (QUESTION.test(t)) {
    return { kind: 'question', rule: null, reason: '普通疑问：正常回答，不注入' }
  }
  return { kind: 'other', rule: null, reason: '无明显歧义：不注入' }
}

/** 把规则渲染成最终的注入文本。 */
export function renderRule(rule) {
  const text = RULE_TEXT[rule]
  if (!text) return ''
  return `【回合护栏】${text}`
}
