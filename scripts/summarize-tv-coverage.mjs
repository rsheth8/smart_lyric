// A repeatable, lyric-free scorecard from the real TV client's coverage reports.
import { readFile, writeFile } from 'node:fs/promises';

const [inventoryPath, beforePath, afterPath, outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error('Usage: node scripts/summarize-tv-coverage.mjs inventory.json before.json after.json report.md');
const [inventory, before, after] = await Promise.all([inventoryPath, beforePath, afterPath].map(async p => JSON.parse(await readFile(p, 'utf8'))));
const expected = new Set(inventory.map(r => r.spotifyId));
for (const report of [before, after]) {
  if (!report.complete || report.rows.length !== inventory.length || report.sampleSize !== inventory.length
      || new Set(report.rows.map(r => r.spotifyId)).size !== expected.size
      || report.rows.some(r => !expected.has(r.spotifyId))) throw new Error('Reports must cover the complete same inventory');
}
const old = new Map(before.rows.map(r => [r.spotifyId, r]));
const current = new Map(after.rows.map(r => [r.spotifyId, r]));
const improved = after.rows.filter(r => r.result === 'word_timestamps' && old.get(r.spotifyId).result !== 'word_timestamps');
const regressed = after.rows.filter(r => r.result !== 'word_timestamps' && old.get(r.spotifyId).result === 'word_timestamps');
const issues = after.rows.filter(r => r.issues.length || Math.abs(r.durationDifference ?? 0) > 2.5);
const labels = {word_timestamps:'Word timestamps',estimated_words_only:'Estimated words',audio_refined_mixed:'Audio-refined, mixed',unavailable:'Unavailable'};
const count = (report, kind) => report.rows.filter(r => r.result === kind).length;
const cell = s => String(s ?? '').replaceAll('|','\\|').replaceAll('\n',' ');
const songLink = r => '[' + cell(r.track) + '](https://open.spotify.com/track/' + r.spotifyId + ')';
const display = r => labels[r.result] ?? r.result;
const fmt = n => n.toFixed(1);
const fetchTimes = after.rows.map(r => r.fetchMilliseconds).sort((a,b)=>a-b);
const quantile = p => fetchTimes[Math.ceil(fetchTimes.length*p)-1];
const lines = [
  '# Bar4Bar · Gold Edition coverage',
  '',
  'Playlist: [Gold Edition](https://open.spotify.com/playlist/37i9dQZF1DWXnexX7CktaI). Frozen September 11, 2026: **' + inventory.length + ' exact Spotify track IDs** in playlist order.',
  '',
  '**Availability is measured. Vocal timing accuracy is not yet measured.** These checks run the production Apple TV lyric client on the Mac against the live service; they do not play or film the TV.',
  '',
  '| Result | Before search fix | After search fix |',
  '| --- | ---: | ---: |',
  ...['word_timestamps','estimated_words_only','audio_refined_mixed','unavailable'].map(k=>'| '+labels[k]+' | '+count(before,k)+' | '+count(after,k)+' |'),
  '| Human-verified accurate recordings | Not measured | Not measured |',
  '',
  'Word timestamp availability: **' + fmt(100*count(after,'word_timestamps')/inventory.length) + '%** of the complete playlist. No songs are omitted from the denominator. Having word timestamps is not an accuracy certification.',
  '',
  'Live native audit completed ' + after.checkedAt + '. Observed fetch time: median ' + quantile(.5) + ' ms; p95 ' + quantile(.95) + ' ms. This run may use warm provider/CDN caches and is not a cold-start latency guarantee.',
  '',
  '## What changed',
  '',
  'The server now searches a collaboration by its title and lead artist. Featured-artist and parenthesized “with” credits are removed from the search title; remix, live, and version labels remain. Results from unrelated artists and grossly mismatched durations are rejected before lyric retrieval. Up to three entries with matching titles/artist credits and closely matching durations are checked in parallel, because a single can lack word timing that exists on its album entry.',
  '',
  'Recovered word-timestamp availability for **' + improved.length + ' songs**:',
  '',
  ...improved.map(r=>'- '+songLink(r)+' — '+cell(r.artist)),
  '',
  'Previously word-timed songs falling back after the change: **' + regressed.length + '**.',
  '',
  ...regressed.map(r=>'- '+songLink(r)+' — '+display(r)),
  '',
  '## Timing and recording review',
  '',
  'Spotify track IDs and album names identify the intended test recordings. The playlist UI exposes duration only to whole seconds; this inventory does not claim millisecond duration or ISRC verification. Matching lyrics are still selected by metadata and duration, so remixes, clean versions, and alternate edits need listening checks.',
  '',
  ...issues.map(r=>'- '+songLink(r)+' — '+[
    ...r.issues.map(x=>x==='words_beyond_recording'?'some word spans exceed the displayed recording length by more than three seconds':x.replaceAll('_',' ')),
    ...(Math.abs(r.durationDifference ?? 0)>2.5?['provider duration differs by '+fmt(r.durationDifference)+' seconds']:[])
  ].join('; ')+'.'),
  '',
  'These are review flags, not confirmed acoustic error measurements. Do not mark these songs verified based on a provider response.',
  '',
  '## Next acceptance pass',
  '',
  'Start the manual pass with the recovered collaborations, then Pyramids and Lost for recording/timestamp anomalies, and Pink + White and have to. for missing word timing. Use the Spotify links below to retain the exact editions.',
  '',
  'For each recording: obtain matching authorized audio and lyrics, mark word boundaries, have a second listener review ambiguous vocals, and measure word coverage plus timing error. Keep missing words in the coverage denominator. Compare absolute timing and offset-adjusted timing separately. Then test playback, pause/resume, seeking, and remote navigation on Apple TV with the actual audio output.',
  '',
  'The prepared-timing service can supply reviewed recordings once ready. No new alignment files, licensed-provider subscriptions, or accuracy certifications were created in this pass.',
  '',
  '## Every song',
  '',
  '| # | Song | Artist | Before | Now | Selected source | Review |',
  '| ---: | --- | --- | --- | --- | --- | --- |',
  ...inventory.map(t=>{
    const r=current.get(t.spotifyId);
    const review=[...r.issues.map(x=>x.replaceAll('_',' ')),...(Math.abs(r.durationDifference??0)>2.5?['duration mismatch']:[])].join('; ')||'Accuracy pending';
    return '| '+t.position+' | '+songLink(t)+' | '+cell(t.artist)+' | '+display(old.get(t.spotifyId))+' | '+display(r)+' | '+(r.source??'—')+' | '+review+' |';
  }),
  '',
  '## Repeating the audit',
  '',
  '```sh',
  'swift run --package-path scripts/tv-coverage --scratch-path /tmp/bar4bar-coverage-build TVCoverage docs/quality/gold-edition-tracks-2026-09-11.json /tmp/gold-edition-native.json',
  'node scripts/check-tv-coverage.mjs docs/quality/gold-edition-tracks-2026-09-11.json /tmp/gold-edition-providers.json',
  'node scripts/summarize-tv-coverage.mjs docs/quality/gold-edition-tracks-2026-09-11.json docs/quality/gold-edition-native-2026-09-11.json /tmp/gold-edition-native.json /tmp/gold-edition-report.md',
  '```',
  '',
  'The native report is authoritative for what the app selects. The provider audit is diagnostic: it checks payload availability rather than parsing or acoustic accuracy. An empty HTTP 200 response is not proof that the upstream provider is healthy.',
  ''
];
await writeFile(outputPath,lines.join('\n'));
console.log(JSON.stringify({sampleSize:inventory.length,improved:improved.length,regressed:regressed.length,counts:after.counts}));
