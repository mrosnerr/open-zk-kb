#!/usr/bin/env bun
const MODEL = 'openai/gpt-oss-120b';
const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  throw new Error('OPENROUTER_API_KEY is required for release media capture');
}

const auth = await fetch('https://openrouter.ai/api/v1/auth/key', {
  headers: { Authorization: `Bearer ${key}` },
  signal: AbortSignal.timeout(15_000),
});
if (!auth.ok) {
  throw new Error(`OpenRouter key preflight failed with HTTP ${auth.status}`);
}
const authPayload = await auth.json() as { data?: { limit_remaining?: number | null } };
if (typeof authPayload.data?.limit_remaining === 'number' && authPayload.data.limit_remaining <= 0) {
  throw new Error('OpenRouter key has no remaining credit for release media capture');
}

const routes = await fetch(`https://openrouter.ai/api/v1/models/${MODEL}/endpoints`, {
  headers: { Authorization: `Bearer ${key}` },
  signal: AbortSignal.timeout(15_000),
});
if (!routes.ok) {
  throw new Error(`OpenRouter model preflight failed with HTTP ${routes.status}`);
}
interface Endpoint {
  status?: number;
  supported_parameters?: string[];
}
const payload = await routes.json() as { data?: { endpoints?: Endpoint[] } };
const requiredParameters = ['seed', 'temperature', 'tools'];
const compatibleRoutes = (payload.data?.endpoints ?? []).filter((endpoint) => (
  endpoint.status === 0
  && requiredParameters.every((parameter) => endpoint.supported_parameters?.includes(parameter))
));
if (compatibleRoutes.length === 0) {
  throw new Error(`OpenRouter has no active ${MODEL} route supporting ${requiredParameters.join(', ')}; release capture will not fall back`);
}

console.log(`OpenRouter preflight: ${MODEL} has ${compatibleRoutes.length} compatible route(s)`);
