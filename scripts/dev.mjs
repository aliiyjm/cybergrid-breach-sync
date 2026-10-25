// Modo desarrollo: compila el cliente en modo vigilancia y arranca el
// servidor con recarga (tsx watch). Ctrl+C detiene ambos procesos.
import { spawn } from 'node:child_process';

const isWindows = process.platform === 'win32';
const npx = isWindows ? 'npx.cmd' : 'npx';

const children = [
  spawn(process.execPath, ['scripts/build-client.mjs', '--watch'], { stdio: 'inherit' }),
  spawn(npx, ['tsx', 'watch', '--env-file-if-exists=.env', 'server/src/index.ts'], {
    stdio: 'inherit',
    shell: isWindows,
  }),
];

const stop = () => {
  for (const child of children) child.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const child of children) {
  child.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`Un proceso terminó con código ${code}; deteniendo el modo desarrollo.`);
      stop();
    }
  });
}
