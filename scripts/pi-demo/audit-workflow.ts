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

for (const line of workflow.split('\n')) {
  if (/git push/.test(line) && /refs\/heads\/(dev|main)(?:\s|"|$)/.test(line)) {
    throw new Error(`Release workflow pushes directly to a protected branch: ${line.trim()}`);
  }
}
if (/OPENROUTER_API_KEY[^\n]*(echo|printf)/.test(workflow)) {
  throw new Error('Release workflow may print OPENROUTER_API_KEY');
}
if (/bun-version:\s*latest/.test(workflow)) {
  throw new Error('Release workflow must pin Bun for reproducible media');
}

console.log('Release workflow audit: manual gate, pinned runtimes, artifact upload, automation branch, PR to dev, no protected-branch push');
