#!/usr/bin/env bun

export interface CliDependencies {
  startServer?: () => Promise<void>;
  startHttpServer?: (options?: { port?: number; host?: string }) => Promise<void>;
  tryStdioBridge?: () => Promise<boolean>;
  runSetupCli?: (rawArgs: string[]) => Promise<void>;
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
    try {
      const tryBridge = deps.tryStdioBridge ?? (await import('./mcp-stdio-proxy.js')).tryStdioBridge;
      const bridged = await tryBridge();
      if (bridged) return;  // Bridge established, stdio proxy running
    } catch {
      // Bridge unavailable — fall through to in-process server
    }

    // No HTTP server available — run full server in-process
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
    const port = portStr === undefined ? undefined : Number(portStr);
    if (portStr !== undefined && (!/^\d+$/.test(portStr) || !Number.isInteger(port) || port! < 1 || port! > 65535)) {
      throw new Error(`Invalid --port value: ${portStr}. Must be an integer between 1 and 65535.`);
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
