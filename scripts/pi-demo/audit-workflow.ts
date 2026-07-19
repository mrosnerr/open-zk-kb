#!/usr/bin/env bun
import * as fs from 'node:fs';
import * as path from 'node:path';
import { projectRoot } from './support.js';

const workflowPath = path.join(projectRoot, '.github', 'workflows', 'demo.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const required = [
  "if: github.event_name == 'workflow_dispatch'",
  'OPENROUTER_API_KEY: $' + '{{ secrets.OPENROUTER_API_KEY }}',
  'branch="automation/pi-demo-$' + '{GITHUB_RUN_ID}-$' + '{GITHUB_RUN_ATTEMPT}"',
  '"HEAD:refs/heads/$branch"',
  '--base dev',
  'actions/upload-artifact@',
  'concurrency:',
  'runs-on: ubuntu-24.04',
  'node-version: 22.19.0',
  'bun-version: 1.3.14',
  'sha256sum --check --strict',
  '":refs/heads/$branch"',
];
for (const text of required) {
  if (!workflow.includes(text)) throw new Error(`Release workflow is missing safety contract: ${text}`);
}

const shellSecretReference = /\$(?:\{OPENROUTER_API_KEY\}|OPENROUTER_API_KEY\b)/;
for (const example of [
  'echo "$' + 'OPENROUTER_API_KEY"',
  'printf "%s" "${' + 'OPENROUTER_API_KEY}"',
  'curl -H "Authorization: Bearer $' + 'OPENROUTER_API_KEY"',
]) {
  if (!shellSecretReference.test(example)) {
    throw new Error('Release workflow audit does not recognize a known shell secret reference');
  }
}

for (const line of workflow.split('\n')) {
  if (/git push/.test(line) && /refs\/heads\/(dev|main)(?:\s|"|$)/.test(line)) {
    throw new Error(`Release workflow pushes directly to a protected branch: ${line.trim()}`);
  }
  if (shellSecretReference.test(line)) {
    throw new Error('Release workflow must not expand OPENROUTER_API_KEY in shell commands');
  }
  if (/\bset\s+(?:-x|-o\s+xtrace)\b|\bbash\s+-x\b/.test(line)) {
    throw new Error('Release workflow may enable shell tracing while handling secrets');
  }
}
if (/bun-version:\s*latest/.test(workflow)) {
  throw new Error('Release workflow must pin Bun for reproducible media');
}

console.log('Release workflow audit: manual gate, pinned runtimes, artifact upload, automation branch, PR to dev, no protected-branch push');
