import type { ProviderRuntime, RoutingFactor, UsageDay } from '../shared/types'

// Efficiency is deliberately a weak routing signal. It only appears after a few
// finished runs and is always measured relative to the other eligible agents,
// so a fast/cheap agent is rewarded for this decision without turning Frontier
// into a global leaderboard of incomparable workloads.
export const MIN_EFFICIENCY_TASKS = 3
const MAX_TOKEN_EFFICIENCY_POINTS = 6
const MAX_LATENCY_EFFICIENCY_POINTS = 5

export interface UsageEvidence {
  tasks: number
  avgTokens?: number
  // Which measurement `avgTokens` came from. Reported and estimated counts are
  // different units, so this decides which peer group it may be compared with.
  tokensReported: boolean
  avgElapsedMs?: number
}

export interface EfficiencyBaselines {
  reportedTokens?: number
  estimatedTokens?: number
  avgElapsedMs?: number
}

function reportedTokens(day: UsageDay): number {
  return day.inputTokens + day.outputTokens
}

function estimatedTokens(day: UsageDay): number {
  return day.estimatedInputTokens + day.estimatedOutputTokens
}

// Only the CLIs that stream usage events (Claude, Codex) report real tokens; the
// rest leave Frontier's own estimate, which counts the prompt and the final text
// and nothing else — no cache reads, no tool results, no intermediate turns. The
// two land orders of magnitude apart for identical work, so a provider's tokens
// are averaged over the days measured the same way and never mixed.
export function usageEvidence(runtime: ProviderRuntime): UsageEvidence | undefined {
  const days = [...(runtime.history ?? []), runtime.usage].filter((day) => day.tasks > 0)
  const tasks = days.reduce((sum, day) => sum + day.tasks, 0)
  if (tasks < MIN_EFFICIENCY_TASKS) return undefined

  const reported = days.filter((day) => reportedTokens(day) > 0)
  const measured = reported.length ? reported : days
  const tokensFor = reported.length ? reportedTokens : estimatedTokens
  const measuredTasks = measured.reduce((sum, day) => sum + day.tasks, 0)
  const tokens = measured.reduce((sum, day) => sum + tokensFor(day), 0)
  const elapsedMs = days.reduce((sum, day) => sum + day.elapsedMs, 0)
  return {
    tasks,
    avgTokens: tokens > 0 && measuredTasks > 0 ? tokens / measuredTasks : undefined,
    tokensReported: reported.length > 0,
    avgElapsedMs: elapsedMs > 0 ? elapsedMs / tasks : undefined
  }
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2
}

// Two token baselines, one per measurement, so a CLI is only ever ranked against
// peers measured the same way. Wall time is recorded by the engine for every run,
// so it needs no such split.
export function efficiencyBaselines(runtimes: ProviderRuntime[]): EfficiencyBaselines {
  const evidence = runtimes.map(usageEvidence).filter((item): item is UsageEvidence => Boolean(item))
  const tokensMeasured = (reported: boolean) =>
    median(evidence.flatMap((item) => item.avgTokens !== undefined && item.tokensReported === reported ? [item.avgTokens] : []))
  return {
    reportedTokens: tokensMeasured(true),
    estimatedTokens: tokensMeasured(false),
    avgElapsedMs: median(evidence.flatMap((item) => item.avgElapsedMs === undefined ? [] : [item.avgElapsedMs]))
  }
}

function relativePoints(value: number | undefined, baseline: number | undefined, maximum: number): number {
  if (!value || !baseline) return 0
  const points = Math.round((1 - value / baseline) * maximum)
  return Math.max(-maximum, Math.min(maximum, points))
}

export function efficiencyFactors(runtime: ProviderRuntime, baselines: EfficiencyBaselines): RoutingFactor[] {
  const evidence = usageEvidence(runtime)
  if (!evidence) return []

  const factors: RoutingFactor[] = []
  // A provider with nobody comparable to measure against scores nothing here —
  // an unmeasured cost is not a low one.
  const tokenBaseline = evidence.tokensReported ? baselines.reportedTokens : baselines.estimatedTokens
  const tokenPoints = relativePoints(evidence.avgTokens, tokenBaseline, MAX_TOKEN_EFFICIENCY_POINTS)
  const latencyPoints = relativePoints(evidence.avgElapsedMs, baselines.avgElapsedMs, MAX_LATENCY_EFFICIENCY_POINTS)
  if (tokenPoints) factors.push({ label: `Token efficiency (${evidence.tasks} tasks)`, points: tokenPoints })
  if (latencyPoints) factors.push({ label: `Latency efficiency (${evidence.tasks} tasks)`, points: latencyPoints })
  return factors
}
