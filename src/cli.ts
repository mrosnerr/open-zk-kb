#!/usr/bin/env bun

const rawArgs = process.argv.slice(2);
const command = rawArgs[0];

if (command === 'server') {
  const { startServer } = await import('./mcp-server.js');
  await startServer();
} else {
  const { runSetupCli } = await import('./setup.js');
  await runSetupCli(rawArgs);
}
