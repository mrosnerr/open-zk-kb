import * as fs from 'node:fs';
import { createNoteRepository } from '../../src/storage/NoteRepository.js';
import { handleStore, type StoreArgs } from '../../src/tool-handlers.js';

const [vault, mode, lane, barrier, targetId, expectedText] = process.argv.slice(2);
if (!vault || !mode || !lane || !barrier) throw new Error('Missing race fixture arguments');
const repo = createNoteRepository(vault, { telemetryEnabled: false });

const base: StoreArgs = {
  title: mode === 'create' ? 'Cross Process Candidate' : 'Cross Process Target',
  content: mode === 'create' ? 'same cross process candidate content' : `updated by ${lane}`,
  kind: 'reference',
  summary: mode === 'create' ? 'Cross process candidate summary.' : `Updated by ${lane}.`,
  guidance: mode === 'create' ? 'Use the race candidate.' : `Use lane ${lane}.`,
  project: 'race',
  dryRun: true,
  disposition: mode === 'create' ? 'create' : 'update',
  noteId: targetId || undefined,
  expectedUpdatedAt: expectedText ? Number(expectedText) : undefined,
};

try {
  const previewText = await handleStore(base, repo, null);
  const preview = JSON.parse(previewText) as { createToken?: string; updateTokens?: Array<{ id: string; token: string }> };
  const token = mode === 'create' ? preview.createToken : preview.updateTokens?.find(item => item.id === targetId)?.token;
  if (!token) throw new Error(`Missing operation token: ${previewText}`);
  fs.writeFileSync(`${barrier}.${lane}.ready`, 'ready');
  while (!fs.existsSync(barrier)) Bun.sleepSync(2);
  const result = await handleStore({ ...base, dryRun: false, confirm: true, token }, repo, null);
  fs.writeFileSync(`${barrier}.${lane}.result`, result);
} finally {
  repo.close();
}
