import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const executable = process.platform === 'win32'
  ? fileURLToPath(new URL('./package-windows.mjs', import.meta.url))
  : require.resolve('electron-builder/cli.js');
const args = process.platform === 'win32' ? [] : ['--config', 'electron-builder.config.cjs'];
const child = spawn(process.execPath, [executable, ...args, ...process.argv.slice(2)], { stdio: 'inherit' });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
