import { describe, expect, it } from 'bun:test';
import { isSessionUploadEligible } from '../src/mcp-server.js';
import { NoteRepository } from '../src/storage/NoteRepository.js';
import { cleanupTestHarness, createTestHarness } from './harness.js';

describe('MCP session telemetry eligibility', () => {
  it('keeps an opted-in session upload-eligible when DO_NOT_TRACK=0', () => {
    expect(isSessionUploadEligible(true, '0')).toBe(true);
  });

  it('opts a session out only when DO_NOT_TRACK=1', () => {
    expect(isSessionUploadEligible(true, '1')).toBe(false);
  });

  it('durably excludes a DNT session after restart even when DNT is removed', () => {
    const context = createTestHarness({ telemetryEnabled: true });

    try {
      context.engine.recordSessionStart('test-client', null, 0, 'test', isSessionUploadEligible(true, '1'));
      context.engine.recordSessionEnd();
      context.engine.close();

      // Reopening the same vault models a server restart with DNT removed.
      const nextSession = new NoteRepository(context.tempDir, {
        telemetryEnabled: context.config.telemetry.enabled,
      });
      try {
        expect(isSessionUploadEligible(true, '')).toBe(true);
        expect(nextSession.getUnreportedSessions()).toEqual([]);
      } finally {
        nextSession.close();
      }
    } finally {
      cleanupTestHarness(context);
    }
  });
});
