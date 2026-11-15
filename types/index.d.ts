export type MapTurn = {
  id: string
  index: number
  text: string
  startedAt: number
  endedAt?: number
}
export type MapAgent = {
  id: string
  turnId: string
  parentId?: string
  kind: string
  label: string
  prompt: string
  model: string
  workflowRunId?: string
  workflowIndex?: number
  isDone: boolean
  startedAt: number
  endedAt?: number
}
/** One labelled block of a step's details; format 'diff' draws a unified diff. */
export type MapSection = {
  title: string
  body: string
  language?: string
  format?: 'source' | 'diff'
}
export type MapCall = {
  id: string
  turnId: string
  agentId?: string
  tool: string
  title: string
  summary: string
  sections: MapSection[]
  isDone: boolean
  isError: boolean
  startedAt: number
  endedAt?: number
}
export type MapGraph = {
  mainModel: string
  mainBusy: boolean
  pendingText: string
  turns: MapTurn[]
  agents: MapAgent[]
  calls: MapCall[]
}
/** Hand toggles only: a key left out follows the running/latest default. */
export type MapOpen = Record<string, boolean>

declare module 'claude-code' {
  interface PluginState {
    'agent-map': { graph: Shaped<MapGraph>; open: Shaped<MapOpen>; tick: number }
  }
}
