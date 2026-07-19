#!/usr/bin/env bun
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.env.OPEN_ZK_KB_PI_DEMO_ROOT ??= path.join(projectRoot, '.tmp', `pi-demo-preview-${process.pid}`);
process.env.OPEN_ZK_KB_PI_DEMO_CLEANUP = '1';
await import('./launch.js');
