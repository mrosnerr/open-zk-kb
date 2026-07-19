import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const defaultDemoRoot = path.join(projectRoot, '.tmp', 'pi-demo');
const demoRootParent = path.join(projectRoot, '.tmp');
export const demoRoot = path.resolve(process.env.OPEN_ZK_KB_PI_DEMO_ROOT ?? defaultDemoRoot);
if (demoRoot === demoRootParent || !demoRoot.startsWith(`${demoRootParent}${path.sep}`)) {
  throw new Error(`OPEN_ZK_KB_PI_DEMO_ROOT must be a child of ${demoRootParent}`);
}
export const packageRoot = path.join(demoRoot, 'staged', 'package');
export const demoHome = path.join(demoRoot, 'home');
export const xdgConfigHome = path.join(demoRoot, 'xdg', 'config');
export const xdgDataHome = path.join(demoRoot, 'xdg', 'data');
export const xdgRuntimeDir = path.join(demoRoot, 'xdg', 'runtime');
export const xdgStateHome = path.join(demoRoot, 'xdg', 'state');
export const demoTmpDir = path.join(demoRoot, 'tmp');
export const vaultPath = path.join(xdgDataHome, 'open-zk-kb');
export const fallbackVaultPath = path.join(demoHome, '.local', 'share', 'open-zk-kb');
export const demoTracePath = path.join(demoRoot, 'tool-lifecycle.jsonl');

export function demoEnvironment(options: { network?: boolean } = {}): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const sensitiveName = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|SSH_AUTH_SOCK|GPG_AGENT_INFO)/i;
  for (const name of Object.keys(env)) {
    if (sensitiveName.test(name) && !(options.network && name === 'OPENROUTER_API_KEY')) {
      delete env[name];
    }
  }
  if (options.network) {
    delete env.PI_OFFLINE;
  } else {
    env.PI_OFFLINE = '1';
  }
  return {
    ...env,
    HOME: demoHome,
    TMPDIR: demoTmpDir,
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_DATA_HOME: xdgDataHome,
    XDG_RUNTIME_DIR: xdgRuntimeDir,
    XDG_STATE_HOME: xdgStateHome,
    OPEN_ZK_KB_NO_UPDATE_CHECK: '1',
    OPEN_ZK_KB_PI_DEMO_ROOT: demoRoot,
    OPEN_ZK_KB_PI_DEMO_TRACE: demoTracePath,
  };
}

export function assertDemoIsolation(): void {
  if (!fs.existsSync(vaultPath)) {
    throw new Error(`Demo vault was not created at ${vaultPath}`);
  }
  if (fs.existsSync(fallbackVaultPath)) {
    throw new Error(`XDG isolation failed: MCP wrote to fallback vault ${fallbackVaultPath}`);
  }
  const realVault = path.resolve(process.env.HOME ?? '', '.local', 'share', 'open-zk-kb');
  if (vaultPath === realVault) {
    throw new Error('Refusing to use the real open-zk-kb vault for the Pi demo');
  }
}
