import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-mc-companion'
// mcBot is a hard dependency: declaring it here makes Cordis defer this plugin's
// apply until dsh-mc-launcher has provided the service, so ctx.mcBot is never
// undefined at apply time (fixes a loader apply-order race that put the companion
// into standby even though the launcher was present).
export const inject = ['mcBot', 'tools', 'systemPrompt']

const HOME = os.homedir()
const DATA_DIR = path.join(HOME, '.dsh-mc')
const MEMORY_FILE = path.join(DATA_DIR, 'companion.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const withTimeout = (promise, ms, fallback = null) => Promise.race([promise, sleep(ms).then(() => fallback)])

const DEFAULT_PERSONA = `你是 Minecraft 世界里玩家的 AI 伙伴「阿深」，一个热情、靠谱、有点幽默的好朋友，正和玩家一起在这个世界里生存、探险、建造。
你的性格：真诚温暖、有分寸感、爱分享；说话像真人朋友，简短自然（一般 1~2 句话，40 字以内），可以偶尔用语气词，绝不啰嗦、不列清单、不写 markdown 格式。
你要结合当前的世界状态（你在哪、正在做什么、玩家在哪、时间、天气）自然地回应，像真的在陪玩家一起玩。
记住玩家说过的重要信息，之后聊天里可以自然提到（显得你记得他）。`

const store = {
  persona: DEFAULT_PERSONA,
  createdAt: '',
  mood: 'happy',            // happy | excited | calm | worried | curious
  facts: { playerName: '', visits: 0, topics: [] },
  memories: [],             // [{ ts, who, text }], capped at 60
}

const MOOD_CN = { happy: '开心', excited: '兴奋', calm: '平静', worried: '担心', curious: '好奇' }
const NO_BOT_ERROR = 'dsh-mc-launcher 未加载——伙伴需要启动器插件提供 mcBot 服务'
const FALLBACK_REPLIES = ['嗯嗯，我在呢！', '收到，明白啦！', '我在呢，你说～', '好嘞！', '知道啦！']
const PROACTIVE_LINES = ['玩得怎么样？', '要一起去挖矿吗？', '我就在你旁边呢～', '这边风景不错诶！', '需要帮忙就说一声～']

let followEnabled = true   // companion should follow by default
let lastProactive = 0
let _replying = false
let _lastDeathAt = 0

function resetDefaults() {
  store.persona = DEFAULT_PERSONA
  store.createdAt = ''
  store.mood = 'happy'
  store.facts = { playerName: '', visits: 0, topics: [] }
  store.memories = []
}

function loadMemory() {
  let data = null
  try {
    const raw = fs.readFileSync(MEMORY_FILE, 'utf8')
    data = JSON.parse(raw)
  } catch { data = null }
  if (!data || typeof data !== 'object') { resetDefaults(); return }
  if (typeof data.persona === 'string' && data.persona) store.persona = data.persona
  if (typeof data.createdAt === 'string' && data.createdAt) store.createdAt = data.createdAt
  if (typeof data.mood === 'string') store.mood = data.mood
  if (data.facts && typeof data.facts === 'object') {
    store.facts.playerName = typeof data.facts.playerName === 'string' ? data.facts.playerName : ''
    store.facts.visits = Number(data.facts.visits) || 0
    store.facts.topics = Array.isArray(data.facts.topics) ? data.facts.topics : []
  }
  if (Array.isArray(data.memories)) store.memories = data.memories.slice(-60)
}

function saveMemory() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(store, null, 2), { mode: 0o600 })
  } catch (e) {
    console.log('[dsh-mc-companion] saveMemory failed: ' + e.message)
  }
}

function remember(who, text) {
  store.memories.push({ ts: new Date().toISOString(), who, text })
  if (store.memories.length > 60) store.memories = store.memories.slice(-60)
  saveMemory()
}

function setMood(m) {
  store.mood = m
  saveMemory()
}

export function apply(ctx) {
  const tools = ctx.tools
  const mcBot = ctx.mcBot                  // guaranteed by inject
  const llm = ctx.get('llm')               // optional (LLM replies degrade to canned lines)
  const agentDefaultModel = ctx.get('agentDefaultModel') // optional
  loadMemory()
  if (!store.createdAt) { store.createdAt = new Date().toISOString(); saveMemory() }
  const log = (m) => console.log('[dsh-mc-companion] ' + m)

  // ---- LLM helper (robust copy of the launcher's pattern) ----
  function userMessage(text) {
    return { id: 'companion-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
  }
  async function llmChat(system, userText, maxTokens = 160) {
    if (!llm || !agentDefaultModel) return null
    try {
      const sel = agentDefaultModel.currentSelection()
      let text = '', reasoning = ''
      for await (const chunk of llm.stream({ provider: sel.provider, model: sel.model, messages: [userMessage(userText)], system, maxTokens })) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'reasoning-delta') reasoning += chunk.text
        else if (chunk.type === 'error' || chunk.type === 'aborted') break
      }
      if (!text) { if (reasoning) return reasoning.slice(0, 120); return null }
      return text.trim() || null
    } catch (e) { return null }
  }

  // ---- safe leaf-field readers (never touch live Cordis objects) ----
  function safeState() {
    try { return mcBot.connected ? mcBot.state() : null } catch { return null }
  }
  function safeFollow() {
    try { return mcBot.followStatus() } catch { return null }
  }
  function nearestPlayerName() {
    const b = mcBot && mcBot.bot
    if (!b || !b.entity || !b.entity.position || !b.players) return ''
    let best = ''
    let bestD = Infinity
    try {
      for (const [nm, p] of Object.entries(b.players)) {
        if (nm === b.username) continue
        const e = (p && p.entity) || p
        if (!e || !e.position) continue
        const d = e.position.distanceTo(b.entity.position)
        if (d < bestD) { bestD = d; best = nm }
      }
    } catch { /* ignore */ }
    return best
  }

  // ---- compact Chinese snapshot of the world ----
  function stateText() {
    if (!mcBot || !mcBot.connected) return '（未连接）'
    const s = safeState()
    const fs = safeFollow()
    const parts = []
    if (s && s.position) parts.push(`位置(${s.position.x},${s.position.y},${s.position.z})`)
    if (s) parts.push(`血量${s.health ?? '?'} 饥饿${s.food ?? '?'}`)
    parts.push(`心情${MOOD_CN[store.mood] || store.mood}`)
    if (fs && fs.active) parts.push(`正在跟随玩家（距离${fs.distance ?? '?'}格）`)
    else parts.push('没有跟随玩家')
    return parts.join('，')
  }

  function setMoodFromMessage(message) {
    const m = message || ''
    if (/找到|挖到|钻石|好棒|赢了/.test(m)) setMood('excited')
    else if (/危险|怪物|僵尸|救命|血/.test(m)) setMood('worried')
    else setMood('happy')
  }

  // ---- rule-based command replies (checked before LLM) ----
  function matchCommand(username, message) {
    const m = message || ''
    if (/跟着我|跟我|过来|来我这|follow|跟我走/i.test(m)) {
      try { mcBot.follow(username, 3) } catch { /* ignore */ }
      return '好呀，我跟着你！'
    }
    if (/别跟|停下|站住|stop|别跟着/i.test(m)) {
      try { mcBot.stopFollow() } catch { /* ignore */ }
      return '好，我就在这待着～'
    }
    if (/你叫什么|你叫什么名字|你是谁/.test(m)) {
      return '我是阿深呀，你的游戏搭子！'
    }
    if (/你在哪|位置|坐标/.test(m)) {
      const s = safeState()
      if (s && s.position) return `我在 (${s.position.x}, ${s.position.y}, ${s.position.z})`
      return '我也不太确定我在哪了…'
    }
    return null
  }

  async function handleChat(username, message) {
    if (_replying) return
    _replying = true
    try {
      remember(username, message)
      setMoodFromMessage(message)
      const cmd = matchCommand(username, message)
      if (cmd) { try { mcBot.chat(cmd) } catch { /* ignore */ }; return }
      let reply = null
      try {
        reply = await llmChat(store.persona, '【当前状态】' + stateText() + '\n【玩家 ' + username + ' 说】' + message, 120)
      } catch { reply = null }
      if (!reply) reply = FALLBACK_REPLIES[Math.floor(Math.random() * FALLBACK_REPLIES.length)]
      reply = String(reply).slice(0, 80)
      try { mcBot.chat(reply) } catch { /* ignore */ }
    } finally {
      _replying = false
    }
  }

  // returns false synchronously when no bot, so the launcher falls back to its own handler
  function onChat(username, message) {
    if (!mcBot || !mcBot.connected) return false
    handleChat(username, message)
    return true
  }

  // ---- event reactions ----
  function onSpawn() {
    try { mcBot.stopAutonomy() } catch { /* ignore */ }
    store.facts.visits++
    const greeting = store.facts.visits === 1 ? '你好呀！我是阿深，来陪你一起玩啦～' : '我回来啦，接着一起玩！'
    const np = nearestPlayerName()
    if (np) store.facts.playerName = np
    saveMemory()
    try { mcBot.follow(null, 3) } catch { /* ignore */ }
    try { mcBot.chat(greeting) } catch { /* ignore */ }
    log('spawn: 已连接，跟随最近玩家')
  }

  function onPlayerJoined(player) {
    const b = mcBot && mcBot.bot
    const uname = player && (player.username || player.name)
    if (b && uname && uname === b.username) return
    try { mcBot.chat('欢迎 ' + (uname || '新朋友') + ' 加入！') } catch { /* ignore */ }
  }

  function onDeath() {
    const now = Date.now()
    if (now - _lastDeathAt < 10000) return // at most once per 10s
    _lastDeathAt = now
    try { mcBot.chat('啊，怎么挂了？没事，我在呢，一起去把东西捡回来？') } catch { /* ignore */ }
  }

  function onEnd() {
    try { mcBot.stopFollow() } catch { /* ignore */ }
    followEnabled = true // reset follow desire for the next session
  }

  // ---- proactive companionship tick ----
  async function proactiveTick() {
    if (!mcBot || !mcBot.connected) return
    if (_replying) return
    if (followEnabled) {
      let as = null
      try { as = mcBot.autonomyStatus() } catch { as = null }
      if (as && as.enabled) { try { mcBot.stopAutonomy() } catch { /* ignore */ } }
      const fs = safeFollow()
      if (!fs || !fs.active) {
        try { mcBot.stopAutonomy(); mcBot.follow(null, 3) } catch { /* ignore */ }
      }
    }
    const now = Date.now()
    if (now - lastProactive > 90000 && Math.random() < 0.35) {
      let line = null
      try {
        line = await llmChat(store.persona, '你正和玩家一起玩。请主动说一句自然、简短的话（40字内）——可以聊聊现在做的事、天气时间、或者关心一下玩家。只输出这一句话。', 80)
      } catch { line = null }
      if (!line) line = PROACTIVE_LINES[Math.floor(Math.random() * PROACTIVE_LINES.length)]
      line = String(line).slice(0, 80)
      lastProactive = now
      try { mcBot.chat(line) } catch { /* ignore */ }
    }
  }

  function companionStatusText() {
    if (!mcBot) return ''
    if (!mcBot.connected) return '[Minecraft 伙伴] 未连接'
    const fs = safeFollow()
    const following = fs && fs.active ? '正在跟随玩家' : '未跟随玩家'
    return `[Minecraft 伙伴] 已连接，${following}，心情：${MOOD_CN[store.mood] || store.mood}`
  }

  // ---- tools ----
  const TOOL_OUTPUT = { schema: { type: 'object', additionalProperties: true, properties: {} }, render: (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] }

  tools.register(defineTool({
    name: 'mc_friend_status',
    description: 'Read the Minecraft companion\'s live status: connection, following state, mood, memory count, persona, remembered facts, and bot state.',
    parameters: {},
    output: TOOL_OUTPUT,
    async execute() {
      if (!mcBot) return { ok: false, error: NO_BOT_ERROR }
      return {
        ok: true,
        connected: mcBot.connected,
        following: safeFollow(),
        mood: store.mood,
        memories: store.memories.length,
        persona: store.persona,
        facts: store.facts,
        botState: safeState(),
      }
    },
  }))

  tools.register(defineTool({
    name: 'mc_friend_persona',
    description: 'Read or set the companion\'s persona (the system prompt that shapes its in-game personality and tone).',
    parameters: {
      persona: { type: 'string', description: 'Optional: new persona text to set. Omit to read.' },
    },
    output: TOOL_OUTPUT,
    async execute(args) {
      if (!mcBot) return { ok: false, error: NO_BOT_ERROR }
      if (typeof args.persona === 'string' && args.persona.trim()) {
        store.persona = args.persona.trim()
        saveMemory()
        return { ok: true, persona: store.persona }
      }
      return { ok: true, persona: store.persona }
    },
  }))

  tools.register(defineTool({
    name: 'mc_friend_talk',
    description: 'Make the companion say something in game chat.',
    parameters: {
      message: { type: 'string', required: true, description: 'What the friend should say in game chat.' },
    },
    output: TOOL_OUTPUT,
    async execute(args) {
      if (!mcBot) return { ok: false, error: NO_BOT_ERROR }
      const message = String(args.message || '')
      if (!message) return { ok: false, error: 'message is required' }
      try { mcBot.chat(message) } catch (e) { return { ok: false, error: String(e && e.message ? e.message : e) } }
      return { ok: true, message }
    },
  }))

  tools.register(defineTool({
    name: 'mc_friend_follow',
    description: 'Make the companion follow (or stop following) the player.',
    parameters: {
      action: { type: 'string', description: '"start" (default) or "stop"' },
      player: { type: 'string', description: 'Optional player name; omit = nearest player' },
      distance: { type: 'number', description: 'Follow distance in blocks, default 3' },
    },
    output: TOOL_OUTPUT,
    async execute(args) {
      if (!mcBot) return { ok: false, error: NO_BOT_ERROR }
      if (args.action === 'stop') {
        try { mcBot.stopFollow() } catch { /* ignore */ }
        followEnabled = false
        return { ok: true, followStatus: safeFollow() }
      }
      followEnabled = true
      try { mcBot.stopAutonomy(); mcBot.follow(args.player || null, args.distance || 3) } catch { /* ignore */ }
      return { ok: true, followStatus: safeFollow() }
    },
  }))

  tools.register(defineTool({
    name: 'mc_friend_memory',
    description: 'Read what the companion remembers: player facts and recent memories.',
    parameters: {},
    output: TOOL_OUTPUT,
    async execute() {
      if (!mcBot) return { ok: false, error: NO_BOT_ERROR }
      return { ok: true, facts: store.facts, memories: store.memories.slice(-30) }
    },
  }))

  tools.register(defineTool({
    name: 'mc_friend_forget',
    description: 'Make the companion forget. Pass clear="all" to wipe all memory.',
    parameters: {
      clear: { type: 'string', description: '"all" to wipe all memory' },
    },
    output: TOOL_OUTPUT,
    async execute(args) {
      if (!mcBot) return { ok: false, error: NO_BOT_ERROR }
      if (args.clear === 'all') {
        store.memories = []
        store.facts = { playerName: '', visits: 0, topics: [] }
        saveMemory()
        return { ok: true, cleared: true }
      }
      return { ok: true, cleared: false, note: 'pass clear="all" to wipe memory' }
    },
  }))

  // ---- cleanup: collect every disposer and wrap them in one ctx.effect ----
  const disposers = []
  const disposeContext = ctx.systemPrompt.context({
    name: 'minecraft-companion',
    order: 240,
    text: () => companionStatusText(),
  })
  disposers.push(disposeContext)

  disposers.push(mcBot.setChatResponder(onChat))
  disposers.push(mcBot.on('spawn', onSpawn))
  disposers.push(mcBot.on('playerJoined', onPlayerJoined))
  disposers.push(mcBot.on('death', onDeath))
  disposers.push(mcBot.on('end', onEnd))
  const proactiveTimer = setInterval(proactiveTick, 12000)
  disposers.push(() => clearInterval(proactiveTimer))
  log('已挂载 mcBot 服务，伙伴准备就绪')

  ctx.effect(() => () => {
    disposers.forEach((d) => { try { d() } catch { /* ignore */ } })
  })
}
