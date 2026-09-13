// Anonymous funnel counters (protocol: app/analytics.js). One HINCRBY per event
// into a per-day hash in the relay's Upstash store; days expire after 90.

import { eventField } from '../app/analytics.js';
import { redis, readBody } from './companion.js';

const TTL_S = 90 * 86400;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.end();
    return;
  }
  const parsed = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body);
  const field = eventField(parsed ? req.body : await readBody(req));
  if (!field) {
    res.statusCode = 400;
    res.end();
    return;
  }
  const key = `events:${new Date().toISOString().slice(0, 10)}`;
  try {
    await redis([['HINCRBY', key, field, 1], ['EXPIRE', key, TTL_S]]);
    res.statusCode = 204;
  } catch {
    res.statusCode = 502;
  }
  res.end();
}
