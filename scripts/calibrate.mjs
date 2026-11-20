#!/usr/bin/env node
/**
 * Local calibration runner.
 *
 * Feeds a JSONL corpus through the real judge and reports what the plugin decided.
 * With `expect` labels it also reports matched/mismatched counts, and exits 1 when
 * anything is missed, so it can gate a change.
 *
 * Usage:
 *   node scripts/calibrate.mjs --corpus scripts/corpus.example.jsonl
 *   node scripts/calibrate.mjs --corpus my.jsonl --json
 *
 * Corpus line: {"text": "...", "context": {...}, "expect": "stop"}
 * `context` accepts the same fields as the runtime: task, taskId, waitingState,
 * pendingAction, correction, temp, lastAssistant, lastUser, wakeWords.
 * `expect` is the judge kind, which is the action type: stop | defer | limit |
 * read_only | confirm | start | continue | unknown. A correction and a plain task
 * state change both surface as `continue` / `start` respectively.
 */
import { readFileSync } from 'node:fs'
import { judge } from '../lib/judge.js'

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? null : args[i + 1] ?? true
}
const corpusPath = flag('--corpus')
const asJson = args.includes('--json')
if (!corpusPath) {
  console.error('usage: node scripts/calibrate.mjs --corpus <file.jsonl> [--json]')
  process.exit(2)
}

const lines = readFileSync(corpusPath, 'utf8').split(/\r?\n/)
const rows = []
for (const [index, line] of lines.entries()) {
  const text = line.trim()
  if (!text || text.startsWith('#')) continue
  let item
  try {
    item = JSON.parse(text)
  } catch (error) {
    console.error(`line ${index + 1}: invalid JSON — ${error.message}`)
    process.exit(2)
  }
  const decision = judge(item.text, item.context || {})
  rows.push({
    text: item.text,
    expect: item.expect || null,
    kind: decision.kind,
    actions: decision.actions.map((action) => action.type),
    speechActs: decision.speechActs,
    confidence: decision.confidence,
    reason: decision.reason.join(' / '),
  })
}

const labeled = rows.filter((row) => row.expect)
const matched = labeled.filter((row) => row.kind === row.expect)
const missed = labeled.filter((row) => row.kind !== row.expect)

if (asJson) {
  console.log(JSON.stringify({ total: rows.length, labeled: labeled.length, matched: matched.length, missed }, null, 2))
} else {
  for (const [index, row] of rows.entries()) {
    const mark = row.expect ? (row.kind === row.expect ? 'ok  ' : 'MISS') : '    '
    console.log(`${String(index + 1).padStart(3)} ${mark} ${row.kind.padEnd(11)} ${row.text}`)
    if (row.actions.length) console.log(`        actions: ${row.actions.join(',')}`)
  }
  console.log('')
  console.log(`total ${rows.length} · labeled ${labeled.length} · matched ${matched.length} · missed ${missed.length}`)
  for (const row of missed) {
    console.log(`MISS expected=${row.expect} got=${row.kind} :: ${row.text}`)
    console.log(`     reason: ${row.reason}`)
  }
}

process.exit(missed.length ? 1 : 0)
