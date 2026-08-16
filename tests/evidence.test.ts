import { describe, expect, it } from 'vitest'
import { efficiencyBaselines, efficiencyFactors, usageEvidence } from '../src/main/evidence'
import type { ProviderRuntime, UsageDay } from '../src/shared/types'

function day(tasks: number, tokens: number, elapsedMs: number, date = '2026-08-16'): UsageDay {
  return {
    date, tasks,
    estimatedInputTokens: tokens,
    estimatedOutputTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    elapsedMs
  }
}

function runtime(current: UsageDay, history: UsageDay[] = []): ProviderRuntime {
  return { available: true, running: 0, usage: current, history }
}

describe('routing efficiency evidence', () => {
  it('waits for a minimum amount of history before influencing routing', () => {
    expect(usageEvidence(runtime(day(2, 2_000, 20_000)))).toBeUndefined()
  })

  it('aggregates finished days with today and prefers reported token counts', () => {
    const yesterday = day(2, 8_000, 20_000, '2026-08-15')
    yesterday.inputTokens = 2_000
    yesterday.outputTokens = 2_000
    const evidence = usageEvidence(runtime(day(2, 4_000, 12_000), [yesterday]))
    expect(evidence).toEqual({ tasks: 4, avgTokens: 2_000, avgElapsedMs: 8_000 })
  })

  it('rewards providers that use fewer tokens and less wall time than peers', () => {
    const fast = runtime(day(4, 4_000, 20_000))
    const slow = runtime(day(4, 16_000, 80_000))
    const baselines = efficiencyBaselines([fast, slow])
    const fastFactors = efficiencyFactors(fast, baselines)
    const slowFactors = efficiencyFactors(slow, baselines)

    expect(fastFactors.find((factor) => factor.label.startsWith('Token efficiency'))?.points).toBeGreaterThan(0)
    expect(fastFactors.find((factor) => factor.label.startsWith('Latency efficiency'))?.points).toBeGreaterThan(0)
    expect(slowFactors.find((factor) => factor.label.startsWith('Token efficiency'))?.points).toBeLessThan(0)
    expect(slowFactors.find((factor) => factor.label.startsWith('Latency efficiency'))?.points).toBeLessThan(0)
  })

  it('keeps efficiency influence bounded', () => {
    const tiny = runtime(day(10, 100, 100))
    const huge = runtime(day(10, 1_000_000, 1_000_000))
    const factors = [
      ...efficiencyFactors(tiny, efficiencyBaselines([tiny, huge])),
      ...efficiencyFactors(huge, efficiencyBaselines([tiny, huge]))
    ]
    expect(factors.every((factor) => Math.abs(factor.points) <= 6)).toBe(true)
  })
})
