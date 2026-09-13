// Print the funnel counters for the last N days (default 7):
//   node --env-file=.env.local scripts/events.mjs 14
import { redis } from '../api/companion.js';

const days = Number(process.argv[2]) || 7;
for (let i = days - 1; i >= 0; i--) {
  const day = new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10);
  const [{ result = [] }] = await redis([['HGETALL', `events:${day}`]]);
  const rows = [];
  for (let j = 0; j < result.length; j += 2) rows.push([result[j], Number(result[j + 1])]);
  if (!rows.length) continue;
  console.log(day);
  for (const [field, n] of rows.sort()) console.log(`  ${String(n).padStart(6)}  ${field}`);
}
