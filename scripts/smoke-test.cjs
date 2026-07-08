// Smoke test: spawns the built server over stdio, runs brain_scan_projects
// and brain_status, and prints the responses.
// Usage: node scripts/smoke-test.cjs   (run `npm run build` first)
const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const proc = spawn('node', ['dist/index.js'], {
  cwd: ROOT,
  env: { ...process.env }, // BRAIN_CODE_DIR / BRAIN_DB are picked up if set
  stdio: ['pipe', 'pipe', 'pipe']
});

let buf = '';
proc.stdout.on('data', d => { buf += d.toString(); });
proc.stderr.on('data', () => {});

const send = (msg) => proc.stdin.write(JSON.stringify(msg) + '\n');

// Initialize
send({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke-test', version: '1.0' } }
});

setTimeout(() => {
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'brain_scan_projects', arguments: {} } });
}, 500);

setTimeout(() => {
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'brain_status', arguments: {} } });
}, 3000);

setTimeout(() => {
  const lines = buf.split('\n').filter(l => l.trim());
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.id === 2 || parsed.id === 3) {
        console.log('\n=== Response ID ' + parsed.id + ' ===');
        if (parsed.result && parsed.result.content) {
          for (const c of parsed.result.content) console.log(c.text);
        }
      }
    } catch (e) {}
  }
  proc.kill();
  process.exit(0);
}, 5000);
