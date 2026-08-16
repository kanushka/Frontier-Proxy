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
  avgElapsedMs?: number
}

export interface EfficiencyBaselines {
  avgTokens?: number
  avgElapsedMs?: number
}

function tokensForDay(day: UsageDay): number {
  const reported = day.inputTokens + day.outputTokens
  return reported || day.estimatedInputTokens + day.estimatedOutputTokens
}

export function usageEvidence(runtime: ProviderRuntime): UsageEvidence | undefined {
  const days = [...(runtime.history ?? []), runtime.usage].filter((day) => day.tasks > 0)
  const tasks = days.reduce((sum, day) => sum + day.tasks, 0)
  if (tasks < MIN_EFFICIENCY_TASKS) return undefined

  const tokens = days.reduce((sum, day) => sum + tokensForDay(day), 0)
  const elapsedMs = days.reduce((sum, day) => sum + day.elapsedMs, 0)
  return {
    tasks,
    avgTokens: tokens > 0 ? tokens / tasks : undefined,
    avgElapsedMs: elapsedMs > 0 ? elapsedMs / tasks : undefined
  }
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined
  const ordered = [...values].sort((left, right) => left - right)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2
}

export function efficiencyBaselines(runtimes: ProviderRuntime[]): EfficiencyBaselines {
  const evidence = runtimes.map(usageEvidence).filter((item): item is UsageEvidence => Boolean(item))
  return {
    avgTokens: median(evidence.flatMap((item) => item.avgTokens === undefined ? [] : [item.avgTokens])),
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
  const tokenPoints = relativePoints(evidence.avgTokens, baselines.avgTokens, MAX_TOKEN_EFFICIENCY_POINTS)
  const latencyPoints = relativePoints(evidence.avgElapsedMs, baselines.avgElapsedMs, MAX_LATENCY_EFFICIENCY_POINTS)
  if (tokenPoints) factors.push({ label: `Token efficiency (${evidence.tasks} tasks)`, points: tokenPoints })
  if (latencyPoints) factors.push({ label: `Latency efficiency (${evidence.tasks} tasks)`, points: latencyPoints })
  return factors
}
