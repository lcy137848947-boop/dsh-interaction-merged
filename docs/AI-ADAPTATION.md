# AI adaptation guide

**中文速览（给接手的 AI）**

1. 先确认宿主：DSH 版本、六个钩子是否存在、profile 怎么装。装不上时 90% 是“包没真正进 profile”，先跑本文件 §2 的三条命令。
2. 适配分五层：安装 → 称呼表 → 四类判断规则 → 注入文案与语言 → 预算。一次只改一层。
3. 所有可调点都在 `lib/recognize.js`、`lib/core.js`、`index.js` 的具名常量/函数里，改引用而不是重写。
4. 用 `scripts/calibrate.mjs` 跑本地语料，先测再改；每次改完 `npm test`，并把新例句加进语料。
5. 不要把人名、客户名、真实聊天写进仓库；语料用合成句子。改完回报：宿主版本、语料规模、改前/改后准确率、改了哪些规则、测试结果。

---

This document is for an AI agent (or a careful human) who takes this plugin to a **different
DSH installation, machine, language, or user** and needs it to behave. It is an operational
manual for the code, not marketing.

The plugin is deliberately rule-based: every decision is a named regex or threshold in the
source. Adaptation means finding the right rule and changing it *with a measurement*, not
rewriting the pipeline.

## 1. Ground truth: read the host before touching anything

```text
# which runtime is the host?
grep '"dsh":"' <DSH_HOME>/logs/desktop-next.log | tail -1

# which hooks does this host expose? (search the host bundle or its docs)
agent/inbox/inserted   agent/inbox/claimed   agent/error
session/event          system-prompt/assemble   tools/pre-execute
commands registry
```

- `agent/inbox/claimed` gives the turn id used for idempotency. Without it the plugin falls back
  to a local counter (still correct, just less robust under streaming retries).
- `tools/pre-execute` is what makes clarification block tools. Without it the clarification
  section is injected but tools are not denied.
- `ask_user_question` must be a tool name in this host; it is the one tool never blocked.

If a hook is missing, the related feature degrades silently by design. Do not add a second
registration for the same hook.

## 2. Install correctly — the silent-skip trap

A bundle is loaded only when **all** of these hold. Any failure skips the bundle *without an
error line in the host log*, so verify each one explicitly.

1. `dependencies` has the package; `dsh.profile.bundles` lists it.
2. It is installed through the package manager, not copied: the profile's `pnpm-lock.yaml`
   contains an entry for it.
3. It is resolvable from the profile, including the manifest export:

```text
cd <profile>
node -e "console.log(require.resolve('dsh-interaction-merged/package.json'))"
node -e "console.log(require.resolve('dsh-interaction-merged'))"
```

`ERR_PACKAGE_PATH_NOT_EXPORTED` on the first command means `exports` does not expose
`./package.json`. DSH resolves each bundle's manifest through this path; without it the bundle is
skipped silently. Add:

```json
"exports": { ".": "./index.js", "./package.json": "./package.json" }
```

4. `package.json` declares `dsh.bundle.patch` pointing at a YAML file that exists and parses.
5. The host was restarted after installation.

Post-install proof, both must be true:

- `<DSH_HOME>/dsh-interaction-merged/state.json` exists;
- the log contains `dsh-interaction-merged: active v0.3.1 (state=...)`.

If the install runs while DSH is open, `node_modules` may be locked (`EPERM` renaming a native
package). Solutions: close DSH and retry; delete only the package directory that failed to
rename; or install with `--config.ignore-scripts=true` and rebuild the native packages you need.

## 3. Adaptation layers

Work top-down. Each layer is independent, and changing a lower layer is riskier.

| Layer | What changes | Where |
| --- | --- | --- |
| 1. Install | bundle wiring | profile files |
| 2. Vocabulary | what the user calls the assistant | `wakeWords` config |
| 3. Judgment | stop/limit/quote/confirm, correction, preference, temporary, waiting, answers | `lib/recognize.js`, `lib/core.js`, `index.js` |
| 4. Prompt text | the Chinese guidance strings and their tone | `index.js` constants, `lib/core.js` render* functions |
| 5. Budget | characters injected per turn | `maxChars`, `maxPrefs` |

## 4. Judge inventory

Everything below is a named symbol. Change the regex, never the pipeline shape.

### 4.1 Boundary classifier — `lib/recognize.js`

| Symbol | Decides | Typical local mismatch |
| --- | --- | --- |
| `QUOTE_LEAD` | “is this asking what a phrase means / translating / quoting? | Local idiom for “什么意思”“翻译一下” missing |
| `ACTION_RE` / `ACTION_WORD` | action verbs that make a quote look like a command | Local verbs: 检查/核对/跑一下/发我 |
| `NEG`, `STOP_ACTION`, `STOP` | negation + action = stop | Local negation: 甭/别介/先搁着 |
| `STOP_STANDALONE`, `PAUSE`, `STOP_CMD` | standalone stops and pauses | 停一下/先等等 |
| `LIMIT` | scope limits (“只备份、别大动”) | Local scope idioms |
| `DEFER` | “explain consequences before I decide” | 先说说后果 |
| `CONFIRM_AMBIGUOUS`, `EXPLICIT_CHOICE` | ambiguous vs explicit confirmation | 都行/你定/就第二个 |
| `QUESTION` | question shape | Local particles: 呢/吗/吧 |

Rules of thumb:

- Add alternatives inside the existing group; do not create a second classifier.
- Keep `QUOTED_RE` handling intact: quoted content must not become a stop word.
- Every added pattern needs a positive and a near-miss negative test.

### 4.2 Task state machine — `lib/core.js`

| Symbol | Decides | Watch out for |
| --- | --- | --- |
| `PREFERENCE`, `FUTURE` | standing preference | One-off words (这次/今天) must not match |
| `TEMP` | temporary requirement | Mixed sentences: `splitMixedClauses` splits one-off vs standing |
| `TASK_CHANGE` | explicit new task | 另外/换个话题/local variants |
| `COMPLETE`, `CANCEL` | task end by words | 搞定了/收工/取消这项 |
| `extractCorrection` | object correction, permission reminder, forbidden action | “我不是让你…” with and without 吗 |
| `CONTINUE` | continue current task | only meaningful with an anchor |

Core does **not** strip wake words. `index.js` strips the prefix before calling the judge, so keep
that order; otherwise “阿甲，继续” becomes a new task.

`session.correction` records the turn that set it (`at`). The runtime clears it on completion,
cancellation, stop, and task start. If the target host needs a hard bound as well, add one:
store `at` (already there), skip rendering `itk:correction` when
`session.turn - session.correction.at > N`, and add a test proving the correction stops applying
— a remembered correction without an expiry is how a guard becomes a new drift source.

### 4.3 Runtime policy — `index.js`

| Symbol | Decides | Symptom when wrong |
| --- | --- | --- |
| `inferWaiting` | is the assistant asking for material? | Reply replaces the task instead of attaching |
| `looksLikeValue` | is a short reply a value (path/file/number/noun)? | New instruction swallowed as material |
| `isAcknowledgement` | bare 谢谢/收到/好的 | Acknowledgment pollutes the task |
| `isAnswerTurn` | accept reply as the answer | Answer stored but not injected (check `quiet` too) |
| `ACTION_TEXT` | guidance text per action | Wrong tone/language |
| `sectionsFor` | ordering, trimming, idempotency | Duplicate or missing sections |
| `PENDING_MAX_AGE_MS` | clarification expiry | Tools blocked too long |

`inferWaiting` runs on the **assistant** message. Add the local interrogative forms your assistant
actually uses, for example:

```js
if (/(?:请|麻烦)(?:你)?\s*(?:先|再)?\s*(?:说明|告诉|确认|补充|提供|列出|给出|回答|选择|指定|发送|上传)/.test(value)) {
  return 'awaiting_input'
}
if (/(哪一(?:个|列|行|项|部分)|哪部分|哪个部分|叫什么|什么名字|列名|行号|路径是|名称是)/.test(value)) {
  return 'awaiting_input'
}
```

`looksLikeValue` is language-specific. Extend the value shapes for the local domain instead of
loosening the length check:

```js
if (/\.(?:xlsx?|csv|docx?|pdf|pptx?|md|txt|png|jpe?g|zip|tar|gz)$/i.test(value)) return true
if (/^(?:[A-Za-z]:[\\/]|~\/|\/)(?:\S+)$/.test(value)) return true
```

## 5. Measure before and after — `scripts/calibrate.mjs`

Ship a local corpus: one JSON object per line.

```jsonl
{"text": "先别动，等我说完", "expect": "stop"}
{"text": "先说说会有什么影响", "expect": "defer"}
{"text": "只备份，不要大改", "expect": "limit"}
{"text": "都行", "context": {"waitingState": "awaiting_confirmation"}, "expect": "confirm"}
{"text": "把那个文件删了", "context": {"task": "整理目录"}, "expect": "start"}
```

`expect` uses the judge kind, which is the action type (`stop`, `defer`, `limit`, `read_only`,
`confirm`, `start`, `continue`, `unknown`). A correction surfaces as `continue`, a plain task as
`start`.

Run:

```text
node scripts/calibrate.mjs --corpus scripts/corpus.local.jsonl
```

It prints, per line, the judged `kind`, actions, speech acts, confidence and reason; with
`expect` present it also prints matched/mismatched counts and a summary. Exit code is 1 when any
label is missed, so it can gate a change in CI.

Suggested workflow:

1. Collect 30–100 real *shapes* (synthetic text, same structure as local usage).
2. Label with the one kind you expect the plugin to produce.
3. Run calibrate; record: total, matched, per-rule false positives / negatives.
4. Change exactly one rule group.
5. Re-run calibrate and `npm test`; add the new case as a unit test.
6. Keep `before/after` numbers in the change description.

Measure the token cost separately: `/itk why` prints the injected section names and character
count. Compare with `guardEnabled: false` to isolate boundary sections.

## 6. Language and prompt text

The judge understands CJK and English patterns, but the injected guidance is Chinese. For another
locale:

- translate `ACTION_TEXT` in `index.js`, and the `render*` functions in `lib/core.js`
  (`renderTask`, `renderCorrection`, `renderPreference`, `renderTemporary`, `renderClarify`);
- keep the **section names** (`itk:task`, `itk:action:stop`, …) unchanged: idempotency, `/itk`
  output and tests key off them;
- keep the budget semantics: protected sections are injected whole, other sections are trimmed;
- keep the promise in the text consistent with behavior (e.g. do not say “ask before acting” if
  the guard is disabled in config).

## 7. Change protocol (do not skip)

0. **Do not let the plugin become a new drift source.** Its value is that judgment stays local,
   it calls no extra model, and it ships offline tests and switches (`/itk on|off`,
   `/guard on|off`). Keep those properties when adapting: prefer tightening a local rule over
   adding a model call, keep the offline suite green, and keep every switch working.
   Every remembered correction needs an **expiry condition** — task end, turn count, or explicit
   revocation. A temporary fix from last week must not become this week's standing offset; when
   you add a correction rule, say in one line when it stops applying and test that it does.

1. One rule group per change.
2. Positive + near-miss negative test for every new pattern.
3. `npm test` must stay green; add a regression case to `test/acceptance.test.mjs` if the change
   touches inbox filtering or task storage.
4. Update `CHANGELOG.md` with the symptom, the change, and the measurement.
5. Never commit names, client data, real conversations, or machine-specific paths.
6. Re-run the three-way acceptance check (§8) after any change to `isHumanMessage`,
   `inferWaiting`, `isAnswerTurn`, or task storage.

## 8. Acceptance checklist on the target machine

| Check | How | Pass |
| --- | --- | --- |
| Loaded | state file exists + `active v0.3.1` in log | both |
| Direct answer | ask for a file name, reply with `report.xlsx` | task keeps original + `（补充：report.xlsx）` |
| Native question reply | same, answered through the UI question card | same result |
| Memory recall | `runtime-context` message containing the file name | task unchanged |
| Clarify | ambiguous “可以” with no context | one `itk:clarify`, tools denied except `ask_user_question` |
| Task end | 完成 / 取消 / failure | temporary requirement released, `/itk` shows the terminal state |
| Commands | `/itk`, `/itk why`, `/itk on|off`, `/guard on|off` | no false success; write errors reported |
| Restart | restart the host, `/itk` | state and switches survive |
| Token | `/itk why` | injection ≤ `maxChars` + protected |

## 9. Failure-mode table

| Symptom | First suspect | Fix |
| --- | --- | --- |
| No state file, no log line | bundle skipped | §2 checks; most often `exports` or lockfile |
| `/itk` unknown | not mounted | same as above |
| Answer not injected | pending `quiet` not cleared | answer path must delete `quiet` (see `applyAnswer`) |
| Answer replaces task | `inferWaiting` missed the question | add the local question form |
| New instruction swallowed | `looksLikeValue` too loose | tighten shapes, keep length limit |
| Task polluted by 谢谢 | `isAcknowledgement` missing | extend the list |
| Wake word breaks “继续” | prefix not stripped before judging | `wakeWords` config / strip in `observe` |
| Tools blocked forever | clarification never expires | `PENDING_MAX_AGE_MS` uses `updatedAt`; check it updates |
| Too many tokens | `maxChars` too high or many protected sections | lower budget; check section count in `/itk why` |
| Two processes fight | lock/merge | keep `save()`/`mutate()` semantics, do not bypass the lock |

## 10. Handoff report template

When an AI finishes adapting this plugin for a local host, report:

```text
host: <product> <version>, dsh <version>, node <version>
install: <official install path>; resolution checks passed: yes/no
corpus: <n> lines; matched <m>/<n> before, <m2>/<n> after
rules changed: <file>:<symbol> — <what> — <why>
tests: npm test <pass>/<total>; acceptance <pass/fail>
known gaps: <...>
```

That report is what makes the next adaptation cheap.
