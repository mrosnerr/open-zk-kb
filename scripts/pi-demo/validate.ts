#!/usr/bin/env bun
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertDemoIsolation, defaultDemoRoot, demoTracePath, projectRoot } from './support.js';

interface Probe {
  streams?: Array<{ width?: number; height?: number }>;
  format?: { duration?: string };
}

interface TraceEvent {
  event: string;
  tool?: string;
  isError?: boolean;
  text?: string;
}

async function probe(file: string): Promise<Probe> {
  const child = Bun.spawn([
    'ffprobe', '-v', 'error', '-show_entries', 'stream=width,height:format=duration',
    '-of', 'json', file,
  ], { cwd: projectRoot, stdout: 'pipe', stderr: 'inherit' });
  const output = await new Response(child.stdout).text();
  if (await child.exited !== 0) throw new Error(`ffprobe failed for ${file}`);
  return JSON.parse(output) as Probe;
}

function hasSuccessfulTool(trace: TraceEvent[], tool: string): boolean {
  return trace.some((event) => event.event === 'tool-result' && event.tool === tool && event.isError === false);
}

function assertSecretAbsent(files: string[]): void {
  const secret = process.env.OPENROUTER_API_KEY;
  if (!secret) return;
  const needle = Buffer.from(secret);
  for (const file of files) {
    if (fs.readFileSync(file).includes(needle)) {
      throw new Error(`OpenRouter secret material found in ${file}`);
    }
  }
}

const modeArg = process.argv.indexOf('--mode');
const mode = modeArg >= 0 ? process.argv[modeArg + 1] : 'technical';
if (mode !== 'technical' && mode !== 'release') {
  throw new Error(`Unknown validation mode: ${mode}`);
}

const mediaRoot = mode === 'release'
  ? path.resolve(process.env.OPEN_ZK_KB_PI_DEMO_MEDIA_ROOT ?? path.join(projectRoot, 'assets'))
  : defaultDemoRoot;
const basename = mode === 'release' ? 'pi-demo' : 'pi-demo-technical';
const video = path.join(mediaRoot, `${basename}.mp4`);
const image = path.join(mediaRoot, `${basename}.png`);
for (const file of [video, image]) {
  const size = fs.statSync(file).size;
  if (size < 20_000) throw new Error(`${file} is unexpectedly small (${size} bytes)`);
}

const videoProbe = await probe(video);
const imageProbe = await probe(image);
const videoStream = videoProbe.streams?.at(0);
const imageStream = imageProbe.streams?.at(0);
for (const [label, stream] of [['video', videoStream], ['image', imageStream]] as const) {
  if (stream?.width !== 1200 || stream.height !== 800) {
    throw new Error(`${label} dimensions must be 1200x800, got ${stream?.width ?? '?'}x${stream?.height ?? '?'}`);
  }
}
const duration = Number(videoProbe.format?.duration ?? 0);
const maximumDuration = mode === 'release' ? 120 : 60;
if (duration < 15 || duration > maximumDuration) {
  throw new Error(`Video duration must be between 15 and ${maximumDuration} seconds, got ${duration}`);
}

const trace = fs.readFileSync(demoTracePath, 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line) as TraceEvent);
const requiredTools = mode === 'release'
  ? ['knowledge-store', 'knowledge-search', 'knowledge-health']
  : ['knowledge-store', 'knowledge-search'];
for (const tool of requiredTools) {
  if (!hasSuccessfulTool(trace, tool)) {
    throw new Error(`Capture did not receive a successful ${tool} result`);
  }
}

if (mode === 'release') {
  const rememberPrompt = 'Please remember that I understand coding concepts best through cooking metaphors';
  const rustPrompt = 'Please explain how macros in rust work';
  const healthPrompt = 'Whats the status of the knowledge base?';
  const releaseTape = fs.readFileSync(path.join(projectRoot, 'scripts', 'pi-demo', 'release.tape'), 'utf8');
  if (!/^Type "\/new"$/m.test(releaseTape)) {
    throw new Error('Release tape does not contain the required /new session boundary');
  }
  const rememberIndex = trace.findIndex((event) => event.event === 'input' && event.text === rememberPrompt);
  const rustIndex = trace.findIndex((event, index) => index > rememberIndex && event.event === 'input' && event.text === rustPrompt);
  const healthIndex = trace.findIndex((event, index) => index > rustIndex && event.event === 'input' && event.text === healthPrompt);
  const storeIndex = trace.findIndex((event, index) => index > rememberIndex && index < rustIndex && event.event === 'tool-result' && event.tool === 'knowledge-store' && event.isError === false);
  const storeCompletion = trace.findIndex((event, index) => index > storeIndex && index < rustIndex && event.event === 'assistant-text' && event.text?.includes('Cooking preference saved.'));
  const newSession = trace.findIndex((event, index) => index > storeCompletion && index < rustIndex && event.event === 'session_start');
  const searchIndex = trace.findIndex((event, index) => index > rustIndex && index < healthIndex && event.event === 'tool-result' && event.tool === 'knowledge-search' && event.isError === false);
  const healthToolIndex = trace.findIndex((event, index) => index > healthIndex && event.event === 'tool-result' && event.tool === 'knowledge-health' && event.isError === false);
  const healthCompletion = trace.findIndex((event, index) => index > healthToolIndex && event.event === 'assistant-text' && event.text?.includes('Knowledge base status loaded.'));
  if (rememberIndex < 0 || newSession < 0 || rustIndex < 0 || healthIndex < 0 || storeIndex < 0 || storeCompletion < 0 || searchIndex < 0 || healthToolIndex < 0 || healthCompletion < 0) {
    throw new Error('Release trace does not prove ordered prompts, fresh session, successful tools, and completed answers');
  }
  const explanation = trace
    .slice(rustIndex + 1, healthIndex)
    .filter((event) => event.event === 'assistant-text' && event.text)
    .map((event) => event.text)
    .join('\n');
  if (explanation.length < 100 || !/macro/i.test(explanation) || !/(cook|recipe|kitchen|ingredient)/i.test(explanation)) {
    throw new Error('Release capture lacks a substantial cooking-metaphor explanation of Rust macros');
  }
  if (!explanation.includes('That is the recipe.')) {
    throw new Error('Release explanation did not reach its required completion marker');
  }
}

assertSecretAbsent([video, image, demoTracePath]);
assertDemoIsolation();
console.log(`Validated ${mode} Pi demo: ${requiredTools.join('/')}, 1200x800, ${duration.toFixed(1)}s`);
