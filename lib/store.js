/** One local state for the merged guard + toolkit plugin. No full chat log. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const SCHEMA = 'dsh-interaction-merged/2'
const LEGACY_SCHEMA = 'dsh-interaction-merged/1'
const MAX_PREFS = 50
const MAX_TASK = 260
const MAX_SESSIONS = 50
const WAIT_TTL_MS = 12 * 60 * 60 * 1000
const LOCK_STALE_MS = 10_000

export function createStore(statePath, options = {}) {
  const file = statePath || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-interaction-merged', 'state.json')
  const maxSessions = Number.isFinite(options.maxSessions) ? Math.max(1, options.maxSessions) : MAX_SESSIONS
  const clock = typeof options.now === 'function' ? options.now : () => Date.now()
  let dirty = false
  let lastError = null
  let state = load()
  let base = clone(state)
  const metrics = { observeMs: 0, assembleMs: 0, saveMs: 0, stateBytes: 0, injectChars: 0, sections: [] }
  if (dirty) save()

  function load() {
    try {
      const raw = readFileSync(file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && (parsed.schema === SCHEMA || parsed.schema === LEGACY_SCHEMA)) {
        return normalizeState(parsed)
      }
      backupCorrupt(raw)
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        try { backupCorrupt(readFileSync(file, 'utf8')) } catch { /* ignore */ }
      }
    }
    dirty = true
    return normalizeState({})
  }

  function save() {
    if (!dirty) return { wrote: false, ms: 0, bytes: metrics.stateBytes, message: '' }
    const start = now()
    let lock = null
    let tmp = null
    try {
      mkdirSync(dirname(file), { recursive: true })
      lock = acquireLock()
      let disk = null
      if (existsSync(file)) {
        const raw = readFileSync(file, 'utf8')
        try {
          const parsed = JSON.parse(raw)
          if (parsed?.schema === SCHEMA || parsed?.schema === LEGACY_SCHEMA) disk = normalizeState(parsed)
        } catch {
          backupCorrupt(raw)
        }
      }
      if (disk) mergeLatest(disk)
      const body = JSON.stringify(state, null, 2)
      tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
      // 0600: the state file holds truncated user/assistant snippets.
      writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, file)
      base = clone(state)
      metrics.saveMs = now() - start
      metrics.stateBytes = Buffer.byteLength(body)
      dirty = false
      lastError = null
      return { wrote: true, ms: metrics.saveMs, bytes: metrics.stateBytes, message: '' }
    } catch (error) {
      metrics.saveMs = now() - start
      lastError = describeError(error)
      if (tmp) { try { unlinkSync(tmp) } catch { /* ignore */ } }
      return { wrote: false, ms: metrics.saveMs, bytes: metrics.stateBytes, error: true, message: lastError }
    } finally {
      if (lock) releaseLock(lock)
    }
  }

  // Three-way merge: apply only fields this process changed onto the latest
  // disk snapshot. A second process writing another field/session is preserved.
  function mergeLatest(disk) {
    const sessions = { ...disk.sessions }
    const keys = new Set([...Object.keys(base.sessions || {}), ...Object.keys(state.sessions || {})])
    for (const key of keys) {
      const before = base.sessions?.[key]
      const local = state.sessions?.[key]
      const latest = disk.sessions?.[key]
      if (!local) {
        if (before && latest) delete sessions[key]
        continue
      }
      if (!before) {
        const empty = normalizeSession({})
        // Start from defaults, then the disk copy, then only fields this process
        // actually changed. Starting from `{}` dropped default fields
        // (waitingState, turn range…) from the in-memory state after a merge.
        const merged = { ...empty, ...(latest || {}) }
        for (const field of Object.keys(local)) {
          if (JSON.stringify(local[field]) !== JSON.stringify(empty[field])) merged[field] = local[field]
        }
        sessions[key] = merged
        continue
      }
      const merged = { ...(latest || before) }
      for (const field of new Set([...Object.keys(before), ...Object.keys(local)])) {
        if (JSON.stringify(local[field]) !== JSON.stringify(before[field])) merged[field] = local[field]
      }
      sessions[key] = merged
    }
    // Terminal waiting states must not be reset by a stale writer.
    for (const session of Object.values(sessions)) {
      if (['completed', 'cancelled'].includes(session.waitingState) && !session.waitingSince) {
        session.waitingSince = session.updatedAt || clock()
      }
    }
    state.sessions = sessions
    capSessions()

    const removed = { ...(base.removedPrefs || {}), ...(state.removedPrefs || {}), ...(disk.removedPrefs || {}) }
    state.removedPrefs = removed
    const beforeMap = new Map((base.prefs || []).map((pref) => [pref.id, pref]))
    const localMap = new Map((state.prefs || []).map((pref) => [pref.id, pref]))
    const latestMap = new Map((disk.prefs || []).map((pref) => [pref.id, pref]))
    for (const pref of state.prefs || []) {
      if (!beforeMap.has(pref.id)) latestMap.set(pref.id, pref)
      else if (JSON.stringify(pref) !== JSON.stringify(beforeMap.get(pref.id))) latestMap.set(pref.id, pref)
    }
    for (const pref of base.prefs || []) {
      if (!localMap.has(pref.id)) latestMap.delete(pref.id)
    }
    state.prefs = [...latestMap.values()].filter((pref) => !removed[pref.id]).sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0)).slice(0, MAX_PREFS)
    if (state.lastInjected && JSON.stringify(state.lastInjected) !== JSON.stringify(base.lastInjected)) {
      disk.lastInjected = state.lastInjected
    }
    state.lastInjected = (Number(disk.lastInjected?.at) || 0) > (Number(state.lastInjected?.at) || 0) ? disk.lastInjected : state.lastInjected
    // Global flags use the same three-way rule: only override the latest disk
    // value when this process actually changed the flag from its base.
    for (const field of ['enabled', 'guardEnabled']) {
      if (JSON.stringify(state[field]) !== JSON.stringify(base[field])) disk[field] = state[field]
      else state[field] = disk[field]
    }
    state.ops = { ...(disk.ops || {}), ...(state.ops || {}) }
  }

  function acquireLock() {
    const lock = `${file}.lock`
    const deadline = Date.now() + 5000
    while (true) {
      try {
        const fd = openSync(lock, 'wx', 0o600)
        writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8')
        closeSync(fd)
        return lock
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err
        if (lockIsStale(lock)) {
          try { unlinkSync(lock) } catch { /* ignore */ }
          continue
        }
        if (Date.now() > deadline) throw new Error('state lock timeout')
        sleep(10 + Math.floor(Math.random() * 20))
      }
    }
  }

  function lockIsStale(lock) {
    try {
      const age = Date.now() - statSync(lock).mtimeMs
      if (age > LOCK_STALE_MS) return true
      let info
      try { info = JSON.parse(readFileSync(lock, 'utf8')) } catch { return age > 1000 }
      if (!info?.pid) return age > 1000
      try { process.kill(info.pid, 0); return false } catch (err) { return err?.code === 'ESRCH' }
    } catch { return true }
  }

  function releaseLock(lock) {
    try { unlinkSync(lock) } catch { /* ignore */ }
  }

  // Idempotent operation entry: lock, re-read latest, apply operation, write.
  function mutate(opId, operation) {
    const key = String(opId || '')
    if (!key) return { duplicate: false, error: true }
    if (state.ops?.[key]) return { duplicate: true, value: state.ops[key].value ?? null }
    if (dirty) save()
    let lock = null
    try {
      mkdirSync(dirname(file), { recursive: true })
      lock = acquireLock()
      let disk = state
      if (existsSync(file)) {
        try { disk = normalizeState(JSON.parse(readFileSync(file, 'utf8'))) } catch { /* keep memory */ }
      }
      if (disk.ops?.[key]) {
        state = disk
        base = clone(disk)
        return { duplicate: true, value: disk.ops[key].value ?? null }
      }
      const value = operation(disk)
      disk.ops = disk.ops || {}
      disk.ops[key] = { at: clock(), value: value ?? null }
      const keys = Object.keys(disk.ops)
      if (keys.length > 200) for (const old of keys.slice(0, keys.length - 200)) delete disk.ops[old]
      const body = JSON.stringify(disk, null, 2)
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
      writeFileSync(tmp, body, 'utf8')
      renameSync(tmp, file)
      state = disk
      base = clone(disk)
      dirty = false
      lastError = null
      return { duplicate: false, value: value ?? null }
    } catch (error) {
      lastError = describeError(error)
      return { duplicate: false, error: true }
    } finally {
      if (lock) releaseLock(lock)
    }
  }

  function refresh() {
    if (dirty) save()
    if (!existsSync(file)) return false
    try {
      const raw = readFileSync(file, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed?.schema === SCHEMA || parsed?.schema === LEGACY_SCHEMA) {
        const fresh = normalizeState(parsed)
        if (JSON.stringify(fresh) !== JSON.stringify(state)) {
          state = fresh
          base = clone(fresh)
          return true
        }
      }
    } catch { /* keep memory */ }
    return false
  }

  // Expire stale waiting states and temporary requirements without executing.
  function expireWaiting(nowMs = clock()) {
    let changed = false
    for (const session of Object.values(state.sessions)) {
      if (['awaiting_input', 'awaiting_confirmation'].includes(session.waitingState)
        && session.waitingSince && nowMs - session.waitingSince > WAIT_TTL_MS) {
        session.waitingState = 'awaiting_reconfirm'
        session.pending = { reconfirm: true }
        session.waitingSince = nowMs
        session.resumedAt = nowMs
        session.updatedAt = nowMs
        changed = true
      }
      if (session.temp?.expiresAt && session.temp.expiresAt <= nowMs) {
        session.temp = null
        session.updatedAt = nowMs
        changed = true
      }
    }
    if (changed) dirty = true
    return changed
  }

  function touch() { dirty = true }

  /** Read-only lookup: returns null instead of creating a session record. */
  function peek(sessionId) {
    return state.sessions[hash(sessionId)] || null
  }

  function session(sessionId, write = false) {
    const key = hash(sessionId)
    if (!state.sessions[key]) {
      evict(key)
      state.sessions[key] = normalizeSession({ createdAt: clock(), updatedAt: clock() })
      dirty = true
    }
    const current = state.sessions[key]
    if (write) {
      current.lastSeen = clock()
      current.updatedAt = clock()
      if (['awaiting_input', 'awaiting_confirmation'].includes(current.waitingState) && !current.waitingSince) {
        current.waitingSince = clock()
      }
      if (!['awaiting_input', 'awaiting_confirmation', 'awaiting_reconfirm'].includes(current.waitingState)) {
        current.waitingSince = null
      }
      dirty = true
    }
    return current
  }

  function evict(keep) {
    const keys = Object.keys(state.sessions)
    if (keys.length < maxSessions) return
    keys.filter((key) => key !== keep)
      .sort((a, b) => (state.sessions[a]?.lastSeen || 0) - (state.sessions[b]?.lastSeen || 0))
      .slice(0, Math.max(1, keys.length - maxSessions + 1))
      .forEach((key) => delete state.sessions[key])
    dirty = true
  }

  function capSessions() {
    const keys = Object.keys(state.sessions)
    if (keys.length <= maxSessions) return
    keys.sort((a, b) => (state.sessions[a]?.lastSeen || 0) - (state.sessions[b]?.lastSeen || 0))
      .slice(0, keys.length - maxSessions)
      .forEach((key) => delete state.sessions[key])
    dirty = true
  }

  function backupCorrupt(raw) {
    try {
      const dest = `${file}.corrupt-${Date.now()}`
      writeFileSync(dest, String(raw || ''), 'utf8')
      return dest
    } catch { return null }
  }

  function addPreference(input) {
    const data = typeof input === 'string' ? { text: input } : (input || {})
    const text = String(data.text || data.rule || '').trim().slice(0, 260)
    if (!text) return null
    const existing = state.prefs.find((pref) => pref.text === text && pref.status === 'active')
    if (existing) return existing
    if (data.supersedes) {
      const old = state.prefs.find((pref) => pref.id === data.supersedes)
      if (old) { old.status = 'superseded'; old.enabled = false }
    }
    const pref = normalizePref({
      id: newId(),
      text,
      scope: data.scope || '通用',
      source: 'explicit',
      sourceTurn: data.sourceTurn ?? null,
      status: 'active',
      enabled: true,
      forbidden: data.forbidden || ['不要扩大到别的任务或对象'],
      supersedes: data.supersedes || null,
      updatedAt: Date.now(),
    })
    state.prefs.unshift(pref)
    state.prefs = state.prefs.slice(0, MAX_PREFS)
    dirty = true
    return pref
  }

  function replacePreference(id, text) {
    const rule = String(text || '').trim().slice(0, 260)
    const old = state.prefs.find((pref) => pref.id === String(id || '') && pref.status === 'active')
    if (!old) return { pref: null, reason: 'not_found' }
    if (!rule) return { pref: null, reason: 'empty' }
    if (old.text === rule) return { pref: old, reason: 'same' }
    old.status = 'superseded'
    old.enabled = false
    old.updatedAt = Date.now()
    const pref = normalizePref({
      id: newId(),
      text: rule,
      scope: old.scope,
      source: 'explicit-replace',
      sourceTurn: old.sourceTurn,
      status: 'active',
      enabled: true,
      forbidden: old.forbidden,
      supersedes: old.id,
      updatedAt: Date.now(),
    })
    state.prefs.unshift(pref)
    state.prefs = state.prefs.slice(0, MAX_PREFS)
    dirty = true
    return { pref, reason: 'replaced' }
  }

  function removePreference(id) {
    const key = String(id || '')
    const before = state.prefs.length
    state.prefs = state.prefs.filter((pref) => pref.id !== key)
    if (before !== state.prefs.length) {
      state.removedPrefs = state.removedPrefs || {}
      state.removedPrefs[key] = Date.now()
      dirty = true
    }
    return before !== state.prefs.length
  }

  /**
   * Toggle the runtime flag and report whether it actually reached the disk.
   * A failed write is rolled back in memory so `/itk` cannot show a state the
   * plugin is not really in.
   */
  function setEnabled(value) {
    const previous = state.enabled
    state.enabled = Boolean(value)
    dirty = true
    const result = save()
    if (result.error) state.enabled = previous
    return { ...result, enabled: state.enabled }
  }

  function setGuardEnabled(value) {
    const previous = state.guardEnabled
    state.guardEnabled = Boolean(value)
    dirty = true
    const result = save()
    if (result.error) state.guardEnabled = previous
    return { ...result, guardEnabled: state.guardEnabled }
  }

  function deleteSession(sessionId) {
    const key = hash(sessionId)
    if (!state.sessions[key]) return false
    delete state.sessions[key]
    dirty = true
    return true
  }

  function setLastInjection(sessionId, sections, chars, traceId) {
    const current = session(sessionId, true)
    const record = { at: Date.now(), sections, chars: Number(chars) || 0, traceId: traceId || null }
    current.lastInjected = record
    state.lastInjected = record
    metrics.injectChars = record.chars
    metrics.sections = sections.slice()
    dirty = true
    save()
  }

  function status(sessionId) {
    const current = session(sessionId)
    return {
      enabled: state.enabled,
      guardEnabled: state.guardEnabled,
      file,
      prefs: state.prefs.filter((pref) => pref.status === 'active' && pref.enabled !== false),
      session: current,
      lastInjected: state.lastInjected,
      metrics: { ...metrics },
      error: lastError,
      sessionCount: Object.keys(state.sessions).length,
    }
  }

  return {
    file, session, peek, touch, save, refresh, expireWaiting, mutate, addPreference, replacePreference, removePreference, deleteSession,
    setEnabled, setGuardEnabled, setLastInjection, status, metrics,
    get state() { return state },
    get dirty() { return dirty },
  }
}

function normalizeState(parsed) {
  return {
    schema: SCHEMA,
    schemaVersion: 2,
    enabled: parsed?.enabled !== false,
    guardEnabled: parsed?.guardEnabled !== false,
    prefs: Array.isArray(parsed?.prefs) ? parsed.prefs.slice(0, MAX_PREFS).map(normalizePref) : [],
    removedPrefs: parsed?.removedPrefs && typeof parsed.removedPrefs === 'object' ? parsed.removedPrefs : {},
    ops: parsed?.ops && typeof parsed.ops === 'object' ? parsed.ops : {},
    sessions: parsed?.sessions && typeof parsed.sessions === 'object'
      ? Object.fromEntries(Object.entries(parsed.sessions).map(([key, value]) => [key, normalizeSession(value)]))
      : {},
    lastInjected: parsed?.lastInjected || null,
  }
}

function normalizePref(pref) {
  const text = String(pref?.text || pref?.rule || '').slice(0, 260)
  return {
    id: pref?.id || newId(),
    text,
    scope: pref?.scope || '通用',
    source: pref?.source || 'explicit',
    sourceTurn: pref?.sourceTurn ?? null,
    status: pref?.status || 'active',
    enabled: pref?.enabled !== false && pref?.status !== 'superseded',
    forbidden: Array.isArray(pref?.forbidden) ? pref.forbidden : [],
    supersedes: pref?.supersedes || null,
    createdAt: pref?.createdAt || Date.now(),
    updatedAt: pref?.updatedAt || pref?.createdAt || Date.now(),
  }
}

function normalizeSession(session) {
  return {
    task: String(session?.task || '').slice(0, MAX_TASK),
    taskId: session?.taskId || null,
    turn: Number.isFinite(session?.turn) ? session.turn : 0,
    correction: session?.correction || null,
    temp: session?.temp || null,
    pending: session?.pending || null,
    waitingState: session?.waitingState || 'ready',
    waitingSince: Number.isFinite(session?.waitingSince)
      ? session.waitingSince
      : (['awaiting_input', 'awaiting_confirmation', 'awaiting_reconfirm'].includes(session?.waitingState)
        ? (Number.isFinite(session?.updatedAt) ? session.updatedAt : Date.now())
        : null),
    pendingAction: session?.pendingAction || null,
    createdAt: Number.isFinite(session?.createdAt) ? session.createdAt : Date.now(),
    updatedAt: Number.isFinite(session?.updatedAt) ? session.updatedAt : Date.now(),
    resumedAt: Number.isFinite(session?.resumedAt) ? session.resumedAt : null,
    lastAssistant: String(session?.lastAssistant || '').slice(0, 300),
    lastUser: String(session?.lastUser || '').slice(0, 220),
    lastDecision: session?.lastDecision || null,
    lastInjected: session?.lastInjected || null,
    lastPrefs: Array.isArray(session?.lastPrefs) ? session.lastPrefs.slice(0, 2) : [],
    lastInjectedTurn: Number.isFinite(session?.lastInjectedTurn) ? session.lastInjectedTurn : 0,
    lastInjectedTraceId: session?.lastInjectedTraceId || null,
    prefsInjectedTurn: Number.isFinite(session?.prefsInjectedTurn) ? session.prefsInjectedTurn : 0,
    ruleCounts: session?.ruleCounts && typeof session.ruleCounts === 'object' ? session.ruleCounts : {},
    lastRuleTurn: Number.isFinite(session?.lastRuleTurn) ? session.lastRuleTurn : 0,
    // Idempotency key for "one injection per turn": the host turn id when known,
    // otherwise a session-local counter filled in by the caller.
    turnKey: session?.turnKey ? String(session.turnKey) : null,
    turnKeyFromHost: session?.turnKeyFromHost === true,
    lastInjectedTurnKey: session?.lastInjectedTurnKey ? String(session.lastInjectedTurnKey) : null,
    lastSeen: Number.isFinite(session?.lastSeen) ? session.lastSeen : Date.now(),
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function describeError(error) {
  const code = error?.code ? `${error.code}: ` : ''
  return `${code}${error?.message || String(error)}`.slice(0, 220)
}

function sleep(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch { /* ignore */ }
}

function newId() {
  return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

function hash(value) {
  return createHash('sha256').update(String(value || 'unknown')).digest('hex').slice(0, 12)
}

function now() {
  return Number(process.hrtime.bigint() / 1000000n)
}

export function stateExists(path) { return existsSync(path) }
