import { runCheck } from '../src/modules/checks/runCheck.js';

const [url, timeoutArg] = process.argv.slice(2);
if (!url) {
  console.error('Usage: npm run check:url -- <url> [timeoutMs]');
  process.exit(1);
}

const result = await runCheck({
  id: 'cli',
  url,
  timeoutMs: Number(timeoutArg ?? 10000),
  expectedStatusMin: 200,
  expectedStatusMax: 299,
});

console.log(JSON.stringify(result, null, 2));
process.exitCode = result.success ? 0 : 1; // exitCode (not exit()) lets logs flush