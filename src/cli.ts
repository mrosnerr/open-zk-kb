#!/usr/bin/env bun

export interface CliDependencies {
  startServer?: () => Promise<void>;
  startHttpServer?: (options?: { port?: number; host?: string }) => Promise<void>;
  tryStdioBridge?: () => Promise<boolean>;
  runSetupCli?: (rawArgs: string[]) => Promise<void>;
  registerStdinEndHandler?: (handler: () => void) => void;
  shutdownServer?: () => void;
}

function parseFlag(args: string[], flag: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && i + 1 < args.length) return args[i + 1];
    if (args[i].startsWith(flag + '=')) return args[i].slice(flag.length + 1);
  }
  return undefined;
}

export async function runCli(rawArgs: string[] = process.argv.slice(2), deps: CliDependencies = {}): Promise<void> {
  const command = rawArgs[0];

  if (command === 'server') {
    // Try to bridge to an existing shared HTTP server
    try {
      const tryBridge = deps.tryStdioBridge ?? (await import('./mcp-stdio-proxy.js')).tryStdioBridge;
      const bridged = await tryBridge();
      if (bridged) return;  // Bridge established, stdio proxy running
    } catch {
      // Bridge unavailable — fall through
    }

    // No shared HTTP server found — start one alongside the stdio server
    // so subsequent clients can discover it and bridge to it (lightweight).
    let httpStarted = false;
    try {
      if (deps.startHttpServer) {
        await deps.startHttpServer();
      } else {
        const { startHttpServer } = await import('./mcp-http-server.js');
        await startHttpServer();
      }
      httpStarted = true;
    } catch {
      // HTTP server failed to start — could be port in use, permissions,
      // or another instance won the race ("already running"). Retry the
      // bridge in case a concurrent process just started the HTTP server.
      try {
        const tryBridge = deps.tryStdioBridge ?? (await import('./mcp-stdio-proxy.js')).tryStdioBridge;
        const bridged = await tryBridge();
        if (bridged) return;
      } catch {
        // Still no bridge — fall through to full in-process server
      }
    }

    // In combined mode (HTTP + stdio), exit when stdin closes so the
    // HTTP server doesn't keep the process alive after the client disconnects.
    // Note: StdioServerTransport already reads stdin (which resumes it);
    // we just need the exit handler, not an explicit resume().
    if (httpStarted) {
      const shutdownServer = deps.shutdownServer ?? (await import('./mcp-server.js')).shutdownServer;
      const registerStdinEndHandler = deps.registerStdinEndHandler
        ?? ((handler: () => void) => process.stdin.once('end', handler));
      registerStdinEndHandler(shutdownServer);
    }

    if (deps.startServer) {
      await deps.startServer();
      return;
    }
    const { startServer } = await import('./mcp-server.js');
    await startServer();
    return;
  }

  if (command === 'serve') {
    const portStr = parseFlag(rawArgs, '--port');
    const host = parseFlag(rawArgs, '--host');
    let port: number | undefined;
    if (portStr !== undefined) {
      const parsedPort = Number(portStr);
      if (!/^\d+$/.test(portStr) || !Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        throw new Error(`Invalid --port value: ${portStr}. Must be an integer between 1 and 65535.`);
      }
      port = parsedPort;
    }

    if (deps.startHttpServer) {
      await deps.startHttpServer({ port, host });
      return;
    }
    const { startHttpServer } = await import('./mcp-http-server.js');
    await startHttpServer({ port, host });
    return;
  }

  if (deps.runSetupCli) {
    await deps.runSetupCli(rawArgs);
    return;
  }
  const { runSetupCli } = await import('./setup.js');
  await runSetupCli(rawArgs);
}

if (import.meta.main) {
  await runCli();
}
