// Stage only the web and API files needed by the TV companion server.
// Desktop ML packages, local recordings, credentials and Xcode builds never ship.
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const out = await mkdtemp(join(tmpdir(), 'bar4bar-server-'));
for (const name of ['app', 'api', 'lib', 'vercel.json']) {
  await cp(resolve(root, name), join(out, name), { recursive: true });
}
await writeFile(join(out, 'package.json'), JSON.stringify({
  name: 'bar4bar-tv-server', private: true, type: 'module', engines: { node: '24.x' },
}, null, 2) + '\n');
await mkdir(join(out, '.vercel'));
await cp(join(root, '.vercel/project.json'), join(out, '.vercel/project.json'));
console.log(out);
