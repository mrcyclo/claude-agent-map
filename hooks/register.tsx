import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { MapAgent, MapCall, MapGraph, MapOpen, MapSection, MapTurn } from '../types'

const PANE = 'agent-map'
const TITLE = 'Sơ đồ tác nhân'
const AGENT_TOOLS = new Set(['Agent', 'Task'])
const HIDDEN_TOOL_PREFIXES = ['mcp__ccd_turn__']
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const KEEP_TURNS = 15
const KEEP_CALLS = 250
const MAX_BODY = 4000
const INPUT_META_KEYS = new Set(['tool', 'tool_use_id', 'agentId', 'consent', 'origin'])

const empty: MapGraph = {
  mainModel: '',
  mainBusy: false,
  pendingText: '',
  turns: [],
  agents: [],
  calls: [],
}
const graph = atom({ plugin: 'agent-map', key: 'graph' } as const, empty, { shape: 'graph-3' })
const open = atom({ plugin: 'agent-map', key: 'open' } as const, {} as MapOpen, { shape: 'open-1' })
const tick = atom({ plugin: 'agent-map', key: 'tick' } as const, 0)

type Fields = Record<string, unknown>

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined
}

function short(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

function clip(text: string, max = MAX_BODY): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `\n… (cắt bớt ${text.length - max} ký tự)`
}

function lineCount(text: string): number {
  if (text.length === 0) return 0
  return text.replace(/\n$/, '').split('\n').length
}

function promptLine(text: string): string {
  const clean = text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ')
  const first = clean.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
  return short(first, 90)
}

function langOf(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', json: 'json', md: 'markdown',
    py: 'python', cs: 'csharp', php: 'php', go: 'go', rs: 'rust', css: 'css', html: 'html',
    sh: 'bash', ps1: 'powershell', yml: 'yaml', yaml: 'yaml', sql: 'sql', xml: 'xml',
  }
  return map[ext]
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(p => p.length > 0)
  if (parts.length <= 2) return path
  return '…/' + parts.slice(-2).join('/')
}

function workflowName(script: string): string {
  const m = /name\s*:\s*['"`]([^'"`]+)['"`]/.exec(script)
  return m?.[1] ?? ''
}

function toolLabel(tool: string): string {
  if (!tool.startsWith('mcp__')) return tool
  const parts = tool.split('__')
  const server = parts[1] ?? ''
  const name = parts.slice(2).join('__')
  return `${server.length > 12 ? server.slice(0, 6) + '…' : server} › ${name}`
}

function toolColor(tool: string): string {
  if (SHELL_TOOLS.has(tool)) return 'bashBorder'
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') return 'autoAccept'
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') return 'suggestion'
  if (tool.startsWith('mcp__')) return 'permission'
  return 'inactive'
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

function secs(from: number, to: number): string {
  const s = Math.max(0, Math.round((to - from) / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

function inputJson(input: Fields): string {
  const args = Object.fromEntries(Object.entries(input).filter(([k]) => !INPUT_META_KEYS.has(k)))
  return clip(JSON.stringify(args, null, 2))
}

type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

function patchOf(v: unknown): { diff: string; added: number; removed: number } | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined
  const hunks = v as Hunk[]
  let added = 0
  let removed = 0
  const parts = hunks.map(h => {
    for (const l of h.lines) {
      if (l.startsWith('+')) {
        added++
      } else if (l.startsWith('-')) {
        removed++
      }
    }
    return `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join('\n')}`
  })
  return { diff: clip(parts.join('\n')), added, removed }
}

function naiveDiff(oldText: string, newText: string): string {
  const minus = oldText.split('\n').map(l => '-' + l)
  const plus = newText.split('\n').map(l => '+' + l)
  return clip([...minus, ...plus].join('\n'))
}

type Described = { title: string; summary: string; sections: MapSection[] }

function describeInput(tool: string, e: Fields): Described {
  if (SHELL_TOOLS.has(tool)) {
    const command = str(e.command)
    return {
      title: short(command, 120),
      summary: str(e.description),
      sections: [{ title: 'Lệnh', body: clip(command), language: tool === 'Bash' ? 'bash' : 'powershell' }],
    }
  }
  if (tool === 'Edit') {
    const path = str(e.file_path)
    return {
      title: path,
      summary: e.replace_all === true ? 'Đang sửa (thay tất cả)' : 'Đang sửa',
      sections: [{ title: 'Thay đổi', body: naiveDiff(str(e.old_string), str(e.new_string)), format: 'diff' }],
    }
  }
  if (tool === 'Write') {
    const path = str(e.file_path)
    const content = str(e.content)
    return {
      title: path,
      summary: `Đang ghi ${lineCount(content)} dòng`,
      sections: [{ title: 'Nội dung', body: clip(content), language: langOf(path) }],
    }
  }
  if (tool === 'Read') {
    return { title: str(e.file_path), summary: 'Đang đọc', sections: [] }
  }
  if (tool === 'Workflow') {
    const script = str(e.script)
    const name = workflowName(script) || str(e.name) || str(e.scriptPath)
    const sections: MapSection[] = []
    if (script.length > 0) {
      sections.push({ title: 'Script', body: clip(script, 6000), language: 'javascript' })
    }
    if (e.args !== undefined) {
      sections.push({ title: 'Args', body: clip(JSON.stringify(e.args, null, 2)), language: 'json' })
    }
    return { title: name ? `Workflow ${name}` : 'Workflow', summary: 'Đang khởi chạy', sections }
  }
  if (tool === 'Grep' || tool === 'Glob') {
    const where = str(e.path) || str(e.glob)
    return {
      title: str(e.pattern) + (where ? `  trong ${where}` : ''),
      summary: 'Đang tìm',
      sections: [{ title: 'Tham số', body: inputJson(e), language: 'json' }],
    }
  }
  return {
    title: toolLabel(tool),
    summary: '',
    sections: [{ title: 'Tham số', body: inputJson(e), language: 'json' }],
  }
}

function describeResult(tool: string, e: Fields, result: unknown, text: string, before: Described): Described {
  const r = (typeof result === 'object' && result !== null ? result : {}) as Fields
  if (SHELL_TOOLS.has(tool)) {
    const out = str(r.stdout)
    const err = str(r.stderr)
    const flags = [
      r.interrupted === true ? 'bị ngắt' : '',
      num(r.timedOutAfterMs) !== undefined ? 'quá thời gian' : '',
      str(r.backgroundTaskId) ? 'chạy nền' : '',
    ].filter(f => f.length > 0)
    const sections = [...before.sections]
    if (out.length > 0) {
      sections.push({ title: 'Kết quả', body: clip(out) })
    }
    if (err.length > 0) {
      sections.push({ title: 'stderr', body: clip(err) })
    }
    if (out.length === 0 && err.length === 0 && text.length > 0) {
      sections.push({ title: 'Kết quả', body: clip(text) })
    }
    const lines = lineCount(out) + lineCount(err)
    const head = lines === 0 ? 'Không có kết quả' : `${lines} dòng kết quả`
    return { ...before, summary: [before.summary, head, ...flags].filter(s => s.length > 0).join(' · '), sections }
  }
  if (tool === 'Edit' || tool === 'Write') {
    const path = str(r.filePath) || before.title
    const patch = patchOf(r.structuredPatch)
    if (tool === 'Write' && r.type === 'create') {
      const content = str(r.content) || str(e.content)
      return {
        title: path,
        summary: `Tạo file mới · ${lineCount(content)} dòng`,
        sections: [{ title: fileName(path), body: clip(content), language: langOf(path) }],
      }
    }
    if (patch === undefined) return { ...before, summary: 'Đã ghi' }
    return {
      title: path,
      summary: `+${patch.added} −${patch.removed} dòng`,
      sections: [{ title: fileName(path), body: patch.diff, format: 'diff' }],
    }
  }
  if (tool === 'Read') {
    const file = (typeof r.file === 'object' && r.file !== null ? r.file : {}) as Fields
    const content = str(file.content)
    const start = num(file.startLine) ?? 1
    const count = num(file.numLines) ?? lineCount(content)
    const total = num(file.totalLines)
    const range = `Dòng ${start} đến ${start + Math.max(0, count - 1)}` + (total !== undefined ? ` / ${total}` : '')
    const path = str(file.filePath) || before.title
    if (content.length === 0) return { ...before, summary: r.type === 'image' ? 'Ảnh' : range }
    return { title: path, summary: range, sections: [{ title: fileName(path), body: clip(content, 2500), language: langOf(path) }] }
  }
  if (tool === 'Grep' || tool === 'Glob') {
    const files = Array.isArray(r.filenames) ? (r.filenames as unknown[]).map(str) : []
    const content = str(r.content)
    const matches = num(r.numMatches) ?? num(r.numLines)
    const summary = [
      `${num(r.numFiles) ?? files.length} file`,
      matches !== undefined ? `${matches} kết quả khớp` : '',
      r.truncated === true ? 'đã cắt bớt' : '',
    ].filter(s => s.length > 0).join(' · ')
    const body = content.length > 0 ? content : files.join('\n')
    const sections = [...before.sections]
    if (body.length > 0) {
      sections.push({ title: 'Kết quả', body: clip(body) })
    }
    return { ...before, summary, sections }
  }
  const sections = [...before.sections]
  const body = text.length > 0 ? text : result === undefined ? '' : JSON.stringify(result, null, 2)
  if (body.length > 0) {
    sections.push({ title: 'Kết quả', body: clip(body) })
  }
  return { ...before, summary: body.length > 0 ? `${lineCount(body)} dòng kết quả` : 'Xong', sections }
}

function currentTurn(g: MapGraph): MapTurn | undefined {
  return g.turns[g.turns.length - 1]
}

function prune(g: MapGraph): MapGraph {
  const turns = g.turns.slice(-KEEP_TURNS)
  const keep = new Set(turns.map(t => t.id))
  const agents = g.agents.filter(a => keep.has(a.turnId) || !a.isDone)
  const calls = g.calls.filter(c => keep.has(c.turnId) || !c.isDone).slice(-KEEP_CALLS)
  return { ...g, turns, agents, calls }
}

function ensureTurn(g: MapGraph, now: number): MapGraph {
  if (g.turns.length > 0) return g
  return { ...g, turns: [{ id: 't1', index: 1, text: '(trước khi mở sơ đồ)', startedAt: now }] }
}

function toggle($: EngineInterface, key: string, to: boolean): void {
  void update($, open, prev => ({ ...prev, [key]: to }))
}

// Waits for the redraw the state write triggers, so the new last row exists before scrolling.
function follow($: EngineInterface): void {
  $.clock.after(120, () => {
    void $.ui.scroll({ in: PANE, to: 'end' })
  })
}

function setAll($: EngineInterface, keys: string[], to: boolean): void {
  void update($, open, prev => ({ ...prev, ...Object.fromEntries(keys.map(k => [k, to])) }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agent-map',
      description: 'Mở sơ đồ realtime các tác nhân đang chạy và model của chúng',
    })
    const model = await $.session.model()
    await update($, graph, g => ({ ...g, mainModel: model }))
    $.clock.every(1000, () => {
      void (async () => {
        const g = await read($, graph)
        if (g.mainBusy || g.calls.some(c => !c.isDone) || g.agents.some(a => !a.isDone)) {
          await update($, tick, t => t + 1)
        }
      })()
    })
    void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('command.run', { command: 'agent-map' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Đã mở sơ đồ tác nhân.' }
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta === true) return next(e)
    const text = promptLine(e.text)
    if (text.length > 0) {
      await update($, graph, g => ({ ...g, pendingText: text }))
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const now = await $.clock.now()
    const g0 = await read($, graph)
    const last = currentTurn(g0)
    // No prompt.submit before this turn: a background notification continues the last message.
    if (g0.pendingText.length === 0 && last !== undefined) {
      await update($, graph, g => ({
        ...g,
        mainBusy: true,
        turns: g.turns.map(t => (t.id === last.id ? { ...t, endedAt: undefined } : t)),
      }))
      return next(e)
    }
    await update($, graph, g => {
      const index = (currentTurn(g)?.index ?? 0) + 1
      const turn: MapTurn = {
        id: `t${index}`,
        index,
        text: g.pendingText || '(thông báo nền)',
        startedAt: now,
      }
      return prune({ ...g, mainBusy: true, pendingText: '', turns: [...g.turns, turn] })
    })
    // Dropping every hand toggle folds all older groups back to their default.
    await update($, open, () => ({}))
    follow($)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const model = e.model
    await update($, graph, g =>
      e.agentId === undefined
        ? { ...g, mainModel: model }
        : { ...g, agents: g.agents.map(a => (a.id === e.agentId ? { ...a, model } : a)) },
    )
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    if (e.agentId === undefined) {
      await update($, graph, g => ({
        ...g,
        mainBusy: false,
        turns: g.turns.map((t, i) => (i === g.turns.length - 1 && t.endedAt === undefined ? { ...t, endedAt: now } : t)),
      }))
      return next(e)
    }
    const id = e.agentId
    await update($, graph, g => ({
      ...g,
      agents: g.agents.map(a => (a.id === id ? { ...a, isDone: true, endedAt: now } : a)),
    }))
    // Without its hand toggle a finished agent falls back to collapsed.
    await update($, open, o => {
      const { [`a:${id}`]: _gone, ...rest } = o
      return rest
    })
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.agentId === undefined) return ran
    const now = await $.clock.now()
    const id = ran.agentId
    await update($, graph, g0 => {
      const g = ensureTurn(g0, now)
      const agent: MapAgent = {
        id,
        turnId: currentTurn(g)?.id ?? 't1',
        parentId: e.parentAgentId,
        kind: e.workflow ? `agent ${e.workflow.agentIndex}` : e.subagentType || (e.fork ? 'fork' : 'agent'),
        label: short(e.description || e.name || promptLine(e.prompt), 90),
        prompt: clip(e.prompt, 3000),
        model: ran.model,
        workflowRunId: e.workflow?.runId,
        workflowIndex: e.workflow?.agentIndex,
        isDone: false,
        startedAt: now,
      }
      return { ...g, agents: [...g.agents.filter(a => a.id !== id), agent] }
    })
    follow($)
    return ran
  })

  on('tool.call', async ($, e, next) => {
    if (AGENT_TOOLS.has(e.tool)) return next(e)
    if (HIDDEN_TOOL_PREFIXES.some(p => e.tool.startsWith(p))) return next(e)
    const now = await $.clock.now()
    const id = e.tool_use_id
    const input = e as unknown as Fields
    const before = describeInput(e.tool, input)
    await update($, graph, g0 => {
      const g = ensureTurn(g0, now)
      const call: MapCall = {
        id,
        turnId: currentTurn(g)?.id ?? 't1',
        agentId: e.agentId,
        tool: e.tool,
        ...before,
        isDone: false,
        isError: false,
        startedAt: now,
      }
      return prune({ ...g, calls: [...g.calls, call] })
    })
    follow($)
    let after: Described = { ...before, summary: 'Thất bại', sections: before.sections }
    let isError = true
    try {
      const ran = await next(e)
      if (ran.deny !== undefined) {
        after = { ...before, summary: 'Bị từ chối', sections: [...before.sections, { title: 'Lý do', body: clip(ran.deny) }] }
        return ran
      }
      isError = ran.isError === true
      const text = str(ran.text)
      after = describeResult(e.tool, input, ran.result, text, before)
      if (isError && text.length > 0) {
        after = { ...after, summary: 'Lỗi', sections: [...before.sections, { title: 'Lỗi', body: clip(text) }] }
      }
      return ran
    } finally {
      const end = await $.clock.now()
      await update($, graph, g => ({
        ...g,
        calls: g.calls.map(c => (c.id === id ? { ...c, ...after, isDone: true, isError, endedAt: end } : c)),
      }))
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const g = await read($, graph)
    const o = await read($, open)
    await read($, tick)
    const now = await $.clock.now()
    const latest = currentTurn(g)
    const isOpen = (key: string, byDefault: boolean) => o[key] ?? byDefault
    const maxTitle = Math.max(28, Math.min(110, (e.viewport?.columns ?? 80) - 28))
    const titleOf = (c: MapCall) => {
      const raw = c.title || toolLabel(c.tool)
      const isPath = c.tool === 'Edit' || c.tool === 'Write' || c.tool === 'Read'
      return short(isPath ? shortPath(raw) : raw, maxTitle)
    }

    const statusDot = (done: boolean, error: boolean) => {
      if (!done) return <Text color="warning">●</Text>
      if (error) return <Text color="error">✕</Text>
      return <Text color="success">✓</Text>
    }

    const sectionView = (s: MapSection, i: number) => (
      <Box key={`s${i}`} flexDirection="column" gap="xs">
        <Text size="caption" weight="semibold" color="subtle">{s.title.toUpperCase()}</Text>
        <Code source={s.body} language={s.language} format={s.format ?? 'source'} wrap="wrap" />
      </Box>
    )

    const callView = (c: MapCall) => {
      const key = `c:${c.id}`
      const expanded = isOpen(key, !c.isDone)
      return (
        <Box key={key} flexDirection="column" gap="xs" paddingY="xs">
          <Box flexDirection="row" gap="sm" alignItems="center">
            {statusDot(c.isDone, c.isError)}
            <Text size="footnote" weight="semibold" color="inverseText" backgroundColor={toolColor(c.tool)}>
              {` ${c.tool.startsWith('mcp__') ? 'MCP' : c.tool} `}
            </Text>
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Button key={key} plain onPress={() => toggle($, key, !expanded)}>
                <Text color="subtle">{expanded ? '▾ ' : '▸ '}</Text>
                <Text mono={SHELL_TOOLS.has(c.tool)} wrap="truncate-end">{titleOf(c)}</Text>
              </Button>
            </Box>
            <Text size="footnote" color="subtle" tabular>{secs(c.startedAt, c.endedAt ?? now)}</Text>
          </Box>
          {c.summary.length > 0 && (
            <Box paddingLeft="lg">
              <Text size="footnote" color={c.isError ? 'error' : 'subtle'}>{c.summary}</Text>
            </Box>
          )}
          {expanded && c.sections.length > 0 && (
            <Box flexDirection="column" gap="sm" paddingLeft="lg" paddingTop="xs">
              {c.sections.map(sectionView)}
            </Box>
          )}
        </Box>
      )
    }

    const subtreeSteps = (agentId: string): number =>
      g.calls.filter(c => c.agentId === agentId).length
      + g.agents.filter(a => a.parentId === agentId).reduce((n, a) => n + 1 + subtreeSteps(a.id), 0)

    const agentView = (a: MapAgent) => {
      const key = `a:${a.id}`
      const promptKey = `p:${a.id}`
      const expanded = isOpen(key, !a.isDone)
      const showPrompt = isOpen(promptKey, false)
      return (
        <Box
          key={key}
          flexDirection="column"
          gap="xs"
          borderStyle="round"
          borderColor={a.isDone ? 'inactive' : 'merged'}
          padding="sm"
          marginY="xs"
        >
          <Box flexDirection="row" gap="sm" alignItems="center">
            {statusDot(a.isDone, false)}
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Button key={key} plain onPress={() => toggle($, key, !expanded)}>
                <Text color="subtle">{expanded ? '▾ ' : '▸ '}</Text>
                <Text weight="semibold" color="merged">Sub agent · {a.kind}</Text>
              </Button>
            </Box>
            <Text size="footnote" weight="semibold" color="inverseText" backgroundColor="suggestion">{` ${shortModel(a.model)} `}</Text>
            <Text size="footnote" color="subtle" tabular>{subtreeSteps(a.id)} bước · {secs(a.startedAt, a.endedAt ?? now)}</Text>
          </Box>
          {a.label.length > 0 && <Text italic color="subtle">{a.label}</Text>}
          {expanded && a.prompt.length > 0 && (
            <Box flexDirection="column" gap="xs">
              <Button key={promptKey} plain dimColor onPress={() => toggle($, promptKey, !showPrompt)}>
                {showPrompt ? '▾ Ẩn prompt đã giao' : '▸ Xem prompt đã giao'}
              </Button>
              {showPrompt && <Code source={a.prompt} language="markdown" wrap="wrap" />}
            </Box>
          )}
          {expanded && <Box flexDirection="column">{steps(undefined, a.id)}</Box>}
        </Box>
      )
    }

    const workflowView = (runId: string, members: MapAgent[]) => {
      const key = `w:${runId}`
      const live = members.filter(a => !a.isDone).length
      const expanded = isOpen(key, live > 0)
      const first = Math.min(...members.map(a => a.startedAt))
      const last = live > 0 ? now : Math.max(...members.map(a => a.endedAt ?? a.startedAt))
      const models = [...new Set(members.map(a => shortModel(a.model)))]
      const ordered = [...members].sort((x, y) => (x.workflowIndex ?? 0) - (y.workflowIndex ?? 0))
      return (
        <Box
          key={key}
          flexDirection="column"
          gap="xs"
          borderStyle="round"
          borderColor={live > 0 ? 'planMode' : 'inactive'}
          padding="sm"
          marginY="xs"
        >
          <Box flexDirection="row" gap="sm" alignItems="center">
            {statusDot(live === 0, false)}
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Button key={key} plain onPress={() => toggle($, key, !expanded)}>
                <Text color="subtle">{expanded ? '▾ ' : '▸ '}</Text>
                <Text weight="semibold" color="planMode">Workflow</Text>
                <Text color="subtle"> {short(runId, 24)}</Text>
              </Button>
            </Box>
            <Text size="footnote" color="subtle" tabular>{secs(first, last)}</Text>
          </Box>
          <Text size="footnote" color="subtle">
            {members.length} agent · {live > 0 ? `${live} đang chạy` : 'xong hết'} · {models.join(', ')}
          </Text>
          {expanded && <Box flexDirection="column">{ordered.map(agentView)}</Box>}
        </Box>
      )
    }

    // agentId undefined: the top level of turn turnId.
    function steps(turnId: string | undefined, agentId: string | undefined): RenderChildren[] {
      type Item = { at: number; agent?: MapAgent; call?: MapCall; runId?: string }
      const own = g.agents.filter(a => a.parentId === agentId && (agentId !== undefined || a.turnId === turnId))
      const runs = new Map<string, MapAgent[]>()
      for (const a of own) {
        if (a.workflowRunId !== undefined) {
          runs.set(a.workflowRunId, [...(runs.get(a.workflowRunId) ?? []), a])
        }
      }
      const items: Item[] = [
        ...own.filter(a => a.workflowRunId === undefined).map(a => ({ at: a.startedAt, agent: a })),
        ...[...runs.entries()].map(([runId, list]) => ({ at: Math.min(...list.map(a => a.startedAt)), runId })),
        ...g.calls
          .filter(c => c.agentId === agentId && (agentId !== undefined || c.turnId === turnId))
          .map(c => ({ at: c.startedAt, call: c })),
      ].sort((x, y) => x.at - y.at)
      if (items.length === 0) return [<Text color="subtle" italic>Chưa có bước nào</Text>]
      return items.map(it => {
        if (it.call) return callView(it.call)
        if (it.runId !== undefined) return workflowView(it.runId, runs.get(it.runId) ?? [])
        return agentView(it.agent as MapAgent)
      })
    }

    const turnView = (t: MapTurn) => {
      const key = `t:${t.id}`
      const isLatest = t.id === latest?.id
      const expanded = isOpen(key, isLatest)
      const running = isLatest && g.mainBusy
      const allCalls = g.calls.filter(c => c.turnId === t.id)
      const ownCalls = allCalls.filter(c => c.agentId === undefined)
      const agents = g.agents.filter(a => a.turnId === t.id)
      const subAgents = agents.filter(a => a.workflowRunId === undefined)
      const runs = new Set(agents.flatMap(a => (a.workflowRunId === undefined ? [] : [a.workflowRunId])))
      const live = allCalls.filter(c => !c.isDone).length + agents.filter(a => !a.isDone).length
      const errors = allCalls.filter(c => c.isError).length
      const models = [...new Set(agents.map(a => shortModel(a.model)))]
      const meta = [
        running ? 'Đang làm' : 'Xong',
        `${ownCalls.length} bước`,
        subAgents.length > 0 ? `${subAgents.length} sub agent` : '',
        runs.size > 0 ? `${runs.size} workflow` : '',
        models.length > 0 ? models.join(', ') : '',
        errors > 0 ? `${errors} lỗi` : '',
        secs(t.startedAt, t.endedAt ?? now),
      ].filter(s => s.length > 0).join(' · ')
      return (
        <Box
          key={key}
          flexDirection="column"
          gap="xs"
          borderStyle="round"
          borderColor={running || live > 0 ? 'warning' : isLatest ? 'claude' : 'inactive'}
          padding="md"
        >
          <Box flexDirection="row" gap="sm" alignItems="center">
            <Text size="footnote" weight="bold" color="inverseText" backgroundColor={isLatest ? 'claude' : 'inactive'}>{` #${t.index} `}</Text>
            <Box flexGrow={1} flexShrink={1} overflow="hidden">
              <Button key={key} plain onPress={() => toggle($, key, !expanded)}>
                <Text color="subtle">{expanded ? '▾ ' : '▸ '}</Text>
                <Text weight="semibold" wrap="truncate-end">{short(t.text, maxTitle)}</Text>
              </Button>
            </Box>
          </Box>
          <Text size="footnote" color={errors > 0 ? 'error' : 'subtle'}>{meta}</Text>
          {expanded && (
            <Box flexDirection="column" marginTop="sm">
              {steps(t.id, undefined)}
            </Box>
          )}
        </Box>
      )
    }

    const liveTotal = g.calls.filter(c => !c.isDone).length + g.agents.filter(a => !a.isDone).length
    const allKeys = g.turns.map(t => `t:${t.id}`)

    return (
      <Box flexDirection="column" gap="md" padding="sm">
        <Box flexDirection="column" gap="xs">
          <Box flexDirection="row" justifyContent="space-between" alignItems="center">
            <Text size="title" weight="bold">Session chính</Text>
            <Text weight="semibold" color={g.mainBusy ? 'warning' : 'success'}>{g.mainBusy ? '● Đang làm việc' : '● Đang chờ'}</Text>
          </Box>
          <Box flexDirection="row" gap="sm" alignItems="center">
            {g.mainModel.length > 0 && (
              <Text weight="semibold" color="inverseText" backgroundColor="claude">{` ${shortModel(g.mainModel)} `}</Text>
            )}
            <Text color="subtle">{liveTotal} nhánh đang chạy · {g.turns.length} tin nhắn</Text>
          </Box>
          <Box flexDirection="row" gap="sm">
            <Button key="open-all" variant="secondary" onPress={() => setAll($, allKeys, true)}>Mở hết</Button>
            <Button key="close-all" variant="secondary" onPress={() => setAll($, allKeys, false)}>Thu gọn hết</Button>
          </Box>
        </Box>
        {g.turns.length === 0
          ? <Text color="subtle" italic>Chưa có tin nhắn nào kể từ khi mở sơ đồ.</Text>
          : g.turns.map(turnView)}
      </Box>
    )
  })
}
