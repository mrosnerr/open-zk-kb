#!/usr/bin/env bun
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertDemoIsolation, defaultDemoRoot, demoRoot, demoTracePath, projectRoot, vaultPath } from './support.js';

const REMEMBER_PROMPT = 'Please remember that I understand coding concepts best through cooking metaphors';
const RUST_PROMPT = 'Please explain how macros in rust work';
const HEALTH_PROMPT = 'Whats the status of the knowledge base?';
const REMOVE_PROMPT = 'I was joking about the cooking metaphors. Please remove that preference.';
const RUST_ANSWER = 'A Rust macro is like a cookie cutter for code. You define rules for the shape once, then apply them to different batches of dough—Rust syntax supplied as input. Depending on that input, the macro can produce slightly different shapes or even elaborate designs. Rust expands the result into code during compilation. This saves you from writing recurring code patterns by hand.';

interface Probe {
  streams?: Array<{ width?: number; height?: number }>;
  format?: { duration?: string };
}

interface TraceEvent {
  event: string;
  tool?: string;
  isError?: boolean;
  text?: string;
  reason?: string;
  concise?: boolean;
  cooking?: boolean;
  healthy?: boolean;
  metrics?: string;
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
  return trace.some(event => event.event === 'tool-result' && event.tool === tool && event.isError === false);
}

function assertSecretAbsent(files: string[]): void {
  const secret = process.env.OPENROUTER_API_KEY;
  if (!secret) return;
  const needle = Buffer.from(secret);
  for (const file of files) {
    if (fs.readFileSync(file).includes(needle)) throw new Error(`OpenRouter secret material found in ${file}`);
  }
}

function assertDimensions(label: string, probeResult: Probe): void {
  const stream = probeResult.streams?.at(0);
  if (stream?.width !== 1200 || stream.height !== 800) {
    throw new Error(`${label} dimensions must be 1200x800, got ${stream?.width ?? '?'}x${stream?.height ?? '?'}`);
  }
}

const modeIndex = process.argv.indexOf('--mode');
const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : 'technical';
if (mode !== 'technical' && mode !== 'release') throw new Error(`Unknown validation mode: ${mode}`);

const mediaRoot = mode === 'release'
  ? path.resolve(process.env.OPEN_ZK_KB_PI_DEMO_MEDIA_ROOT ?? path.join(projectRoot, 'assets'))
  : defaultDemoRoot;
const basename = mode === 'release' ? 'pi-demo' : 'pi-demo-technical';
const video = path.join(mediaRoot, `${basename}.mp4`);
const image = path.join(mediaRoot, `${basename}.png`);
const healthImage = path.join(mediaRoot, `${basename}-health.png`);
const explanationImage = path.join(mediaRoot, `${basename}-explanation.png`);
const cleanupImage = path.join(mediaRoot, `${basename}-cleanup.png`);
const media = [video, image, healthImage, explanationImage, cleanupImage];
for (const file of media) {
  const size = fs.statSync(file).size;
  if (size < 20_000) throw new Error(`${file} is unexpectedly small (${size} bytes)`);
}

const videoProbe = await probe(video);
assertDimensions('video', videoProbe);
assertDimensions('image', await probe(image));
assertDimensions('health image', await probe(healthImage));
assertDimensions('explanation image', await probe(explanationImage));
assertDimensions('cleanup image', await probe(cleanupImage));
const duration = Number(videoProbe.format?.duration ?? 0);
const maximumDuration = mode === 'release' ? 120 : 90;
if (duration < 10 || duration > maximumDuration) {
  throw new Error(`Video duration must be between 10 and ${maximumDuration} seconds, got ${duration}`);
}

const trace = fs.readFileSync(demoTracePath, 'utf8')
  .trim()
  .split('\n')
  .map(line => JSON.parse(line) as TraceEvent);
for (const tool of ['knowledge-store', 'knowledge-health', 'knowledge-maintain']) {
  if (!hasSuccessfulTool(trace, tool)) throw new Error(`Capture did not receive a successful ${tool} result`);
}

const tapeName = mode === 'release' ? 'release.tape' : 'technical.tape';
const tape = fs.readFileSync(path.join(projectRoot, 'scripts', 'pi-demo', tapeName), 'utf8');
if ((tape.match(/^Type "\/new"$/gm) ?? []).length < 2) {
  throw new Error(`${tapeName} must start fresh sessions before Rust and health`);
}

const rememberIndex = trace.findIndex(event => event.event === 'input' && event.text === REMEMBER_PROMPT);
const rustIndex = trace.findIndex((event, index) => index > rememberIndex && event.event === 'input' && event.text === RUST_PROMPT);
const healthIndex = trace.findIndex((event, index) => index > rustIndex && event.event === 'input' && event.text === HEALTH_PROMPT);
const storeIndex = trace.findIndex((event, index) => index > rememberIndex && index < rustIndex && event.event === 'tool-result' && event.tool === 'knowledge-store' && event.isError === false);
const storeCompletion = trace.findIndex((event, index) => index > storeIndex && index < rustIndex && event.event === 'assistant-text' && event.text === 'Cooking preference saved.');
const rustSession = trace.findIndex((event, index) => index > storeCompletion && index < rustIndex && event.event === 'session_start' && event.reason === 'new');
const capsuleIndex = trace.findIndex((event, index) => index > rustSession && index < healthIndex && event.event === 'capsule' && event.concise && event.cooking);
const rustWindowSearch = trace.findIndex((event, index) => index > rustIndex && index < healthIndex && event.tool === 'knowledge-search');
const explanationIndex = trace.findIndex((event, index) => index > rustIndex && index < healthIndex && event.event === 'assistant-text' && event.text === RUST_ANSWER);
const healthSession = trace.findIndex((event, index) => index > explanationIndex && index < healthIndex && event.event === 'session_start' && event.reason === 'new');
const healthToolIndex = trace.findIndex((event, index) => index > healthIndex && event.event === 'tool-result' && event.tool === 'knowledge-health' && event.isError === false);
const cleanupSession = trace.findIndex((event, index) => index > healthToolIndex && event.event === 'session_start' && event.reason === 'new');
const removeIndex = trace.findIndex((event, index) => index > cleanupSession && event.event === 'input' && event.text === REMOVE_PROMPT);
const deleteIndex = trace.findIndex((event, index) => index > removeIndex && event.event === 'tool-result' && event.tool === 'knowledge-maintain' && event.isError === false);
const removeCompletion = trace.findIndex((event, index) => index > deleteIndex && event.event === 'assistant-text' && event.text === 'Cooking-metaphor preference removed.');

if ([rememberIndex, rustIndex, healthIndex, storeIndex, storeCompletion, rustSession, capsuleIndex, explanationIndex, healthSession, healthToolIndex, cleanupSession, removeIndex, deleteIndex, removeCompletion].some(index => index < 0) || rustWindowSearch >= 0) {
  throw new Error('Capture trace does not prove ordered prompts, automatic preferences, exact Rust copy, healthy status, preference deletion, and zero Rust-window search');
}

const canonical = mode === 'release' || fs.existsSync(path.join(demoRoot, '.canonical'));
const healthResult = trace[healthToolIndex];
if (canonical) {
  if (!healthResult?.healthy || !healthResult.metrics
    || !/Health \(240 notes\)/i.test(healthResult.metrics)
    || !/Embedded: 240\/240 notes/i.test(healthResult.metrics)
    || !/All clear/i.test(healthResult.metrics)) {
    throw new Error('Canonical health trace does not prove 240 healthy notes, complete embeddings, and all-clear links');
  }
}

const preferenceFiles = fs.existsSync(path.join(vaultPath, 'preferences'))
  ? fs.readdirSync(path.join(vaultPath, 'preferences')).filter(file => /^\d{16}-.*\.md$/.test(file))
  : [];
if (preferenceFiles.length !== 1 || preferenceFiles.some(file => file.includes('cooking'))) {
  throw new Error(`Final cleanup did not leave exactly the concise preference: ${preferenceFiles.join(', ')}`);
}

assertSecretAbsent([...media, demoTracePath]);
assertDemoIsolation();
console.log(`Validated ${mode}${canonical ? ' canonical' : ''} Pi demo: store/automatic-preferences/exact-answer/health/delete/cleanup, 1200x800, ${duration.toFixed(1)}s`);
