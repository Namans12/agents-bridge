// Google's unmodified `agy acp` is the only production transport. No credential files or private APIs.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { agyCommand, resolveAgy, cleanAgyEnv } from './resolve-agy.mjs'
export { cleanAgyEnv } from './resolve-agy.mjs'

/** Permission callbacks only: allow once inside cwd/no path, deny clearly outside. Not an OS sandbox. */
export const ANTIGRAVITY_PERMISSION_POLICY = 'allow-once-within-cwd'

function realTarget(file, paths) {
  let probe = file
  const suffix = []
  for (;;) {
    try { return paths.join(fs.realpathSync(probe), ...suffix.reverse()) } catch {}
    const parent = paths.dirname(probe)
    if (parent === probe) return file
    suffix.push(paths.basename(probe)); probe = parent
  }
}

export function permissionDecision(params, cwd, { denyAll = false, paths = path, canonical = file => realTarget(file, paths) } = {}) {
  const targets = []
  const collect = (value, key = '') => {
    if (typeof value === 'string') {
      if (/^(path|file|filePath|file_path|target|directory|cwd|root|uri|workdir|working_directory|sourcePath|destinationPath)$/i.test(key)) targets.push(value)
      if (/command/i.test(key)) {
        // Obvious absolute and parent-relative command targets; never treat URLs as filesystem paths.
        for (const match of value.matchAll(/(?:^|[\s="'])([A-Za-z]:[\\/][^\s"'<>|]*|\\\\[^\s"'<>|]+|\.{2}(?:[\\/][^\s"'<>|]*)?(?=$|[\s"';])|~(?:[\\/][^\s"'<>|]*)?|\/(?!\/)[^\s"'<>|]+)/g)) {
          if (paths.sep === '\\' && /^\/(?:[cdsqv]|nologo|noprofile)$/i.test(match[1])) continue
          targets.push(match[1])
        }
      }
    } else if (Array.isArray(value)) for (const item of value) collect(item, key === 'directories' ? 'directory' : key.replace(/s$/i, ''))
    else if (value && typeof value === 'object') for (const [child, item] of Object.entries(value)) collect(item, child)
  }
  collect(params.toolCall)
  const root = canonical(paths.resolve(cwd))
  const outside = targets.filter(target => {
    if (/^https?:/i.test(target)) return false
    try {
      if (target.startsWith('file:')) target = fileURLToPath(target)
      if (/^~(?:[\\/]|$)/.test(target)) target = paths.join(os.homedir(), target.slice(1))
      const resolved = canonical(paths.resolve(cwd, target))
      const relative = paths.relative(root, resolved)
      return relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)
    } catch { return true }
  })
  const allowed = !denyAll && outside.length === 0
  const options = params.options ?? []
  const option = allowed
    ? options.find(one => one.kind === 'allow_once') ?? options.find(one => one.kind === 'allow_always')
    : options.find(one => one.kind === 'reject_once') ?? options.find(one => one.kind === 'reject_always')
  return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' },
    explanation: allowed && option ? `permission approved (${ANTIGRAVITY_PERMISSION_POLICY})`
      : `permission denied: ${outside.length ? `outside cwd: ${outside.join(', ')}` : denyAll ? 'ANTIGRAVITY_DENY_PERMISSIONS=1' : 'no suitable permission option'}` }
}

export function providerError(error) {
  const message = String(error?.message ?? error)
  if (/quota|rate.?limit|resource.exhausted|credit|429/i.test(message)) return `Antigravity quota/rate-limit/credits exhausted: ${message}. No retry or paid fallback was attempted.`
  if (/auth|login|sign.?in/i.test(message)) return `Antigravity authentication failed: ${message}. Run agy interactively and sign in with Google; the plugin never logs you in.`
  return `Antigravity: ${message}`
}

const valuesOf = option => (option?.options ?? []).flatMap(one => one.options ?? [one])

/** One owned child per job, one session per child. Callbacks are handled here, not through Codex approvals. */
export class AcpClient {
  constructor({ cwd, configured = '', command, env = process.env, onUpdate = () => {}, timeoutMs = 15_000,
    inactivityMs = 15 * 60_000, cancelMs = 5000 } = {}) {
    this.cwd = cwd; this.onUpdate = onUpdate; this.timeoutMs = timeoutMs
    this.setupDeadline = Date.now() + 20_000
    this.inactivityMs = inactivityMs; this.cancelMs = cancelMs
    this.pending = new Map(); this.toolCalls = new Map(); this.nextId = 1; this.stderr = ''; this.cancelled = false; this.closed = false
    const launch = command ?? agyCommand(resolveAgy(configured), ['acp'])
    this.child = spawn(launch.file, launch.args, { ...launch, cwd, env: cleanAgyEnv(env), windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stdin.on('error', error => this.fail(error))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-4000) })
    this.child.on('error', error => this.fail(error))
    this.child.on('exit', (code, signal) => this.fail(new Error(`agy acp exited (${code ?? signal})${this.stderr ? `: ${this.stderr}` : ''}`)))
    readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity }).on('line', line => {
      if (!line.trim()) return
      try { this.receive(JSON.parse(line)) } catch (error) { this.fail(new Error(`Invalid ACP message: ${error.message}`)); this.close() }
    })
  }
  write(message) { if (!this.closed) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n') }
  receive(message) {
    this.touch()
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id); clearTimeout(pending.timer)
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }))
      else pending.resolve(message.result)
    } else if (message.id !== undefined) {
      if (message.method === 'session/request_permission' && message.params?.sessionId === this.sessionId) {
        const call = message.params.toolCall ?? {}
        const decision = permissionDecision({ ...message.params, toolCall: { ...this.toolCalls.get(call.toolCallId), ...call } }, this.cwd, { denyAll: process.env.ANTIGRAVITY_DENY_PERMISSIONS === '1' })
        this.write({ id: message.id, result: { outcome: this.cancelled ? { outcome: 'cancelled' } : decision.outcome } })
        this.onUpdate({ sessionUpdate: 'permission_decision', text: decision.explanation })
      } else this.write({ id: message.id, error: { code: -32601, message: 'Client callback not supported' } })
    } else if (message.method === 'session/update' && message.params?.sessionId === this.sessionId && !this.loading) {
      const update = message.params.update
      if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') {
        this.toolCalls.set(update.toolCallId, { ...this.toolCalls.get(update.toolCallId), ...update })
        if (this.toolCalls.size > 200) this.toolCalls.delete(this.toolCalls.keys().next().value)
      }
      if (update?.sessionUpdate === 'config_option_update') this.configOptions = update.configOptions ?? this.configOptions
      this.onUpdate(update)
    }
  }
  fail(error) {
    this.failure = error
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }
  call(method, params, timeoutMs = this.timeoutMs) {
    if (this.failure || this.closed) return Promise.reject(this.failure ?? new Error('ACP child closed'))
    if (timeoutMs && this.setupDeadline) timeoutMs = Math.max(1, Math.min(timeoutMs, this.setupDeadline - Date.now()))
    return new Promise((resolve, reject) => {
      const id = this.nextId++
      const timer = timeoutMs ? setTimeout(() => {
        this.pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs} ms`)); this.close()
      }, timeoutMs) : null
      this.pending.set(id, { resolve, reject, timer }); this.write({ id, method, params })
    })
  }
  async open(sessionId) {
    try {
      const init = await this.call('initialize', { protocolVersion: 1,
        clientCapabilities: { session: { configOptions: { boolean: {} } } },
        clientInfo: { name: 'claude-codex-subagents', version: '0.2.4-fullaccess.5' } })
      if (init.protocolVersion !== 1) throw new Error(`Unsupported ACP protocol version ${init.protocolVersion}`)
      this.capabilities = init.agentCapabilities ?? {}
      const params = { cwd: this.cwd, mcpServers: [], ...(sessionId ? { sessionId } : {}) }
      this.loading = true; this.sessionId = sessionId
      const method = !sessionId ? 'session/new' : this.capabilities.sessionCapabilities?.resume ? 'session/resume'
        : this.capabilities.loadSession ? 'session/load' : null
      if (!method) throw new Error('This agy server cannot resume/load saved sessions; start a new job')
      const session = await this.call(method, params)
      this.sessionId = sessionId ?? session.sessionId
      if (typeof this.sessionId !== 'string' || !this.sessionId) throw new Error('session/new returned no sessionId')
      this.configOptions = session.configOptions ?? []; this.loading = false
      await this.disableCredits()
      return this
    } catch (error) { this.close(); throw error }
  }
  async setOption(option, value) {
    const answer = await this.call('session/set_config_option', { sessionId: this.sessionId, configId: option.id,
      ...(option.type === 'boolean' ? { type: 'boolean' } : {}), value })
    this.configOptions = answer.configOptions ?? this.configOptions
  }
  async disableCredits() {
    // Only use the documented setting ID when actually advertised; never invent a CLI flag.
    const credits = this.configOptions.find(option => option.id === 'useG1Credits')
    if (!credits) {
      this.onUpdate({ sessionUpdate: 'permission_decision', text: 'Quota: agy did not expose useG1Credits via ACP. Keep Use AI Credits OFF in agy /settings before delegating.' })
      return
    }
    const value = credits.type === 'boolean' ? false : valuesOf(credits).find(one => /^(false|off|disabled)$/i.test(one.value))?.value
    if (value === undefined) throw new Error('Cannot disable advertised useG1Credits; turn Use AI Credits off in agy /settings')
    await this.setOption(credits, value)
    if (this.configOptions.find(one => one.id === credits.id)?.currentValue !== value) throw new Error('agy did not confirm that AI-credit overage was disabled')
  }
  async configure({ family = 'gemini', model, mode, effort } = {}) {
    const modelOption = this.configOptions.find(one => one.category === 'model' && one.type === 'select')
    if (model || family === 'gemini') {
      const values = valuesOf(modelOption)
      const wanted = model ? values.find(one => one.value === model)
        : values.find(one => one.value === modelOption?.currentValue && /gemini/i.test(`${one.value} ${one.name}`))
          ?? values.find(one => /gemini/i.test(`${one.value} ${one.name}`))
      if (!modelOption || !wanted) throw new Error(`No advertised ${model ?? 'Gemini'} model. Available model IDs: ${values.map(one => one.value).join(', ') || '(none)'}. Try codex:antigravity-default.`)
      if (modelOption.currentValue !== wanted.value) await this.setOption(modelOption, wanted.value)
    }
    for (const [category, requested] of [['mode', mode], ['thought_level', effort]]) {
      if (!requested) continue
      const option = this.configOptions.find(one => one.category === category && one.type === 'select')
      const value = valuesOf(option).find(one => one.value === requested || one.name?.toLowerCase() === requested.toLowerCase())
      if (!option || !value) throw new Error(`Unsupported ${category} "${requested}". Advertised choices: ${valuesOf(option).map(one => one.value).join(', ') || '(none)'}`)
      await this.setOption(option, value.value)
    }
    await this.disableCredits() // model changes may change dependent options
    const selectedModel = this.configOptions.find(one => one.category === 'model')
    const selectedMode = this.configOptions.find(one => one.category === 'thought_level') ?? this.configOptions.find(one => one.category === 'mode')
    return { model: selectedModel?.currentValue ?? 'account-default', effort: selectedMode?.currentValue ?? 'default' }
  }
  touch() {
    if (!this.promptCount) return
    clearTimeout(this.inactivityTimer)
    this.inactivityTimer = setTimeout(() => { this.fail(new Error('ACP prompt inactivity deadline exceeded')); this.close() }, this.inactivityMs)
  }
  async prompt(text) {
    this.setupDeadline = null
    this.promptCount = (this.promptCount ?? 0) + 1; this.touch()
    try { return await this.call('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] }, 0) }
    finally { this.promptCount--; if (!this.promptCount) { clearTimeout(this.inactivityTimer); clearTimeout(this.cancelTimer) } }
  }
  cancel() {
    this.cancelled = true
    this.write({ method: 'session/cancel', params: { sessionId: this.sessionId } })
    clearTimeout(this.cancelTimer)
    if (this.promptCount) this.cancelTimer = setTimeout(() => { this.fail(new Error('Cancellation timed out; owned agy process was stopped')); this.close() }, this.cancelMs)
  }
  close() {
    if (this.closed) return
    this.closed = true; clearTimeout(this.inactivityTimer); clearTimeout(this.cancelTimer)
    this.fail(new Error('ACP child closed'))
    // Kill the owned tree on Windows; no global process-name matching.
    if (this.child.pid && this.child.exitCode === null && this.child.signalCode === null) {
      if (process.platform === 'win32') {
        const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(this.child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => this.child.kill())
      } else { try { process.kill(-this.child.pid, 'SIGTERM') } catch { this.child.kill('SIGTERM') } }
    }
  }
}

/** Adapter emits the small event subset the existing job registry/waiters already understand. */
export function createAntigravityBackend({ emit, clientFactory = options => new AcpClient(options) }) {
  const jobs = new Map()
  const clients = new Set() // includes children still negotiating initialize/session setup
  let stopping = false
  const queues = new Map()
  const serial = (key, work) => {
    const promise = (queues.get(key) ?? Promise.resolve()).then(work)
    const tail = promise.catch(() => {}); queues.set(key, tail)
    void tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
    return promise
  }
  const event = (method, params) => emit({ method, params })
  const open = async params => {
    if (!path.isAbsolute(params.cwd ?? '')) throw new Error('Antigravity cwd must be an absolute path')
    const job = { threadId: params.threadId, text: '', notices: [], count: 0, cancelled: false }
    const client = clientFactory({ cwd: params.cwd, configured: params.agyPath,
      onUpdate: update => {
        if (!update) return
        if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') job.text = (job.text + update.content.text).slice(-100_000)
        else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
          event('antigravity/activity', { threadId: job.threadId, text: `${update.title ?? update.toolCallId ?? 'tool'}${update.status ? ` (${update.status})` : ''}` })
        } else if (update.sessionUpdate === 'plan') event('antigravity/activity', { threadId: job.threadId, text: (update.entries ?? []).map(one => one.content).join('; ') })
        else if (update.sessionUpdate === 'permission_decision') {
          job.notices = [...job.notices, update.text].slice(-60); event('antigravity/activity', { threadId: job.threadId, text: update.text })
        }
      } })
    job.client = client
    clients.add(client)
    try {
      await client.open(params.threadId?.slice(4))
      job.threadId ??= `agy:${client.sessionId}`
      const settings = await client.configure(params)
      if (stopping) throw new Error('Bridge is shutting down')
      jobs.set(job.threadId, job)
      return { thread: { id: job.threadId }, ...settings, notices: job.notices }
    } catch (error) { client.close(); clients.delete(client); throw error }
  }
  const finish = job => {
    const turn = { id: job.turnId, status: job.error ? 'failed' : job.cancelled ? 'interrupted' : 'completed',
      error: job.error ? { message: job.error } : null,
      items: [{ type: 'agentMessage', phase: 'final_answer', text: [job.text, ...job.notices.filter(line => line.startsWith('permission denied:'))].filter(Boolean).join('\n\n') }] }
    event('turn/completed', { threadId: job.threadId, turn })
  }
  return {
    async dispatch(method, params) {
      try {
        if (stopping) throw new Error('Bridge is shutting down')
        if (method === 'antigravity/start') return { result: await open(params) }
        if (method === 'antigravity/resume') return { result: await serial(params.threadId, () => jobs.has(params.threadId) ? {} : open(params)) }
        const job = jobs.get(params.threadId)
        if (!job) throw new Error('Antigravity session is not loaded; resume it before prompting')
        if (method === 'antigravity/cancel') { job.cancelled = true; job.client.cancel(); return { result: {} } }
        if (method === 'antigravity/release') {
          if (!job.count) { job.client.close(); clients.delete(job.client); jobs.delete(job.threadId) }
          return { result: {} }
        }
        if (method !== 'antigravity/prompt') throw new Error(`Unknown backend operation ${method}`)
        if (!job.count) {
          job.text = ''; job.notices = []; job.error = null; job.cancelled = false; job.turnId = randomUUID()
          job.client.cancelled = false
          event('turn/started', { threadId: job.threadId, turn: { id: job.turnId } })
        }
        job.count++
        // Steering is another ACP prompt, never a second independent turn. Wait for all correlated responses.
        void job.client.prompt(params.text).then(answer => {
          if (answer.stopReason === 'cancelled') job.cancelled = true
          else if (!['end_turn', 'max_tokens', 'max_turn_requests', 'refusal'].includes(answer.stopReason)) job.error = `Unexpected ACP stopReason: ${answer.stopReason}`
        }, error => { job.error ??= providerError(error); if (job.count > 1) job.client.cancel() }).finally(() => { if (--job.count === 0) finish(job) })
        return { result: { turn: { id: job.turnId } } }
      } catch (error) { return { error: { message: providerError(error) } } }
    },
    close() { stopping = true; for (const client of clients) client.close(); clients.clear(); jobs.clear() },
  }
}
