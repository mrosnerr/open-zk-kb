#!/usr/bin/env bun
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertDemoIsolation, demoEnvironment, demoRoot, packageRoot, projectRoot } from './support.js';

const prepared = process.argv.includes('--prepared');
const release = process.argv.includes('--release');
let activeProcess: ReturnType<typeof Bun.spawn> | undefined;
let interrupted: NodeJS.Signals | undefined;

const exitCodeForSignal: Partial<Record<NodeJS.Signals, number>> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};

function handleSignal(signal: NodeJS.Signals): void {
  if (interrupted) return;
  interrupted = signal;
  activeProcess?.kill(signal);
  const forceKill = setTimeout(() => activeProcess?.kill('SIGKILL'), 3_000);
  forceKill.unref();
}

const signalHandlers = (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((signal) => {
  const handler = (): void => handleSignal(signal);
  process.on(signal, handler);
  return [signal, handler] as const;
});

async function main(): Promise<number> {
  try {
    if (!prepared) {
      const prepare = Bun.spawn(['bun', 'run', path.join(projectRoot, 'scripts', 'pi-demo', 'prepare.ts')], {
        cwd: projectRoot,
        env: demoEnvironment(),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      activeProcess = prepare;
      const [prepareStdout, prepareStderr, prepareExit] = await Promise.all([
        new Response(prepare.stdout).text(),
        new Response(prepare.stderr).text(),
        prepare.exited,
      ]);
      activeProcess = undefined;
      if (interrupted) return exitCodeForSignal[interrupted] ?? 1;
      if (prepareExit !== 0) {
        process.stderr.write(prepareStderr);
        process.stderr.write(prepareStdout);
        return prepareExit;
      }
    }

    assertDemoIsolation();
    process.stdout.write('\x1B[2J\x1B[H');

    const providerPath = path.join(
      projectRoot,
      'scripts',
      'pi-demo',
      release ? 'openrouter-provider.ts' : 'provider.ts',
    );
    const presentationPath = path.join(projectRoot, 'scripts', 'pi-demo', 'presentation.ts');
    if (release) {
      const preflight = Bun.spawn(['bun', 'run', path.join(projectRoot, 'scripts', 'pi-demo', 'preflight-openrouter.ts')], {
        cwd: projectRoot,
        env: demoEnvironment({ network: true }),
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'inherit',
      });
      activeProcess = preflight;
      const preflightExit = await preflight.exited;
      activeProcess = undefined;
      if (interrupted) return exitCodeForSignal[interrupted] ?? 1;
      if (preflightExit !== 0) return preflightExit;
    }

    const tools = [
      'knowledge-search',
      'knowledge-store',
      'knowledge-context',
      'knowledge-health',
    ].join(',');
    const provider = release ? 'open-zk-release' : 'open-zk-demo';
    const model = release ? 'openai/gpt-oss-120b' : 'scripted';
    const piArgs = [
      'pi',
      ...(release ? [] : ['--offline']),
      '--approve',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--no-builtin-tools',
      '--tools', tools,
      '--no-session',
      '--thinking', 'off',
      '--provider', provider,
      '--model', model,
      '--extension', packageRoot,
      '--extension', providerPath,
      '--extension', presentationPath,
    ];
    const pi = Bun.spawn(piArgs, {
      cwd: projectRoot,
      env: demoEnvironment({ network: release }),
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    activeProcess = pi;
    const exitCode = await pi.exited;
    activeProcess = undefined;
    if (interrupted) return exitCodeForSignal[interrupted] ?? 1;
    assertDemoIsolation();
    return exitCode;
  } finally {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    if (process.env.OPEN_ZK_KB_PI_DEMO_CLEANUP === '1') {
      fs.rmSync(demoRoot, { recursive: true, force: true });
    }
  }
}

process.exitCode = await main();
