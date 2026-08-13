import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checksFromMakefile, checksFromPackageJson, detectChecks, detectPackageManager, parseCommandLine, verifyWorktree } from '../src/main/verify'

async function directory(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'frontier-verify-'))
  for (const [name, contents] of Object.entries(files)) await writeFile(join(dir, name), contents)
  return dir
}

describe('check detection', () => {
  it('picks the package manager from the lockfile present', () => {
    expect(detectPackageManager(['pnpm-lock.yaml'])).toBe('pnpm')
    expect(detectPackageManager(['yarn.lock'])).toBe('yarn')
    expect(detectPackageManager(['bun.lockb'])).toBe('bun')
    expect(detectPackageManager([])).toBe('npm')
  })

  it('offers only the scripts a project actually defines', () => {
    const raw = JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' } })
    expect(checksFromPackageJson(raw, 'pnpm')).toEqual([
      { name: 'typecheck', command: 'pnpm', args: ['run', 'typecheck'] },
      { name: 'test', command: 'pnpm', args: ['run', 'test'] }
    ])
  })

  it('never runs build, start, or any other script that is not a check', () => {
    const raw = JSON.stringify({ scripts: { build: 'vite build', start: 'node .', dev: 'vite', deploy: './ship.sh' } })
    expect(checksFromPackageJson(raw, 'npm')).toEqual([])
  })

  it('ignores a malformed package.json instead of throwing', () => {
    expect(checksFromPackageJson('{ not json', 'npm')).toEqual([])
  })

  it('reads Makefile targets only where they are defined', () => {
    expect(checksFromMakefile('test:\n\tgo test ./...\n')).toEqual([{ name: 'test', command: 'make', args: ['test'] }])
    // A target named inside a recipe or comment is not a definition.
    expect(checksFromMakefile('build:\n\t@echo "run make test first"\n')).toEqual([])
  })

  it('prefers package.json, then Makefile, then the language toolchains', async () => {
    expect(await detectChecks(await directory({ 'Cargo.toml': '[package]\nname="x"\n' })))
      .toEqual([{ name: 'test', command: 'cargo', args: ['test'] }])
    expect(await detectChecks(await directory({ 'go.mod': 'module x\n' })))
      .toEqual([{ name: 'test', command: 'go', args: ['test', './...'] }])
    // A package.json with no check scripts falls through to the Makefile.
    const mixed = await directory({ 'package.json': JSON.stringify({ scripts: { build: 'x' } }), Makefile: 'lint:\n\techo ok\n' })
    expect(await detectChecks(mixed)).toEqual([{ name: 'lint', command: 'make', args: ['lint'] }])
  })

  it('reports nothing detectable for a project with no manifest', async () => {
    expect(await detectChecks(await directory({ 'README.md': '# hi' }))).toEqual([])
  })
})

describe('command lines', () => {
  it('splits an argv without invoking a shell', () => {
    expect(parseCommandLine('pnpm run test --silent')).toEqual({ name: 'pnpm', command: 'pnpm', args: ['run', 'test', '--silent'] })
  })

  it('keeps a quoted argument together', () => {
    expect(parseCommandLine('npx vitest "tests/a b.test.ts"')).toEqual({ name: 'npx', command: 'npx', args: ['vitest', 'tests/a b.test.ts'] })
  })

  it('returns nothing for a blank line', () => {
    expect(parseCommandLine('   ')).toBeUndefined()
  })
})

describe('verifying a worktree', () => {
  it('runs the configured commands and passes when they all exit zero', async () => {
    const dir = await directory({})
    const report = await verifyWorktree(dir, { enabled: true, commands: ['node --eval process.exit(0)'], timeoutSeconds: 60 })
    expect(report?.ran).toBe(true)
    expect(report?.ok).toBe(true)
    expect(report?.checks).toHaveLength(1)
  })

  it('fails the report and keeps the output when a check exits non-zero', async () => {
    const dir = await directory({})
    const report = await verifyWorktree(dir, { enabled: true, commands: ['node --eval console.error("boom");process.exit(3)'], timeoutSeconds: 60 })
    expect(report?.ok).toBe(false)
    expect(report?.checks[0].exitCode).toBe(3)
    expect(report?.checks[0].output).toContain('boom')
  })

  it('runs the project\'s own detected script when no command is configured', async () => {
    const dir = await directory({
      'package.json': JSON.stringify({ scripts: { test: 'node --eval process.exit(0)' } })
    })
    const report = await verifyWorktree(dir, { enabled: true, commands: [], timeoutSeconds: 120 })
    expect(report?.checks.map((check) => check.name)).toEqual(['test'])
  })

  // "nothing to run" must never read as "everything passed": a branch nobody
  // checked is not a verified branch.
  it('reports ran=false, ok=false when a project has no checks', async () => {
    const report = await verifyWorktree(await directory({ 'README.md': '# hi' }), { enabled: true, commands: [], timeoutSeconds: 60 })
    expect(report).toEqual({ ran: false, ok: false, checks: [], at: expect.any(String) })
  })

  it('returns nothing at all when verification is turned off', async () => {
    expect(await verifyWorktree(await directory({}), { enabled: false, commands: ['node -e 0'], timeoutSeconds: 60 })).toBeUndefined()
  })

  it('runs the command in the worktree, not the app\'s directory', async () => {
    const dir = await directory({ 'marker.txt': 'here' })
    await chmod(dir, 0o755)
    const report = await verifyWorktree(dir, { enabled: true, commands: ['node --eval require("fs").statSync("marker.txt")'], timeoutSeconds: 60 })
    expect(report?.ok).toBe(true)
  })

  it('stops early when the run is aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const report = await verifyWorktree(await directory({}), { enabled: true, commands: ['node --eval process.exit(0)'], timeoutSeconds: 60, signal: controller.signal })
    expect(report?.ran).toBe(false)
    expect(report?.checks).toEqual([])
  })
})

describe('quoting in a configured command', () => {
  // A --eval script must keep its own string literals; only quotes wrapping a
  // whole argument are shell-style grouping and get removed.
  it('keeps quotes that are part of an argument', () => {
    expect(parseCommandLine('node --eval console.error("suite failed");process.exit(1)')?.args)
      .toEqual(['--eval', 'console.error("suite failed");process.exit(1)'])
  })
})
