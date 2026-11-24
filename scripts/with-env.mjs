#!/usr/bin/env node
// Runs a command with extra environment variables, on every platform:
//   node scripts/with-env.mjs KEY=value OTHER=value -- command arg...
// Use it in package.json scripts in place of the POSIX `KEY=value command` form.
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const split = args.indexOf('--');
if (split <= 0 || split === args.length - 1) {
  console.error('Usage: node scripts/with-env.mjs KEY=value ... -- command [args...]');
  process.exit(2);
}

const env = { ...process.env };
for (const pair of args.slice(0, split)) {
  const eq = pair.indexOf('=');
  if (eq <= 0) {
    console.error(`Not a KEY=value pair: ${pair}`);
    process.exit(2);
  }
  env[pair.slice(0, eq)] = pair.slice(eq + 1);
}

const [command, ...rest] = args.slice(split + 1);
// `shell` on Windows lets `npm` and other .cmd shims resolve.
const child = spawn(command, rest, {
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
