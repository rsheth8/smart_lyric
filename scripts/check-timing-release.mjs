import { readFile, writeFile } from 'node:fs/promises';
import { checkTimingRelease } from '../lib/timing-release.mjs';
const [artifactPath, referencePath, outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error('Usage: node scripts/check-timing-release.mjs prepared.json reviewed-reference.json release-report.json');
const report = checkTimingRelease(JSON.parse(await readFile(artifactPath, 'utf8')),
  JSON.parse(await readFile(referencePath, 'utf8')));
await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, failures: report.failures, outputPath }));
if (report.status !== 'passed') process.exitCode = 2;
