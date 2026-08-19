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
    // Wall time spans every day; tokens average only over the days that reported.
    expect(evidence).toEqual({ tasks: 4, avgTokens: 2_000, tokensReported: true, avgElapsedMs: 8_000 })
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

  // Claude and Codex stream real usage events; Copilot and Ollama stream none, so
  // the engine falls back to estimating the prompt and the final text. Identical
  // work therefore lands orders of magnitude apart, and comparing the two would
  // score telemetry rather than efficiency — penalising exactly the CLIs that
  // report honestly.
  it('never ranks a CLI that reports real tokens against one that only estimates', () => {
    const reports = runtime(day(10, 20_000, 900_000))
    reports.usage.inputTokens = 1_800_000
    reports.usage.outputTokens = 60_000
    const estimatesOnly = runtime(day(10, 20_000, 900_000))

    const baselines = efficiencyBaselines([reports, estimatesOnly])
    const token = (rt: typeof reports) => efficiencyFactors(rt, baselines).find((factor) => factor.label.startsWith('Token efficiency'))
    expect(token(reports)).toBeUndefined()
    expect(token(estimatesOnly)).toBeUndefined()
  })

  it('still compares reported tokens against other reporting peers', () => {
    const lean = runtime(day(10, 0, 900_000))
    lean.usage.inputTokens = 200_000
    const heavy = runtime(day(10, 0, 900_000))
    heavy.usage.inputTokens = 2_000_000
    const estimatesOnly = runtime(day(10, 20_000, 900_000))

    const baselines = efficiencyBaselines([lean, heavy, estimatesOnly])
    const token = (rt: typeof lean) => efficiencyFactors(rt, baselines).find((factor) => factor.label.startsWith('Token efficiency'))?.points
    expect(token(lean)).toBeGreaterThan(0)
    expect(token(heavy)).toBeLessThan(0)
  })

  // Wall time is measured by the engine for every run, so it stays comparable
  // across CLIs that report nothing at all.
  it('still compares wall time across CLIs that report no tokens', () => {
    const quick = runtime(day(10, 20_000, 200_000))
    quick.usage.inputTokens = 500_000
    const slow = runtime(day(10, 20_000, 2_000_000))

    const baselines = efficiencyBaselines([quick, slow])
    const latency = (rt: typeof quick) => efficiencyFactors(rt, baselines).find((factor) => factor.label.startsWith('Latency efficiency'))?.points
    expect(latency(quick)).toBeGreaterThan(0)
    expect(latency(slow)).toBeLessThan(0)
  })
})
