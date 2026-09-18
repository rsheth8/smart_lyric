// Accuracy is measured against checked vocal timestamps, not model confidence.
import { lcsPairs } from '../app/timeline-cache.js';
const norm = text => String(text).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const quantile = (values, q) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
};
const metrics = errors => ({ medianMs: 1000 * quantile(errors, 0.5),
  p95Ms: 1000 * quantile(errors, 0.95), maxMs: 1000 * Math.max(...errors),
  within100ms: errors.filter(value => value <= 0.1).length / errors.length,
  within200ms: errors.filter(value => value <= 0.2).length / errors.length });
export function measureTiming(predicted, reference) {
  const pairs = lcsPairs(predicted.map(word => norm(word.text)), reference.map(word => norm(word.text)));
  const valid = pairs.filter(([p, r]) => Number.isFinite(predicted[p].start) && Number.isFinite(reference[r].start));
  if (!valid.length) throw new Error('No matching timed words.');
  const errors = valid.map(([p, r]) => predicted[p].start - reference[r].start);
  const offset = quantile(errors, 0.5);
  return { referenceWords: reference.length, predictedWords: predicted.length, matchedWords: valid.length,
    matchedFraction: valid.length / reference.length, missingReferenceWords: reference.length - valid.length,
    absolute: metrics(errors.map(Math.abs)),
    afterConstantOffset: metrics(errors.map(error => Math.abs(error - offset))),
    constantOffsetMs: offset * 1000,
    warning: 'Offset-adjusted results do not prove end-to-end sync. Missing words are not silently counted as accurate.' };
}
