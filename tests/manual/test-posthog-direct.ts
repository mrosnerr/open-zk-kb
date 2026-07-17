#!/usr/bin/env bun
/**
 * Direct PostHog API test — bypasses MCP server entirely.
 * Uses the same analytics ID as the real system.
 * Sends a single event and prints the full response.
 */

// Unset DO_NOT_TRACK for this script
delete process.env.DO_NOT_TRACK;

import { getOrCreateAnalyticsId } from '../../src/analytics.js';

const POSTHOG_HOST = 'https://eu.i.posthog.com';
const POSTHOG_API_KEY = 'phc_BjczNc5sPmdexNVK4xnKPrfrukpYsuJXWzYkhbHh6Hs9';

const distinctId = getOrCreateAnalyticsId();

const payload = {
  api_key: POSTHOG_API_KEY,
  event: 'test_event',
  distinct_id: distinctId,
  properties: {
    $lib: 'open-zk-kb',
    $lib_version: '1.2.0',
    $geoip_disable: true,
    tool: 'diagnostic',
  },
};

console.log('Sending to:', `${POSTHOG_HOST}/capture/`);
console.log('Analytics ID:', distinctId);
console.log('Payload:', JSON.stringify(payload, null, 2));
console.log('');

try {
  const res = await fetch(`${POSTHOG_HOST}/capture/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });

  console.log('Status:', res.status, res.statusText);
  const body = await res.text();
  console.log('Body:', body);
} catch (err) {
  console.error('Error:', err);
}
