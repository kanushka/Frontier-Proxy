import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { VerificationCheck, VerificationReport, VerificationResult } from '../shared/types'

// Verification runs a repo's *own* checks against an isolated worktree once its
// agent has finished, so the Review inbox can say whether a branch is safe to
// merge instead of only what it changed. Frontier never invents a command: every
// check is either detected from a manifest the project already has, or typed by
// the user. Commands are spawned with `shell: false` like every other process
// this app starts.

const MAX_OUTPUT = 4_000
const SCRIPT_CHECKS = ['typecheck', 'lint', 'test'] as const

export type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm'

// Lockfile → package manager. Checked in this order because a repo migrating
// between managers can carry two lockfiles; the more specific ones win.
export function detectPackageManager(files: string[]): PackageManager {
  if (files.includes('pnpm-lock.yaml')) return 'pnpm'
  if (files.includes('yarn.lock')) return 'yarn'
  if (files.includes('bun.lockb') || files.includes('bun.lock')) return 'bun'
  return 'npm'
}

// Only scripts the project actually defines are offered, and only the three that
// mean "is this change sound" — never `build`, `start`, `dev`, or anything that
// could serve traffic or publish.
export function checksFromPackageJson(raw: string, manager: PackageManager): VerificationCheck[] {
  let parsed: { scripts?: Record<string, unknown> }
  try { parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> } } catch { return [] }
  const scripts = parsed.scripts ?? {}
  return SCRIPT_CHECKS
    .filter((name) => typeof scripts[name] === 'string' && (scripts[name] as string).trim())
    .map((name) => ({ name, command: manager, args: manager === 'npm' ? ['run', name, '--silent'] : ['run', name] }))
}

// Makefile targets are matched at the start of a line so a target named in a
// recipe or a comment is not mistaken for a definition.
export function checksFromMakefile(raw: string): VerificationCheck[] {
  return SCRIPT_CHECKS
    .filter((name) => new RegExp(`^${name}:`, 'm').test(raw))
    .map((name) => ({ name, command: 'make', args: [name] }))
}

// A user-typed command line, split on whitespace outside quotes. Kept
// deliberately simple: this is an argv builder, not a shell — no expansion, no
// pipes, no substitution, because nothing here ever reaches a shell. Quotes that
// wrap a whole argument are removed; quotes inside one are left alone, so a
// `--eval` script keeps the string literals it needs.
export function parseCommandLine(line: string): VerificationCheck | undefined {
  const parts = (line.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [])
    .map((part) => /^"[^"]*"$/.test(part) || /^'[^']*'$/.test(part) ? part.slice(1, -1) : part)
  if (!parts.length) return undefined
  return { name: parts[0], command: parts[0], args: parts.slice(1) }
}

async function exists(dir: string, name: string): Promise<boolean> {
  try { await stat(join(dir, name)); return true } catch { return false }
}

async function read(dir: string, name: string): Promise<string | undefined> {
  try { return await readFile(join(dir, name), 'utf8') } catch { return undefined }
}

// What this project knows how to check itself. Node manifests first (the common
// case), then the language toolchains whose check command is unambiguous.
export async function detectChecks(cwd: string): Promise<VerificationCheck[]> {
  const present = await Promise.all(
    ['pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock'].map(async (name) => (await exists(cwd, name)) ? name : '')
  )
  const packageJson = await read(cwd, 'package.json')
  if (packageJson) {
    const checks = checksFromPackageJson(packageJson, detectPackageManager(present.filter(Boolean)))
    if (checks.length) return checks
  }
  const makefile = await read(cwd, 'Makefile')
  if (makefile) {
    const checks = checksFromMakefile(makefile)
    if (checks.length) return checks
  }
  if (await exists(cwd, 'Cargo.toml')) return [{ name: 'test', command: 'cargo', args: ['test'] }]
  if (await exists(cwd, 'go.mod')) return [{ name: 'test', command: 'go', args: ['test', './...'] }]
  return []
}

function tail(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > MAX_OUTPUT ? `…\n${trimmed.slice(-MAX_OUTPUT)}` : trimmed
}

export function runCheck(cwd: string, check: VerificationCheck, timeoutMs: number, signal?: AbortSignal): Promise<VerificationResult> {
  const started = Date.now()
  const display = [check.command, ...check.args].join(' ')
  return new Promise((resolve) => {
    const child = execFile(check.command, check.args, { cwd, timeout: timeoutMs, maxBuffer: 8_000_000, windowsHide: true, shell: false, signal },
      (error, stdout, stderr) => {
        const output = tail(`${stdout ?? ''}${stderr ?? ''}`)
        const code = typeof child.exitCode === 'number' ? child.exitCode : undefined
        // `killed` with no exit code is the timeout (or an abort) rather than a
        // failing check — reporting it as a plain failure would blame the agent.
        const timedOut = Boolean(error && (error as NodeJS.ErrnoException).code === 'ABORT_ERR') || (Boolean(child.killed) && code === null)
        resolve({
          name: check.name,
          command: display,
          ok: !error,
          exitCode: code ?? undefined,
          durationMs: Date.now() - started,
          output: output || (error ? String(error.message) : ''),
          timedOut: timedOut || undefined
        })
      })
  })
}

export interface VerifyOptions {
  enabled: boolean
  commands: string[]
  timeoutSeconds: number
  signal?: AbortSignal
}

// Run every check for one isolated worktree. Checks run in sequence: they are
// the project's own tests, and several agents' lanes are already verifying in
// parallel, so running a repo's suite twice over inside one lane helps nobody.
export async function verifyWorktree(cwd: string, options: VerifyOptions): Promise<VerificationReport | undefined> {
  if (!options.enabled) return undefined
  const configured = options.commands.map((line) => parseCommandLine(line)).filter((check): check is VerificationCheck => Boolean(check))
  const checks = configured.length ? configured : await detectChecks(cwd)
  const at = new Date().toISOString()
  if (!checks.length) return { ran: false, ok: false, checks: [], at }

  const results: VerificationResult[] = []
  const timeoutMs = Math.max(10, options.timeoutSeconds) * 1_000
  for (const check of checks) {
    if (options.signal?.aborted) break
    results.push(await runCheck(cwd, check, timeoutMs, options.signal))
  }
  return { ran: results.length > 0, ok: results.length > 0 && results.every((result) => result.ok), checks: results, at }
}
