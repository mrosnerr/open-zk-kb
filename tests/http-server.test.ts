import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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
      // so we need a fresh import to pick up the new XDG_RUNTIME_DIR
      const mod = await import('../src/mcp-http-server.js');
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
      const mod = await import('../src/mcp-http-server.js');
      expect(mod.readServerState()).toBeNull();
    });

    it('should export ServerState interface shape', async () => {
      const mod = await import('../src/mcp-http-server.js');
      // Verify exports exist
      expect(typeof mod.readServerState).toBe('function');
      expect(typeof mod.startHttpServer).toBe('function');
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
