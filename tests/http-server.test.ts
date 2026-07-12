import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

async function loadFreshServerStateModule() {
  return import(`../src/server-state.js?test=${Date.now()}-${Math.random()}`);
}

async function loadFreshHttpServerModule() {
  return import(`../src/mcp-http-server.js?test=${Date.now()}-${Math.random()}`);
}

describe('HTTP Server', () => {
  let tmpDir: string;
  let originalRuntimeDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ozkb-http-test-'));
    originalRuntimeDir = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = tmpDir;
  });

  afterEach(() => {
    if (originalRuntimeDir !== undefined) {
      process.env.XDG_RUNTIME_DIR = originalRuntimeDir;
    } else {
      delete process.env.XDG_RUNTIME_DIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('readServerState', () => {
    it('should return null when no state file exists', async () => {
      // readServerState uses module-level constants computed at import time,
      // so use a fresh import to pick up the new XDG_RUNTIME_DIR.
      const mod = await loadFreshServerStateModule();
      const result = mod.readServerState();
      expect(result).toBeNull();
    });

    it('should return null for stale state file (dead PID)', async () => {
      const stateDir = path.join(tmpDir, 'open-zk-kb');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, 'server.json'),
        JSON.stringify({
          pid: 999999999,
          port: 17244,
          host: '127.0.0.1',
          version: '1.0.0',
          startedAt: new Date().toISOString(),
        }),
      );
      const mod = await loadFreshServerStateModule();
      expect(mod.readServerState()).toBeNull();
    });

    it('should export ServerState interface shape', async () => {
      const mod = await loadFreshHttpServerModule();
      // Verify exports exist
      expect(typeof mod.readServerState).toBe('function');
      expect(typeof mod.startHttpServer).toBe('function');
    });
  });
  describe('bind security', () => {
    it('allows loopback binds without authentication', async () => {
      const { assertHttpServerSecurity } = await loadFreshHttpServerModule();

      expect(() => assertHttpServerSecurity('127.0.0.1')).not.toThrow();
    });

    it('rejects non-loopback binds without authentication', async () => {
      const { assertHttpServerSecurity } = await loadFreshHttpServerModule();

      expect(() => assertHttpServerSecurity('0.0.0.0')).toThrow(
        'Refusing to bind HTTP server to non-loopback host "0.0.0.0" without server.authToken configured',
      );
    });

    it('allows non-loopback binds with authentication', async () => {
      const { assertHttpServerSecurity } = await loadFreshHttpServerModule();

      expect(() => assertHttpServerSecurity('0.0.0.0', 'test-token')).not.toThrow();
    });

    it('requires the configured bearer token for MCP requests', async () => {
      const { isHttpRequestAuthorized } = await loadFreshHttpServerModule();

      expect(isHttpRequestAuthorized(new Request('http://localhost/mcp'), 'test-token')).toBe(false);
      expect(isHttpRequestAuthorized(
        new Request('http://localhost/mcp', { headers: { Authorization: 'Bearer test-token' } }),
        'test-token',
      )).toBe(true);
    });
  });

  describe('CLI serve command', () => {
    it('should call startHttpServer with parsed flags', async () => {
      let capturedOptions: unknown = null;
      const { runCli } = await import('../src/cli.js');

      await runCli(['serve', '--port', '18000', '--host', '0.0.0.0'], {
        startHttpServer: async (opts) => {
          capturedOptions = opts;
        },
      });

      expect(capturedOptions).toEqual({ port: 18000, host: '0.0.0.0' });
    });

    it('should call startHttpServer with defaults when no flags', async () => {
      let capturedOptions: unknown = null;
      const { runCli } = await import('../src/cli.js');

      await runCli(['serve'], {
        startHttpServer: async (opts) => {
          capturedOptions = opts;
        },
      });

      expect(capturedOptions).toEqual({ port: undefined, host: undefined });
    });

    it('should parse --port as integer', async () => {
      let capturedOptions: unknown = null;
      const { runCli } = await import('../src/cli.js');

      await runCli(['serve', '--port', '9999'], {
        startHttpServer: async (opts) => {
          capturedOptions = opts;
        },
      });

      expect((capturedOptions as { port: number }).port).toBe(9999);
      expect(typeof (capturedOptions as { port: number }).port).toBe('number');
    });

    it('should reject invalid port values', async () => {
      const { runCli } = await import('../src/cli.js');

      await expect(runCli(['serve', '--port', 'abc'], {
        startHttpServer: async () => {},
      })).rejects.toThrow('Invalid --port value');

      await expect(runCli(['serve', '--port', '0'], {
        startHttpServer: async () => {},
      })).rejects.toThrow('Invalid --port value');

      await expect(runCli(['serve', '--port', '70000'], {
        startHttpServer: async () => {},
      })).rejects.toThrow('Invalid --port value');
    });

    it('should support --port=VALUE syntax', async () => {
      let capturedOptions: unknown = null;
      const { runCli } = await import('../src/cli.js');

      await runCli(['serve', '--port=18000', '--host=0.0.0.0'], {
        startHttpServer: async (opts) => {
          capturedOptions = opts;
        },
      });

      expect(capturedOptions).toEqual({ port: 18000, host: '0.0.0.0' });
    });
  });

  describe('CLI server command with proxy', () => {
    it('should try bridge first, start HTTP server, then fall back to startServer', async () => {
      let bridgeCalled = false;
      let httpStarted = false;
      let serverCalled = false;
      const { runCli } = await import('../src/cli.js');

      await runCli(['server'], {
        tryStdioBridge: async () => {
          bridgeCalled = true;
          return false;
        },
        startHttpServer: async () => {
          httpStarted = true;
        },
        startServer: async () => {
          serverCalled = true;
        },
      });

      expect(bridgeCalled).toBe(true);
      expect(httpStarted).toBe(true);
      expect(serverCalled).toBe(true);
    });

    it('should not call startServer when bridge succeeds', async () => {
      let serverCalled = false;
      const { runCli } = await import('../src/cli.js');

      await runCli(['server'], {
        tryStdioBridge: async () => true,
        startHttpServer: async () => {},
        startServer: async () => {
          serverCalled = true;
        },
      });

      expect(serverCalled).toBe(false);
    });

    it('should call tryStdioBridge before startServer', async () => {
      const callOrder: string[] = [];
      const { runCli } = await import('../src/cli.js');

      await runCli(['server'], {
        tryStdioBridge: async () => {
          callOrder.push('bridge');
          return false;
        },
        startHttpServer: async () => {
          callOrder.push('http');
        },
        startServer: async () => {
          callOrder.push('server');
        },
      });

      expect(callOrder).toEqual(['bridge', 'http', 'server']);
    });

    it('should fall back to startServer when bridge throws', async () => {
      let serverCalled = false;
      const { runCli } = await import('../src/cli.js');

      await runCli(['server'], {
        tryStdioBridge: async () => {
          throw new Error('Connection refused');
        },
        startHttpServer: async () => {},
        startServer: async () => {
          serverCalled = true;
        },
      });

      expect(serverCalled).toBe(true);
    });

    it('should retry bridge when HTTP startup fails (race condition)', async () => {
      let bridgeAttempts = 0;
      const { runCli } = await import('../src/cli.js');

      await runCli(['server'], {
        tryStdioBridge: async () => {
          bridgeAttempts++;
          // First call: no server yet. Second call (retry): server found.
          return bridgeAttempts > 1;
        },
        startHttpServer: async () => {
          throw new Error('Another open-zk-kb HTTP server is already running');
        },
        startServer: async () => {},
      });

      expect(bridgeAttempts).toBe(2);
    });
  });

  describe('CLI default command', () => {
    it('should fall through to setup when command is not server/serve', async () => {
      let setupCalled = false;
      let setupArgs: string[] = [];
      const { runCli } = await import('../src/cli.js');

      await runCli(['install'], {
        runSetupCli: async (args) => {
          setupCalled = true;
          setupArgs = args;
        },
      });

      expect(setupCalled).toBe(true);
      expect(setupArgs).toEqual(['install']);
    });

    it('should call setup with no args when no command given', async () => {
      let setupArgs: string[] = [];
      const { runCli } = await import('../src/cli.js');

      await runCli([], {
        runSetupCli: async (args) => {
          setupArgs = args;
        },
      });

      expect(setupArgs).toEqual([]);
    });
  });
});
