# Contributing

## Tests

```text
npm test
```

Tests must stay offline: no model calls, no network requests, no external services.
If a change affects the judge, add a focused case for:

- correction vs opinion;
- stop vs limit/defer;
- confirmation with and without pending context;
- temporary requirement vs long-term preference, including one message carrying both;
- a same-turn stop + task change;
- a repeated assemble under the same turn id;
- task end by completion, cancellation, and failure;
- context-only messages (`runtime-context`) not touching the task, and
  `user-question-reply` being treated as the user's answer.

## Code boundaries

- Keep one `agent/inbox/inserted` and one `system-prompt/assemble` registration.
- Do not add a second classifier for stop/confirm/correction.
- Do not raise the 620-character budget without measuring prompt behavior.
- Do not write full chat logs; only truncated state snippets are allowed.
- Do not hard-code local nicknames, client names, or project names in source. Host-specific
  wake words go through `config.wakeWords`; diagnostics redact unknown prompt-block names.
- Do not claim model behavior from unit tests alone.

## Pull requests

Describe what is verified offline and what still needs a real DSH replay. Include test output
and any new limitations. If you change inbox filtering, run the three-way acceptance suite and
say whether you verified it on a real host.
