import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pageUrl = pathToFileURL(path.resolve('ui/index.html')).href;
const opener = process.platform === 'win32'
  ? ['cmd.exe', ['/c', 'start', '', pageUrl]]
  : process.platform === 'darwin'
    ? ['open', [pageUrl]]
    : ['xdg-open', [pageUrl]];

const child = spawn(opener[0], opener[1], { detached: true, stdio: 'ignore' });
child.once('error', error => {
  console.error(`Could not open the visualizer: ${error.message}`);
  process.exitCode = 1;
});
child.unref();
