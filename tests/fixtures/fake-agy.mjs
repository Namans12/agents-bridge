// Windows-compatible ACP fixture: launch with node, never rely on a shebang.
import readline from 'node:readline'
import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'

if (process.argv.includes('--version')) { console.log('agy 1.5.1'); process.exit(0) }
if (process.argv.includes('--help')) { console.log('Usage: agy acp [flags]'); process.exit(0) }
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\r\n')
let sessionId
let cwd
const pending = new Map()
const permissions = new Map()
let nextPermission = 1000
let configOptions = [
  { id: 'account-model', name: 'Model', category: 'model', type: 'select', currentValue: 'fixture-gemini',
    options: [{ group: 'available', name: 'Available', options: [{ value: 'fixture-gemini', name: 'Gemini fixture' }, { value: 'fixture-other', name: 'Other fixture' }] }] },
  { id: 'thinking', name: 'Thinking level', category: 'thought_level', type: 'select', currentValue: 'medium', options: [{ value: 'low-id', name: 'Low' }, { value: 'medium', name: 'Medium' }] },
  { id: 'execution', name: 'Mode', category: 'mode', type: 'select', currentValue: 'code', options: [{ value: 'code', name: 'Code' }, { value: 'plan', name: 'Plan' }] },
  ...(process.env.FAKE_AGY_NO_CREDITS ? [] : [{ id: 'useG1Credits', name: 'Use AI Credits', type: 'boolean', currentValue: true }]),
]
const update = content => send({ method: 'session/update', params: { sessionId, update: content } })
const chunk = text => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })
const complete = (id, text = 'FAKE_AGY_OK') => {
  if (text) { chunk(text.slice(0, 5)); chunk(text.slice(5)) }
  pending.delete(id); send({ id, result: { stopReason: 'end_turn' } })
}
readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  const message = JSON.parse(line)
  if (process.env.FAKE_AGY_TRACE) fs.appendFileSync(process.env.FAKE_AGY_TRACE, JSON.stringify(message) + '\n')
  const { id, method, params = {} } = message
  if (!method) {
    const promptId = permissions.get(id)
    if (promptId !== undefined) { permissions.delete(id); complete(promptId, `PERMISSION:${message.result?.outcome?.optionId ?? message.result?.outcome?.outcome}`) }
    return
  }
  if (method === 'initialize') {
    if (params.protocolVersion !== 1 || params.clientCapabilities?.fs || params.clientCapabilities?.terminal) throw new Error('Untruthful initialize')
    send({ id, result: { protocolVersion: 1, agentCapabilities: {
      loadSession: !process.env.FAKE_AGY_NO_RESUME,
      sessionCapabilities: { ...(process.env.FAKE_AGY_LOAD_ONLY || process.env.FAKE_AGY_NO_RESUME ? {} : { resume: {} }), close: {} },
    }, authMethods: [{ id: 'oauth-personal', name: 'Google' }] } })
  } else if (['session/new', 'session/resume', 'session/load'].includes(method)) {
    if (process.env.FAKE_AGY_AUTH_ERROR) return send({ id, error: { code: -32000, message: 'Authentication required' } })
    if (!path.isAbsolute(params.cwd) || !Array.isArray(params.mcpServers)) throw new Error('Bad session setup')
    if (method === 'session/new' ? params.sessionId !== undefined : typeof params.sessionId !== 'string') throw new Error('Wrong new/resume session fields')
    cwd = params.cwd; sessionId = params.sessionId ?? `fixture-${randomUUID()}`
    if (method === 'session/load') chunk('REPLAY_MUST_NOT_APPEAR')
    send({ id, result: { ...(method === 'session/new' ? { sessionId } : {}), configOptions } })
  } else if (method === 'session/set_config_option') {
    const option = configOptions.find(one => one.id === params.configId)
    if (!option || (option.type === 'boolean' && params.type !== 'boolean')) throw new Error('Bad config field')
    option.currentValue = params.value
    send({ id, result: { configOptions } })
  } else if (method === 'session/prompt') {
    if (params.sessionId !== sessionId || params.prompt?.[0]?.type !== 'text') throw new Error('Bad prompt')
    const text = params.prompt[0].text
    if (text === 'quota') return send({ id, error: { code: -32010, message: 'RESOURCE_EXHAUSTED: subscription quota and credits exhausted (429)' } })
    if (text === 'crash') { console.error('fixture crash'); process.exit(7) }
    if (text === 'malformed') { process.stdout.write('not json\n'); return }
    pending.set(id, text)
    if (text === 'hang' || text === 'ignore-cancel') { update({ sessionUpdate: 'tool_call', toolCallId: 'tool1', title: 'Waiting', status: 'in_progress' }); return }
    if (text.startsWith('permission-')) {
      const permissionId = nextPermission++
      permissions.set(permissionId, id)
      const target = text.includes('outside') ? path.resolve(cwd, '..', 'outside.txt') : path.join(cwd, 'file.txt')
      if (text === 'permission-prior-outside') update({ sessionUpdate: 'tool_call', toolCallId: 'edit1', locations: [{ path: target }], kind: 'edit', title: 'Outside edit' })
      send({ id: permissionId, method: 'session/request_permission', params: { sessionId,
        toolCall: { toolCallId: 'edit1', kind: 'edit', ...(['permission-no-path', 'permission-prior-outside'].includes(text) ? {} : { locations: [{ path: target }] }) },
        options: [{ optionId: 'allow-id', name: 'Allow once', kind: 'allow_once' }, { optionId: 'deny-id', name: 'Reject', kind: 'reject_once' }] } })
      return
    }
    if (text === 'env') return complete(id, `KEYS:${Object.keys(process.env).filter(key => /^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_GENAI_USE_)/i.test(key)).join(',')}`)
    if (pending.size > 1) for (const [prior] of pending) if (prior !== id) { pending.delete(prior); send({ id: prior, result: { stopReason: 'end_turn' } }) }
    setTimeout(() => complete(id), 30)
  } else if (method === 'session/cancel') {
    for (const [promptId, text] of pending) {
      if (text === 'ignore-cancel') continue
      pending.delete(promptId); send({ id: promptId, result: { stopReason: 'cancelled' } })
    }
  } else if (method === 'session/close') send({ id, result: {} })
  else if (id !== undefined) send({ id, error: { code: -32601, message: 'Unknown method' } })
})
