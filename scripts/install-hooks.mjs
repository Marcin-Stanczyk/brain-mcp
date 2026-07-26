#!/usr/bin/env node
/**
 * Register (or remove) the brain-mcp lifecycle hooks in Claude Code settings.
 *
 *   node scripts/install-hooks.mjs            # install, user scope
 *   node scripts/install-hooks.mjs --project  # install into ./.claude/settings.json
 *   node scripts/install-hooks.mjs --uninstall
 *   node scripts/install-hooks.mjs --dry-run
 *
 * What it does:
 *   SessionStart -> hooks/session_context.py   inject this project's lessons
 *   Stop         -> hooks/capture_lesson.py    ask for a lesson if none written
 *
 * Design notes:
 *   - MERGES into existing hooks. Your other SessionStart/Stop hooks are kept.
 *   - Ours are identified by the absolute path to this repo's hooks/ directory,
 *     so --uninstall removes exactly our entries and never touches anyone else's.
 *   - Idempotent: re-running replaces our own stale entries (e.g. after moving
 *     the repo) rather than stacking duplicates.
 *   - Backs up settings.json before the first modification.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS_DIR = join(REPO, 'hooks');

const HOOKS = [
  { event: 'SessionStart', file: 'session_context.py', timeout: 10 },
  { event: 'Stop', file: 'capture_lesson.py', timeout: 10 },
  // Catch mistakes as they happen, not at session end. Scoped to Bash: the
  // signals are shell-level (an undo command ran, a command kept failing).
  { event: 'PostToolUse', file: 'incident_watch.py', timeout: 5, matcher: 'Bash' },
  { event: 'PostToolUseFailure', file: 'incident_watch.py', timeout: 5, matcher: 'Bash' },
];

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const UNINSTALL = has('--uninstall') || has('--remove');
const DRY = has('--dry-run');
const PROJECT = has('--project');

const settingsPath = PROJECT
  ? join(process.cwd(), '.claude', 'settings.json')
  : join(homedir(), '.claude', 'settings.json');

const log = (...a) => console.log(...a);

function pythonBin() {
  for (const bin of ['python3', 'python']) {
    try {
      execSync(`${bin} --version`, { stdio: 'ignore' });
      return bin;
    } catch { /* try next */ }
  }
  return null;
}

function readSettings() {
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    console.error(`✗ ${settingsPath} is not valid JSON — refusing to touch it.`);
    console.error(`  Fix or move it, then re-run. (${e.message})`);
    process.exit(1);
  }
}

/** True if this hook entry is one of ours (points into this repo's hooks dir). */
const isOurs = (entry) =>
  typeof entry?.command === 'string' && entry.command.includes(HOOKS_DIR);

function main() {
  const py = pythonBin();
  if (!py && !UNINSTALL) {
    console.error('✗ No python3 found on PATH. The hooks are Python scripts.');
    process.exit(1);
  }

  for (const h of HOOKS) {
    const p = join(HOOKS_DIR, h.file);
    if (!existsSync(p)) {
      console.error(`✗ Missing hook script: ${p}`);
      process.exit(1);
    }
    if (!DRY) { try { chmodSync(p, 0o755); } catch { /* non-fatal */ } }
  }

  const settings = readSettings();
  const hooks = settings.hooks ?? {};
  let changed = 0;

  for (const h of HOOKS) {
    const groups = Array.isArray(hooks[h.event]) ? hooks[h.event] : [];

    // Strip our own previous entries; keep every foreign one untouched.
    const kept = [];
    let removed = 0;
    for (const g of groups) {
      const inner = Array.isArray(g?.hooks) ? g.hooks : [];
      const foreign = inner.filter((e) => !isOurs(e));
      removed += inner.length - foreign.length;
      if (foreign.length) kept.push({ ...g, hooks: foreign });
      else if (!inner.length) kept.push(g); // preserve unrelated shapes
    }
    if (removed) changed += removed;

    if (!UNINSTALL) {
      const group = {
        hooks: [{
          type: 'command',
          command: `${py} ${JSON.stringify(join(HOOKS_DIR, h.file))}`,
          timeout: h.timeout,
        }],
      };
      if (h.matcher) group.matcher = h.matcher;
      kept.push(group);
      changed += 1;
    }

    if (kept.length) hooks[h.event] = kept;
    else delete hooks[h.event];

    const n = (hooks[h.event] ?? []).length;
    log(`  ${UNINSTALL ? 'removed' : 'registered'}  ${h.event.padEnd(13)} ` +
        `${UNINSTALL ? `(${removed} of ours)` : h.file}` +
        (n ? `  [${n} group(s) on this event]` : ''));
  }

  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;

  if (DRY) {
    log(`\n[dry-run] would write ${settingsPath}`);
    log(JSON.stringify({ hooks: settings.hooks ?? null }, null, 2));
    return;
  }

  if (!changed) {
    log('\nNothing to change.');
    return;
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  if (existsSync(settingsPath)) {
    const bak = `${settingsPath}.bak-brain-mcp`;
    if (!existsSync(bak)) {
      copyFileSync(settingsPath, bak);
      log(`\n  backup      ${bak}`);
    }
  }
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  log(`  wrote       ${settingsPath}`);

  if (UNINSTALL) {
    log('\nHooks removed. Session state markers under ' +
        '~/.claude/hooks/brain/state/ are harmless and expire after 7 days;');
    log('delete that directory if you want a clean sweep. Your knowledge ' +
        'database was NOT touched.');
  } else {
    log('\nDone. Restart Claude Code (or start a new session) to activate.');
    log('Verify with:  node scripts/install-hooks.mjs --dry-run');
  }
}

main();
