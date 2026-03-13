#!/usr/bin/env bun

export interface CliDependencies {
  startServer?: () => Promise<void>;
  runSetupCli?: (rawArgs: string[]) => Promise<void>;
}

export async function runCli(rawArgs: string[] = process.argv.slice(2), deps: CliDependencies = {}): Promise<void> {
  const command = rawArgs[0];

  if (command === 'server') {
    if (deps.startServer) {
      await deps.startServer();
      return;
    }

    const { startServer } = await import('./mcp-server.js');
    await startServer();
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
