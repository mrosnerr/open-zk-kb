import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSessionUploadEligible } from '../src/mcp-server.js';
import { NoteRepository } from '../src/storage/NoteRepository.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('MCP session telemetry eligibility', () => {
  it('keeps an opted-in session upload-eligible when DO_NOT_TRACK=0', () => {
    expect(isSessionUploadEligible(true, '0')).toBe(true);
  });

  it('opts a session out only when DO_NOT_TRACK=1', () => {
    expect(isSessionUploadEligible(true, '1')).toBe(false);
  });

  it('durably excludes a DNT session after restart even when DNT is removed', () => {
    const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'open-zk-dnt-'));
    tempDirs.push(vault);

    const firstSession = new NoteRepository(vault, { telemetryEnabled: true });
    firstSession.recordSessionStart('test-client', null, 0, 'test', isSessionUploadEligible(true, '1'));
    firstSession.recordSessionEnd();
    firstSession.close();

    const nextSession = new NoteRepository(vault, { telemetryEnabled: true });
    expect(isSessionUploadEligible(true, '')).toBe(true);
    expect(nextSession.getUnreportedSessions()).toEqual([]);
    nextSession.close();
  });
});
