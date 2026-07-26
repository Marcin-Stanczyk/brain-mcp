#!/usr/bin/env node
/**
 * Prints the setup reminder after `npm install`. Nothing else.
 *
 * This is a file rather than an inline `node -e "..."` in package.json on
 * purpose. npm runs script strings through a shell, and the first version of
 * this notice wrapped command names in backticks for readability:
 *
 *   node -e "console.log('run `npm run setup` to ...')"
 *
 * The shell treated those backticks as command substitution. It actually RAN
 * `npm run setup` (installing the hooks — the exact thing this package promises
 * not to do automatically), then ran `npm run hooks:uninstall`, then handed node
 * the substituted output, which contained `brain-mcp@1.1.0` and died with
 * "Expected ',', got '@'".
 *
 * A separate file has no shell-quoting surface at all.
 */
const lines = [
  '',
  'brain-mcp installed.',
  '',
  '  npm run setup            build + register the SessionStart/Stop hooks',
  '  npm run hooks:status     show what is registered (writes nothing)',
  '  npm run hooks:uninstall  remove them again',
  '',
  'The hooks are what close the learning loop — see "Recommended setup" in the README.',
  '',
];
console.log(lines.join('\n'));
