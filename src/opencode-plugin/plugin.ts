import { logToFile } from '../logger.js';
import { detectProject } from './project-detect.js';
import { createReadonlyRepo, fetchKbContext, formatContext } from './context.js';

export interface PluginContext {
  client: { app: { log(options: { body: Record<string, unknown> }): void } };
  directory: string;
}

interface EventInput {
  event: { type: string; properties?: Record<string, unknown> };
}

interface SystemTransformInput {
  sessionID?: string;
  model: { id: string; providerID: string };
}

interface SystemTransformOutput {
  system: string[];
}

interface CompactingInput {
  sessionID: string;
}

interface CompactingOutput {
  context: string[];
  prompt?: string;
}

export interface PluginHooks {
  event: (input: EventInput) => Promise<void>;
  'experimental.chat.system.transform': (input: SystemTransformInput, output: SystemTransformOutput) => Promise<void>;
  'experimental.session.compacting': (input: CompactingInput, output: CompactingOutput) => Promise<void>;
}

type LogLevel = 'INFO' | 'WARN' | 'ERROR';

function log(ctx: PluginContext, level: LogLevel, message: string, extra?: Record<string, unknown>): void {
  try {
    ctx.client.app.log({ body: { service: 'open-zk-kb', level, message, extra } });
  } catch {
    logToFile(level, `opencode-plugin: ${message}`, extra);
  }
}

export function createKbPlugin(): (ctx: PluginContext) => Promise<PluginHooks> {
  return async (ctx: PluginContext): Promise<PluginHooks> => {
    const project = detectProject(ctx.directory);
    if (!project) {
      log(ctx, 'INFO', 'no project detected, plugin inactive', { directory: ctx.directory });
      return createNoopHooks();
    }

    const repo = createReadonlyRepo();
    if (!repo) {
      log(ctx, 'INFO', 'no vault found, plugin inactive');
      return createNoopHooks();
    }

    const injectedSessions = new Set<string>();
    const contextCache = new Map<string, string>();

    log(ctx, 'INFO', 'plugin active', { project, directory: ctx.directory });

    return {
      event: async ({ event }: EventInput): Promise<void> => {
        if (event.type === 'session.created') {
          const info = event.properties?.info as { id?: string } | undefined;
          const sessionID = info?.id;
          if (!sessionID || !repo) return;

          try {
            const kbContext = fetchKbContext(repo, project);
            const formatted = formatContext(kbContext);
            if (formatted) {
              contextCache.set(sessionID, formatted);
              injectedSessions.add(sessionID);
              log(ctx, 'INFO', 'context pre-fetched', {
                sessionID,
                project,
                hasDomain: !!kbContext.domainNote,
                noteCount: kbContext.recentNotes.length,
              });
            }
          } catch (e) {
            log(ctx, 'WARN', 'context pre-fetch failed', {
              sessionID,
              error: e instanceof Error ? e.constructor.name : 'unknown',
            });
          }
        }

        if (event.type === 'session.deleted') {
          const info = event.properties?.info as { id?: string } | undefined;
          const sessionID = info?.id;
          if (sessionID) {
            injectedSessions.delete(sessionID);
            contextCache.delete(sessionID);
          }
        }
      },

      'experimental.chat.system.transform': async (
        input: SystemTransformInput,
        output: SystemTransformOutput,
      ): Promise<void> => {
        const sessionID = input.sessionID;
        if (!sessionID || !injectedSessions.has(sessionID)) return;

        const cached = contextCache.get(sessionID);
        if (cached) {
          output.system.push(cached);
          injectedSessions.delete(sessionID);
          contextCache.delete(sessionID);
        }
      },

      'experimental.session.compacting': async (
        input: CompactingInput,
        output: CompactingOutput,
      ): Promise<void> => {
        if (!repo) return;

        try {
          const kbContext = fetchKbContext(repo, project);
          const formatted = formatContext(kbContext);
          if (formatted) {
            output.context.push(formatted);
            injectedSessions.add(input.sessionID);
            contextCache.set(input.sessionID, formatted);
          }
        } catch (e) {
          log(ctx, 'WARN', 'compaction context injection failed', {
            sessionID: input.sessionID,
            error: e instanceof Error ? e.constructor.name : 'unknown',
          });
        }
      },
    };
  };
}

function createNoopHooks(): PluginHooks {
  return {
    event: async () => {},
    'experimental.chat.system.transform': async () => {},
    'experimental.session.compacting': async () => {},
  };
}
