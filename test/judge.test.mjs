import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judge } from '../lib/judge.js'

function types(result) {
  return result.actions.map((action) => `${action.type}:${action.target}`)
}

test('停止旧任务 + 开始新任务可以同时成立', () => {
  const result = judge('算了，不要自动整理了，结合所有文档总结一下')
  assert.ok(result.speechActs.includes('stop'))
  assert.ok(result.speechActs.includes('task_change'))
  assert.ok(types(result).includes('stop:previous_task'))
  assert.ok(types(result).includes('start:new_task'))
  assert.match(result.taskChange.newTask, /结合所有文档/)
  assert.equal(result.preference, null)
})

test('“先不用，我先发给对方看”只停止，不开新任务', () => {
  const result = judge('先不用，我先发给对方看')
  assert.ok(result.speechActs.includes('stop'))
  assert.equal(result.actions.some((action) => action.type === 'start'), false)
  assert.equal(result.taskChange, null)
})

test('“不要改文件”是任务约束，不是停止', () => {
  const result = judge('帮我整理这两个文档，先列目录。不要改文件。')
  assert.equal(result.speechActs.includes('stop'), false)
  assert.ok(result.actions.some((action) => action.type === 'start'))
})

test('“我不是让你删除文件”是禁止动作，不是对象', () => {
  const result = judge('我不是让你删除文件', { task: '整理插件清单', taskId: 't1' })
  assert.equal(result.correction.object, '')
  assert.equal(result.correction.forbidden, '删除文件')
  assert.equal(result.speechActs.includes('correction'), true)
})

test('“我不是让你看一下吗”是提醒允许，不是禁止', () => {
  const result = judge('我不是让你看一下吗只是', { task: '检查插件', taskId: 't1' })
  assert.equal(result.correction.forbidden, undefined)
  assert.equal(result.correction.permission, '看一下')
  assert.equal(result.correction.object, '')
})

test('“我们做过很多项目”是上下文补充，不是新任务', () => {
  const result = judge('我们做过很多项目', { task: '整理插件清单', taskId: 't1' })
  assert.equal(result.speechActs.includes('task'), false)
  assert.equal(result.actions.some((action) => action.type === 'start'), false)
})

test('任务里的“其他不要改”是约束，不是停止', () => {
  const result = judge('帮我改一个配置文件，只删两行，其他一个字都不要改。')
  assert.equal(result.speechActs.includes('stop'), false)
  assert.ok(result.actions.some((action) => action.type === 'start'))
})

test('“不去了，没有必要了”是停止', () => {
  const result = judge('那不去了，没有必要了。')
  assert.ok(result.speechActs.includes('stop'))
})

test('“把这次故障整理一下”是任务，不是临时风格要求', () => {
  const result = judge('把这次故障和清理过程整理一下。')
  assert.equal(result.speechActs.includes('temporary'), false)
  assert.ok(result.actions.some((action) => action.type === 'start'))
})

test('“别管题干，直接告诉我”是换焦点纠正', () => {
  const result = judge('别管题干不题干，直接告诉我被扣分了该怎么表现。')
  assert.ok(result.speechActs.includes('correction'))
  assert.equal(result.correction.kind, 'redirect')
})

test('“我不认，重来”是纠正，不是新任务', () => {
  const result = judge('你这个回答我不认，重来。')
  assert.ok(result.speechActs.includes('correction'))
  assert.equal(result.correction.kind, 'reject')
  assert.equal(result.actions.some((action) => action.type === 'start'), false)
})

test('“看对方会不会脑补”是调查任务，不是问句', () => {
  const result = judge('我写材料，题目里出现“负分”，看对方会不会脑补。')
  assert.ok(result.actions.some((action) => action.type === 'start'))
  assert.equal(result.speechActs.includes('question'), false)
})

test('“看看怎么回事”是调查任务，不是问句', () => {
  const result = judge('DSH 报执行器不可用，看看怎么回事。')
  assert.ok(result.actions.some((action) => action.type === 'start'))
})

test('“只说我的插件，别扯…”是回答风格偏好，不换任务', () => {
  const result = judge('只说我的插件，别扯融资和大模型部署。')
  assert.ok(result.speechActs.includes('preference'))
  assert.equal(result.actions.some((action) => action.type === 'start'), false)
})

test('“客观公正地说，不要画饼”是回答风格偏好，不换任务', () => {
  const result = judge('客观公正地说，不要画饼。')
  assert.ok(result.speechActs.includes('preference'))
  assert.equal(result.actions.some((action) => action.type === 'start'), false)
})

test('“接着…现在能启动了吗”是继续，不被问句覆盖', () => {
  const result = judge('接着上午那个迁移的事，现在能启动了吗？', { task: '迁移', taskId: 't1' })
  assert.ok(result.speechActs.includes('continue'))
  assert.equal(result.speechActs.includes('question'), false)
})

test('补上助手提问上下文后，“是的/对/可以”都确认', () => {
  for (const text of ['是的。', '对。', '可以。']) {
    const result = judge(text, { waitingState: 'awaiting_confirmation', task: '检查插件', taskId: 't1' })
    assert.ok(result.speechActs.includes('confirm'), text)
  }
})

test('“图片呢”是短追问，不是新任务', () => {
  const result = judge('图片呢', { task: '整理插件清单', taskId: 't1' })
  assert.equal(result.kind, 'question')
  assert.equal(result.actions.some((action) => action.type === 'start'), false)
})

test('“已经完成授权”是前置条件，不是新任务', () => {
  const result = judge('已经完成授权', { task: '整理插件清单', taskId: 't1' })
  assert.equal(result.actions.some((action) => action.type === 'start'), false)
})

test('“那继续”是继续，不是新任务', () => {
  const result = judge('那继续', { task: '整理插件清单', taskId: 't1' })
  assert.equal(result.speechActs.includes('continue'), true)
  assert.equal(result.actions.some((action) => action.type === 'start'), false)
})

test('“这个才是我的目录”是纠正，不是新任务', () => {
  const result = judge('这个才是我的目录', { task: '整理插件清单', taskId: 't1' })
  assert.equal(result.speechActs.includes('correction'), true)
  assert.equal(result.speechActs.includes('task'), false)
  assert.equal(result.correction.object, '目录')
})

test('“另外，这次帮我检查发票”是另一项任务，不是临时要求', () => {
  const result = judge('另外，这次帮我检查发票', { task: '整理插件清单', taskId: 't1' })
  assert.equal(result.speechActs.includes('task_change'), true)
  assert.equal(result.speechActs.includes('temporary'), false)
  assert.ok(result.actions.some((action) => action.type === 'start'))
})

test('“我以后有空再看”是个人打算，不是偏好', () => {
  const result = judge('我以后有空再看', { task: '整理插件清单', taskId: 't1' })
  assert.equal(result.preference, null)
  assert.equal(result.speechActs.includes('preference'), false)
})

test('“完成了”结束当前任务，不是新任务', () => {
  const result = judge('完成了', { task: '整理插件清单', taskId: 't1' })
  assert.ok(result.speechActs.includes('complete'))
  assert.equal(result.actions.length, 0)
  assert.equal(result.speechActs.includes('task'), false)
})

test('“取消任务”是取消，不是普通停止', () => {
  const result = judge('取消任务', { task: '整理插件清单', taskId: 't1' })
  assert.ok(result.speechActs.includes('cancel'))
  assert.equal(result.speechActs.includes('stop'), false)
})

test('“不用每次都手动加”是偏好，不是停止', () => {
  const result = judge('不用每次都手动加')
  assert.ok(result.speechActs.includes('preference'))
  assert.equal(result.speechActs.includes('stop'), false)
  assert.ok(result.preference)
})

test('“以后我重启是不是就能生效”不写偏好', () => {
  const result = judge('以后我重启是不是就能生效？')
  assert.equal(result.preference, null)
  assert.equal(result.speechActs.includes('preference'), false)
})

test('“以后评方案都先给结论，好吗”保存为偏好，不判确认', () => {
  const result = judge('以后评方案都先给结论，好吗？')
  assert.ok(result.preference)
  assert.equal(result.speechActs.includes('confirm'), false)
})

test('“评一下这两个方案”是评价任务，不是确认', () => {
  const result = judge('评一下这两个方案：A 便宜但慢，B 快但贵。')
  assert.equal(result.speechActs.includes('confirm'), false)
  assert.ok(result.actions.some((action) => action.type === 'start'))
})

test('“可以”没有上下文不确认', () => {
  const result = judge('可以')
  assert.equal(result.speechActs.includes('confirm'), false)
  assert.equal(result.actions.length, 0)
})

test('“可以”有等待确认上下文才确认', () => {
  const result = judge('可以', { waitingState: 'awaiting_confirmation' })
  assert.ok(result.speechActs.includes('confirm'))
  assert.ok(types(result).includes('confirm:current_task'))
})

test('“可以”在等待输入时不确认', () => {
  const result = judge('可以', { waitingState: 'awaiting_input', pendingAction: 'awaiting_input' })
  assert.equal(result.speechActs.includes('confirm'), false)
})

test('“先别执行”是 defer，不是 stop', () => {
  const result = judge('先别执行')
  assert.ok(result.speechActs.includes('defer'))
  assert.equal(result.speechActs.includes('stop'), false)
})

test('“不要大动，先备份”是范围限制，不是 stop', () => {
  const result = judge('不要大动，先备份')
  assert.ok(result.speechActs.includes('limit'))
  assert.equal(result.speechActs.includes('stop'), false)
})

test('“我的意思是这个方案风险更低”不是纠正', () => {
  const result = judge('我的意思是这个方案风险更低')
  assert.equal(result.correction, null)
  assert.equal(result.speechActs.includes('correction'), false)
})

test('“我说的是插件”是纠正事实，动作仍继续原任务', () => {
  const result = judge('我说的是插件')
  assert.equal(result.correction.object, '插件')
  assert.ok(result.speechActs.includes('correction'))
  assert.ok(types(result).includes('continue:current_task'))
})

test('traceId 可复现，换一句话会变', () => {
  const a = judge('我说的是插件', { sessionId: 's1', turn: 2 })
  const b = judge('我说的是插件', { sessionId: 's1', turn: 2 })
  const c = judge('我说的是记录', { sessionId: 's1', turn: 2 })
  assert.equal(a.traceId, b.traceId)
  assert.notEqual(a.traceId, c.traceId)
})

test('speechActs 不重复，actions 不重复', () => {
  const result = judge('我说的是插件')
  assert.equal(new Set(result.speechActs).size, result.speechActs.length)
  assert.equal(new Set(types(result)).size, types(result).length)
})
