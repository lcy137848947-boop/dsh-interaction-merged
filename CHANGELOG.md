# Changelog

## 0.3.1-beta.13 — review fixes

### Fixed

- **Answer turns could be silently skipped.** A pending clarification kept the session flagged
  quiet, so the answer was stored but never injected; the model only saw it one turn later.
  The answer path now clears that flag.
- **`itk:clarify` never reached the model.** The guard blocked tools, but the guidance section
  was suppressed by the same quiet flag. Clarification now passes the quiet filter and keeps the
  pending state until the user answers.
- **Short new instructions were treated as material.** While waiting for a file name,
  “换个方案” was appended to the task (“（补充：换个方案）”). Only an explicit clarification
  request, or a value-shaped reply (path, file name, number, short noun), is accepted now.
- **A stale clarification blocked tools forever.** The five-minute expiry never ran because
  `pending.at` was never written; it now uses the session's last activity.
- **New sessions lost default fields after a merge.** `mergeLatest` seeded new-session merges
  from `{}`, dropping `waitingState` (visible as `等待：undefined`). It now seeds from normalized
  defaults.
- **`wakeWords` leaked between instances.** The recognizer kept module-level state; wake words
  are now passed per call.
- **Failed writes left `.tmp` files** next to the state file; they are removed on failure.
- **Quiet flags for evicted sessions** accumulated; they are pruned periodically.
- **Task truncation dropped the newest answer.** The answer suffix is preserved and the task body
  is trimmed instead.
- `npm test` uses `node --test` discovery; fixtures moved to `scripts/fixtures/` so they are not
  executed as tests.

### Tests

- 103/103 passing (Node 22; the numbers below were verified on Node 22 only).

## 0.3.1-beta.12 — open-source preparation

### Fixed

- **Native question replies were treated as non-user input.** A message whose source kind is
  `user-question-reply` (outcome `answered`) now counts as the user's answer, exactly like a
  plain user message: the clarification is cleared and the original task is kept, with the
  answer attached to it. A new instruction typed while the assistant waits for material is not
  mistaken for that material.
- **Quoted material disappeared from the task.** `请检查“十一月销售.xlsx”` is no longer read as a
  quotation; quoted file names stay in the stored and injected task text.
- **Toggle commands reported success while the write failed.** `/itk on|off` and `/guard on|off`
  now report a write error and roll the in-memory flag back; when the config layer disables the
  plugin, the command output and `/itk` show the *effective* state instead of pretending.
- **Mixed one-off and long-term requests were stored as one preference.**
  `这次先给结论，以后都附出处。` now persists only `以后都附出处` as a preference and keeps
  `这次先给结论` as a temporary requirement bound to the current task.
- **Read-only commands could evict a live session.** `/itk`, `/guard`, `/itk prefs`, `/itk why`
  no longer create a session record, so querying from another session cannot push a real task
  out of the LRU window.

### Changed

- **Idempotency uses the host turn id.** “One injection per turn” is keyed by the turn id from
  `agent/inbox/claimed`; a streaming retry that assembles the same turn twice no longer injects
  twice. The local turn counter remains the fallback for hosts without a turn id.
- **Task failure ends the task.** `agent/error` and turn status `failed|interrupted|aborted|cancelled`
  release task-bound temporary requirements, like 完成/取消 already did.
- **Context-only messages no longer touch state.** Host-injected messages (`runtime-context`,
  `untrusted-memory`, compaction checkpoints, schedules, …) do not create turns or overwrite the
  current task.
- **Diagnostics are safe to share.** `/itk why` renders unknown prompt-block names as
  `外部块 N`; `/itk why raw` shows the original names for local debugging.
- **Desensitized for public release.** Personal wake words were removed from the recognizer and
  are configurable via `wakeWords`; internal engineering notes and replay transcripts were
  replaced by `docs/ENGINEERING-NOTES.md`.
- State file and lock are written with mode `0600` where supported; save/mutate errors are kept
  for `/itk why` instead of being swallowed.
- 97/97 tests (added turn-id, task-end, and three-way acceptance suites).

## 0.3.1-beta.11

- Fixed task constraints like “其他一个字都不要改” being treated as stop.
- Fixed investigation tasks like “看看怎么回事” being treated as questions.
- Fixed “只说/别扯/客观公正” response-style preferences replacing the current task.
- Fixed “别管题干，直接告诉我” as redirect correction; “我不认，重来” as reject correction.
- “接着…现在能启动了吗” now continues instead of being overridden by the question mark.
- Added 2026-11-20 regression replay: candidate-label pass 72/85 → 82/85; 3 remaining are context-missing confirms; 85/85 with context.
- 79/79 tests.

## 0.3.1-beta.10

- Fixed global `enabled`/`guardEnabled` not participating in the three-way merge; task-only saves no longer revert another process's flag change.
- Added two-process and same-process flag/session regression tests; 68/68 tests.

## 0.3.1-beta.9

- Locked read-merge-write with field-level three-way merge; unique per-process temp files.
- `mutate(opId, operation)` idempotency; stale lock recovery; corrupt backup.
- True two-process concurrent writes for different sessions, same-session fields and preferences.
- Compaction event rehydrates from disk; no in-memory `quiet`/`lastDecision` dependence.
- `schemaVersion: 2`, legacy migration, waiting expiry and per-day temp expiry.
- 66/66 tests.

## 0.3.1-beta.8

- `我不是让你看一下吗` is now a permission reminder, not a forbidden action; forbidden extraction only applies without the rhetorical `吗`.
- `我们做过很多项目` and `已经完成授权` are context supplements/continue, not new tasks.
- `图片呢` is a short question; `那继续` is continue; neither replaces the current task.
- Added 6 real-model review turns and 6 regression cases; 58/58 tests.

## 0.3.1-beta.7

- `awaiting_input` is no longer treated as confirmation; “可以” after a path request stays waiting and tools are denied.
- Correction merge keeps a new object and the previous forbidden action across turns.
- Preference replacement preserves the original scope and refuses missing IDs without adding a new rule.
- Corrupt state is backed up before recovery; two independent processes updating different sessions merge instead of overwriting.
- Completion state is idempotent across repeated assembles.
- 52/52 tests.

## 0.3.1-beta.6

- Explicit `完成了` / `结束这个任务` enters completed; `取消任务` enters cancelled.
- Continue after completion/cancellation injects only a short `itk:state`, never the old task.
- Closing assistant text no longer overwrites completed/cancelled back to ready.
- Added lifecycle and “continue does not resurrect” tests; 41/41 tests.

## 0.3.1-beta.3

- No-context confirmation now enters `awaiting_input` and blocks environment/write tools through `tools/pre-execute`; `ask_user_question` stays available.
- Added baseline comparison for U1: no plugin 17 executed tool calls; beta.3 2 attempted, 0 executed, 0 writes.
- Added host tool-guard tests; 37/37 tests.

## 0.3.1-beta.2

- Fixed negated actions (`我不是让你删除文件`) being recorded as an object; now recorded as a forbidden action.
- Fixed `这个才是我的目录` being treated as a new task; now correction preserving the original task.
- Fixed `另外，这次帮我检查发票` being attached as a temporary requirement; now a task change.
- Fixed `我以后有空再看` being stored as a preference; now a personal plan (quiet).
- Added “continue” regression coverage; 35/35 tests.

## 0.3.1-beta.1

- Public Beta release candidate; not a stable 1.0.
- One merged runtime: guard actions and task state share a single judge and one assemble hook.
- Fixed `不要改文件` being misclassified as stop.
- Fixed `session/disposed` deleting task state across headless process boundaries.
- Fixed `评一下这两个方案` being misclassified as confirm.
- Added cross-process restart regression test; 27/27 tests.
- Added real-model replay report with actual lengths, token use, injected sections, and a partial-process verdict for U1.

## 0.3.0

- Merged turn-guard actions and task-state behavior into one plugin.
- Added stop-old-task + start-new-task handling, one 620-character budget, shared trace ID.

## 0.2.1

- Fixed regression/perf scripts failing when the report directory did not exist.
- Added report-directory test.

## 0.2.0

- Lightweight context-aware task state machine.
- Temporary requirements bound to a task; scoped preferences with supersede.
