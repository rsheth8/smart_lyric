// Publish a prepared, auditioned artifact using server-side Supabase credentials.
import { readFile } from 'node:fs/promises';
import { writeTimings } from '../lib/word-timings.mjs';
import { recordingStorageKey } from '../lib/recording-identity.mjs';
import { checkTimingRelease } from '../lib/timing-release.mjs';
const [path, referencePath] = process.argv.slice(2);
if (!path || !referencePath) throw new Error('Usage: node --env-file=<server-env> scripts/publish-tv-timings.mjs prepared.json reviewed-reference.json');
const value = JSON.parse(await readFile(path, 'utf8'));
recordingStorageKey(value.meta?.recording);
const report = checkTimingRelease(value, JSON.parse(await readFile(referencePath, 'utf8')));
if (report.status !== 'passed') throw new Error(`Timing review failed: ${report.failures.join(', ')}`);
await writeTimings(value);
console.log(`Saved prepared timings for ${value.meta.artist} — ${value.meta.track}.`);
