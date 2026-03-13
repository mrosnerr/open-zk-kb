import { describe, it, expect } from 'bun:test';

// Bun caches ESM imports by URL — appending a unique query string forces a
// fresh module instance per call so tests don't share mutable state.
async function loadFreshCliModule() {
  return import(`../src/cli.js?test=${Date.now()}-${Math.random()}`);
}

describe('cli.ts', () => {
  it('routes the server command to startServer', async () => {
    const cliModule = await loadFreshCliModule();
    let startCalls = 0;
    let setupCalls = 0;

    await cliModule.runCli(['server'], {
      startServer: async () => {
        startCalls += 1;
      },
      runSetupCli: async () => {
        setupCalls += 1;
      },
    });

    expect(startCalls).toBe(1);
    expect(setupCalls).toBe(0);
  });

  it('routes non-server commands to runSetupCli', async () => {
    const cliModule = await loadFreshCliModule();
    let startCalls = 0;
    let receivedArgs = '';

    await cliModule.runCli(['doctor', '--client', 'opencode'], {
      startServer: async () => {
        startCalls += 1;
      },
      runSetupCli: async (rawArgs: string[]) => {
        receivedArgs = rawArgs.join(' ');
      },
    });

    expect(startCalls).toBe(0);
    expect(receivedArgs).toBe('doctor --client opencode');
  });
});
