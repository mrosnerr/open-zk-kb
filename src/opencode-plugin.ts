// src/opencode-plugin.ts - OpenCode plugin for automatic knowledge capture and injection

import path from 'path';
import { NoteRepository, type NoteMetadata } from './storage/NoteRepository.js';
import { getConfig, getOpenCodeConfig } from './config.js';
import type { OpenCodeConfig } from './config.js';
import { renderNoteForAgent } from './prompts.js';
import { logToFile } from './logger.js';
import { generateEmbedding, buildEmbeddingText } from './embeddings.js';
import type { EmbeddingConfig } from './embeddings.js';
import type { NoteKind as CanonicalNoteKind, NoteStatus } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// PATTERN DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

type PatternType = 'decision' | 'preference' | 'solution' | 'pattern' | 'fact' | 'procedure';
type NoteKind = 'personalization' | 'decision' | 'procedure' | 'observation' | 'reference';

export interface CapturePattern {
  name: string;
  regex: RegExp;
  type: PatternType;
  suggestedKind: NoteKind;
  confidence: number;
}

export interface DetectedPattern {
  name: string;
  type: PatternType;
  match: string;
  confidence: number;
  suggestedKind: NoteKind;
  context?: string;
}

const VALID_NOTE_KINDS = new Set<string>(['personalization', 'reference', 'decision', 'procedure', 'resource', 'observation']);

function toCanonicalKind(kind: string): CanonicalNoteKind {
  if (VALID_NOTE_KINDS.has(kind)) return kind as CanonicalNoteKind;
  return 'observation';
}

// Domain-agnostic patterns that detect the STRUCTURE of valuable knowledge,
// not specific topics. Based on PKM/Zettelkasten principles:
// - Decisions with rationale are always worth keeping
// - Causal reasoning explains WHY (most valuable knowledge type)
// - Rules/constraints prevent repeated mistakes
// - Insights/discoveries capture new understanding
// - Comparisons clarify distinctions between similar things
// - Procedures capture executable how-to knowledge

export const AGENT_RESPONSE_PATTERNS: CapturePattern[] = [
  // ── Decisions & Choices ──
  {
    name: 'decision',
    regex: /(?:we['']ll|we will|let['']s|I recommend|decided to|going (?:to|with)|opted for|I chose|selected)\s+(.{20,200})/i,
    type: 'decision',
    suggestedKind: 'decision',
    confidence: 0.7,
  },
  {
    name: 'decision_rationale',
    regex: /(?:the reason (?:is|was|we)|this is because|we chose .+ (?:over|instead of)|the tradeoff is|I went with .+ because)\s+(.{20,250})/i,
    type: 'decision',
    suggestedKind: 'decision',
    confidence: 0.75,
  },
  // ── Preferences & Identity ──
  {
    name: 'preference_noted',
    regex: /(?:I['']ll remember|noted|I see you prefer|you prefer|your preference is)\s+(.{15,150})/i,
    type: 'preference',
    suggestedKind: 'personalization',
    confidence: 0.8,
  },
  // ── Causal Reasoning (WHY things happen) ──
  {
    name: 'causal_explanation',
    regex: /(?:this (?:happens|occurs|works|fails|breaks) because|the root cause (?:is|was)|(?:leads|led) to|results? in|due to the fact)\s+(.{20,300})/i,
    type: 'fact',
    suggestedKind: 'reference',
    confidence: 0.7,
  },
  // ── Rules, Constraints & Warnings ──
  {
    name: 'rule_constraint',
    regex: /(?:you (?:must|should) (?:always|never)|(?:always|never) (?:use|do|call|set|put|make|keep|run|add|remove|include)|the rule is|as a rule)\s+(.{15,200})/i,
    type: 'fact',
    suggestedKind: 'reference',
    confidence: 0.7,
  },
  {
    name: 'warning',
    regex: /(?:be careful with|watch out for|gotcha|caveat|pitfall|(?:do not|don't|never) (?:use|do|call|set|mix|combine))\s+(.{15,200})/i,
    type: 'fact',
    suggestedKind: 'reference',
    confidence: 0.65,
  },
  // ── Insights & Discoveries ──
  {
    name: 'insight',
    regex: /(?:turns out|TIL|I learned|discovered that|it appears that|apparently|the key (?:insight|takeaway|thing) is|what I (?:found|realized))\s+(.{15,200})/i,
    type: 'fact',
    suggestedKind: 'observation',
    confidence: 0.7,
  },
  {
    name: 'important_note',
    regex: /(?:note that|important(?:ly)?|remember that|keep in mind|crucial(?:ly)?|critical(?:ly)?)\s+(.{15,200})/i,
    type: 'fact',
    suggestedKind: 'reference',
    confidence: 0.5,
  },
  // ── Procedures & How-To ──
  {
    name: 'procedure',
    regex: /(?:to do this|the steps are|first,.*then|follow these steps|the (?:way|process|method) to)\s*[:.]?\s*(.{20,300})/i,
    type: 'procedure',
    suggestedKind: 'procedure',
    confidence: 0.7,
  },
  {
    name: 'solution',
    regex: /(?:the (?:fix|solution|answer|approach) (?:is|was)|to (?:solve|fix|resolve|handle) this|you can (?:try|use|do))\s+(.{20,300})/i,
    type: 'solution',
    suggestedKind: 'procedure',
    confidence: 0.7,
  },
  // ── Generalizations & Patterns ──
  {
    name: 'generalization',
    regex: /(?:in general|typically|usually|as a rule of thumb|the pattern is|(?:best|common|standard) practice is|the convention is)\s+(.{20,200})/i,
    type: 'pattern',
    suggestedKind: 'observation',
    confidence: 0.6,
  },
  // ── Comparisons & Distinctions ──
  {
    name: 'comparison',
    regex: /(?:the difference between|unlike|in contrast to|(?:is |are )(?:better|worse|faster|slower|simpler|safer) than|compared to|X vs\.? Y)\s+(.{20,200})/i,
    type: 'fact',
    suggestedKind: 'reference',
    confidence: 0.65,
  },
  // ── Definitions & Concepts ──
  {
    name: 'definition',
    regex: /(?:(?:this|that|it) (?:is called|refers to|means)|is defined as|in other words,|(?:the term|the concept of) .{3,40} (?:means|refers to|is))\s+(.{15,200})/i,
    type: 'fact',
    suggestedKind: 'reference',
    confidence: 0.6,
  },
  // ── Future Intent & Policy ──
  {
    name: 'future_intent',
    regex: /(?:from now on|going forward|in the future|from this point|henceforth|the new (?:rule|policy|standard|approach) is)\s+(.{15,200})/i,
    type: 'decision',
    suggestedKind: 'decision',
    confidence: 0.8,
  },
];

export const USER_CAPTURE_PATTERNS: CapturePattern[] = [
  // ── Explicit capture intent ──
  {
    name: 'explicit_remember',
    regex: /(?:remember|note|save|capture|store|document)\s+(?:that|this|:)?\s*(.{10,200})/i,
    type: 'preference',
    suggestedKind: 'personalization',
    confidence: 0.9,
  },
  // ── Personal preferences & identity ──
  {
    name: 'preference_statement',
    regex: /(?:i prefer|i always|i never|i like to|i don't like|my standard|my default|i want|i hate)\s+(.{10,150})/i,
    type: 'preference',
    suggestedKind: 'personalization',
    confidence: 0.85,
  },
  {
    name: 'identity_statement',
    regex: /(?:i am a|we are a|our team (?:is|does|uses)|my role is|i work (?:as|in|on|with))\s+(.{10,150})/i,
    type: 'preference',
    suggestedKind: 'personalization',
    confidence: 0.75,
  },
  // ── Process & workflow ──
  {
    name: 'workflow_statement',
    regex: /(?:my workflow|i usually|my approach|the way i|my process for|when i .{5,30} i)\s+(.{15,200})/i,
    type: 'pattern',
    suggestedKind: 'procedure',
    confidence: 0.75,
  },
  // ── Constraints & rules ──
  {
    name: 'constraint',
    regex: /(?:we can't|don't ever|avoid|never use|we don't|we must|we should always|we need to)\s+(.{10,200})/i,
    type: 'preference',
    suggestedKind: 'personalization',
    confidence: 0.8,
  },
  // ── Context & facts ──
  {
    name: 'project_context',
    regex: /(?:this project uses|our stack is|we're (?:using|on|running)|our setup is|we use|we run|we deploy)\s+(.{10,200})/i,
    type: 'fact',
    suggestedKind: 'reference',
    confidence: 0.7,
  },
  // ── Future policy / "from now on" ──
  {
    name: 'user_policy',
    regex: /(?:from now on|going forward|in the future|from this point|let's (?:always|never|start|stop))\s+(.{10,200})/i,
    type: 'preference',
    suggestedKind: 'personalization',
    confidence: 0.85,
  },
  // ── Evaluative opinions ──
  {
    name: 'opinion',
    regex: /(?:i think .{5,40} is|i believe|in my experience|i've found that|i consider)\s+(.{15,200})/i,
    type: 'preference',
    suggestedKind: 'observation',
    confidence: 0.6,
  },
];

const CONTEXT_WINDOW_CHARS = 200;

export function extractSurroundingContext(fullText: string, matchStr: string): string {
  const idx = fullText.indexOf(matchStr);
  if (idx === -1) {
    logToFile('DEBUG', 'extractSurroundingContext: match not found in full text, using match only', {
      matchPreview: matchStr.substring(0, 50),
    });
    return matchStr;
  }

  const start = Math.max(0, idx - CONTEXT_WINDOW_CHARS);
  const end = Math.min(fullText.length, idx + matchStr.length + CONTEXT_WINDOW_CHARS);
  let context = fullText.substring(start, end).trim();

  if (start > 0) context = '...' + context;
  if (end < fullText.length) context = context + '...';

  return context;
}

export function detectPatterns(content: string, patterns: CapturePattern[]): DetectedPattern[] {
  const detected: DetectedPattern[] = [];
  
  for (const pattern of patterns) {
    const match = content.match(pattern.regex);
    if (match && match[1]) {
      detected.push({
        name: pattern.name,
        type: pattern.type,
        match: match[1].trim(),
        confidence: pattern.confidence,
        suggestedKind: pattern.suggestedKind,
        context: extractSurroundingContext(content, match[0]),
      });
    }
  }
  
  return detected;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SESSION STATE - Track activity for scoring and context
// ═══════════════════════════════════════════════════════════════════════════════

interface SessionState {
  sessionId: string | null;
  knowledgeScore: number;
  filesModified: string[];
  toolsUsed: string[];
  notesCreated: string[];
  capturedPatterns: string[];  // Dedup patterns by hash
}

let sessionState: SessionState = {
  sessionId: null,
  knowledgeScore: 0,
  filesModified: [],
  toolsUsed: [],
  notesCreated: [],
  capturedPatterns: [],
};

function resetSessionState(sessionId: string): void {
  sessionState = {
    sessionId,
    knowledgeScore: 0,
    filesModified: [],
    toolsUsed: [],
    notesCreated: [],
    capturedPatterns: [],
  };
}

export function hashPattern(content: string): string {
  return content.substring(0, 50).toLowerCase().replace(/\s+/g, '');
}

interface PluginHooks {
  'experimental.chat.system.transform'?: (input: any, output: { system: string[] }) => Promise<void>;
  'experimental.chat.messages.transform'?: (input: any, output: { messages: any[] }) => Promise<void>;
  'experimental.session.compacting'?: (input: { sessionID: string }, output: { context?: string[] }) => Promise<void>;
  'tool.execute.after'?: (input: any, output: any) => Promise<void>;
  'chat.message'?: (input: any, output: any) => Promise<void>;
  event?: (input: { event: { type: string; [key: string]: any } }) => Promise<void>;
}

let noteRepo: NoteRepository | null = null;
let currentProjectName: string | null = null;
let pluginClient: any = null;

function resolveProviderUrl(cfg: OpenCodeConfig, section?: { base_url?: string }): string | null {
  return section?.base_url || cfg.provider?.base_url || null;
}

function resolveProviderKey(cfg: OpenCodeConfig, section?: { api_key?: string }): string | null {
  return section?.api_key || cfg.provider?.api_key || null;
}

function resolveEmbeddingConfig(cfg: OpenCodeConfig): EmbeddingConfig | null {
  if (!cfg.embeddings?.enabled) return null;
  const baseUrl = resolveProviderUrl(cfg, cfg.embeddings);
  const apiKey = resolveProviderKey(cfg, cfg.embeddings);
  if (!baseUrl || !apiKey || !cfg.embeddings.model) return null;
  return {
    baseUrl,
    apiKey,
    model: cfg.embeddings.model,
    dimensions: cfg.embeddings.dimensions || 1536,
  };
}

function resolveCaptureProviderUrl(cfg: OpenCodeConfig): string | null {
  return resolveProviderUrl(cfg, cfg.capture);
}

function resolveCaptureProviderKey(cfg: OpenCodeConfig): string | null {
  return resolveProviderKey(cfg, cfg.capture);
}

// ── Quality gate state ──
let qualityGateSuccessCount: number = 0;
const MAX_PENDING_CAPTURES = 10;

// Mutex: serialize quality gate calls (prevents concurrent fetch races)
let gateInFlight: Promise<QualityGateResult | null> | null = null;

// Queue for user message captures detected in messages.transform,
// processed in chat.message (which runs outside the request pipeline)
interface PendingCapture {
  pattern: DetectedPattern;
  messageText: string;
  combinedScore: number;
}
let pendingUserCaptures: PendingCapture[] = [];

// ── Injection cache ──
// Layer 1 (system.transform) caches baseline notes to avoid re-fetching every turn.
// Invalidated when KB changes (captures stored). Layer 2 (messages.transform) uses
// baselineNoteIds to deduplicate query-relevant results.
let baselineNotesCache: { block: string; noteIds: Set<string>; noteCount: number } | null = null;
let baselineInvalidated: boolean = true;  // Start dirty so first call fetches

// Get or create the NoteRepository instance
function getRepo(): NoteRepository | null {
  if (noteRepo) return noteRepo;
  
  try {
    const config = getConfig();
    noteRepo = new NoteRepository(config.vault);
    logToFile('INFO', 'Plugin: repository opened for injection', { vault: config.vault }, config);
    return noteRepo;
  } catch (error) {
    logToFile('ERROR', 'Plugin: failed to open repository', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// LLM QUALITY GATE — External API (OpenRouter-compatible)
// ═════════════════════════════════════════════════════════════════════════════

const QUALITY_GATE_SYSTEM_PROMPT = `You are a knowledge quality gate for a Zettelkasten knowledge base.
Your job is to evaluate whether a captured snippet is worth persisting as a reusable note.

Evaluate the candidate on these criteria:
1. COMPLETENESS: Is this a self-contained idea, or a fragment that won't make sense later?
2. REUSABILITY: Would this be useful in future sessions/conversations?
3. UNIQUENESS: Does this contain specific, non-obvious information?
4. ACTIONABILITY: Can someone act on or apply this knowledge?

Respond with ONLY valid JSON (no markdown, no backticks):
{
  "worthy": true or false,
  "title": "concise descriptive title (max 80 chars)",
  "summary": "1-2 sentence summary of the knowledge",
  "kind": "personalization" | "decision" | "procedure" | "observation" | "reference",
  "reason": "brief explanation of why this is/isn't worth keeping"
}

Reject: fragments, context-dependent statements, obvious facts, duplicate concepts.
Accept: decisions with rationale, user preferences, reusable procedures, non-obvious insights.`;

interface QualityGateResult {
  worthy: boolean;
  title: string;
  summary: string;
  kind: string;
  reason: string;
}

async function _callQualityGateImpl(candidate: {
  type: string;
  match: string;
  context: string;
  source: 'user' | 'agent' | 'tool';
}): Promise<QualityGateResult | null> {
  const cfg = getOpenCodeConfig();
  if (!cfg?.capture?.auto) return null;

  const baseUrl = resolveCaptureProviderUrl(cfg);
  const apiKey = resolveCaptureProviderKey(cfg);
  const model = cfg.capture?.model;

  if (!baseUrl || !apiKey || !model) {
    logToFile('WARN', 'Plugin: auto-capture enabled but provider not fully configured', {
      hasBaseUrl: !!baseUrl, hasApiKey: !!apiKey, hasModel: !!model,
    }, getConfig());
    return null;
  }
  
  const maxCalls = cfg.capture?.max_calls_per_session ?? 20;
  if (qualityGateSuccessCount >= maxCalls) {
    logToFile('DEBUG', 'Plugin: quality gate call limit reached', {
      successCount: qualityGateSuccessCount, max: maxCalls
    }, getConfig());
    return null;
  }
  
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const candidateText = [
    `Type: ${candidate.type}`,
    `Source: ${candidate.source}`,
    `Match: ${candidate.match}`,
    `Context: ${candidate.context}`,
  ].join('\n');

  const timeoutMs = 15000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${normalizedBaseUrl}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: QUALITY_GATE_SYSTEM_PROMPT },
          { role: 'user', content: candidateText },
        ],
        temperature: 0,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logToFile('ERROR', 'Plugin: quality gate API error', {
        status: response.status,
        body: body.slice(0, 500),
      }, getConfig());
      return null;
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const responseText = data.choices?.[0]?.message?.content ?? '';

    if (!responseText) {
      logToFile('WARN', 'Plugin: quality gate returned empty response', {}, getConfig());
      return null;
    }

    const cleaned = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const result: QualityGateResult = JSON.parse(cleaned);

    qualityGateSuccessCount++;

    logToFile('INFO', 'Plugin: quality gate result', {
      worthy: result.worthy,
      title: result.title,
      kind: result.kind,
      reason: result.reason,
      successCount: qualityGateSuccessCount,
    }, getConfig());

    return result;
  } catch (error) {
    const isAbort = error instanceof DOMException && error.name === 'AbortError';
    logToFile('ERROR', 'Plugin: quality gate call failed', {
      error: error instanceof Error ? error.message : String(error),
      timedOut: isAbort,
    }, getConfig());
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Public entry point: serialized, never throws
async function callQualityGate(candidate: {
  type: string;
  match: string;
  context: string;
  source: 'user' | 'agent' | 'tool';
}): Promise<QualityGateResult | null> {
  // Serialize: wait for any in-flight call to finish first
  if (gateInFlight) {
    try {
      await gateInFlight;
    } catch {
      // Previous call failed, that's fine \u2014 we'll try ours
    }
  }
  
  // Run our call under the mutex
  const promise = _callQualityGateImpl(candidate).catch((error) => {
    logToFile('ERROR', 'Plugin: quality gate call failed', {
      error: error instanceof Error ? error.message : String(error),
      successCount: qualityGateSuccessCount,
    }, getConfig());
    return null;
  });
  
  gateInFlight = promise;
  
  try {
    return await promise;
  } finally {
    // Clear mutex only if we're still the current holder
    if (gateInFlight === promise) {
      gateInFlight = null;
    }
  }
}

// Fetch relevant notes for injection using balanced selection
function fetchNotesForInjection(maxNotes: number = 10): NoteMetadata[] {
  const repo = getRepo();
  if (!repo) return [];
  
  try {
    const config = getConfig();
    
    // Use the repository's smart selection method
    const notes = repo.getRelevantNotesForContext(maxNotes);
    
    logToFile('INFO', 'Plugin: fetched notes for injection', { 
      count: notes.length,
      kinds: notes.reduce((acc, n) => {
        acc[n.kind] = (acc[n.kind] || 0) + 1;
        return acc;
      }, {} as Record<string, number>)
    }, config);
    
    return notes;
  } catch (error) {
    logToFile('ERROR', 'Plugin: failed to fetch notes for injection', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function fireAndForgetEmbedding(repo: NoteRepository, noteId: string, title: string, summary: string, content: string): void {
  const embConfig = getEmbeddingConfigCached();
  if (!embConfig) return;
  const text = buildEmbeddingText(title, summary, content);
  generateEmbedding(text, embConfig).then(result => {
    if (result) repo.storeEmbedding(noteId, result.embedding, result.model);
  }).catch((error) => {
    logToFile('WARN', 'Plugin: embedding generation failed', {
      noteId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

let cachedEmbeddingConfig: EmbeddingConfig | null | undefined = undefined;

function getEmbeddingConfigCached(): EmbeddingConfig | null {
  if (cachedEmbeddingConfig !== undefined) return cachedEmbeddingConfig;
  const cfg = getOpenCodeConfig();
  cachedEmbeddingConfig = cfg ? resolveEmbeddingConfig(cfg) : null;
  return cachedEmbeddingConfig;
}

async function searchRelevantNotes(query: string, maxNotes: number = 5): Promise<NoteMetadata[]> {
  const repo = getRepo();
  if (!repo || !query || query.length < 3) return [];
  
  try {
    const config = getConfig();
    const embConfig = getEmbeddingConfigCached();

    let queryEmbedding: number[] | null = null;
    if (embConfig) {
      const embResult = await generateEmbedding(query, embConfig);
      queryEmbedding = embResult?.embedding || null;
    }

    if (queryEmbedding) {
      const results = repo.searchHybrid(query, queryEmbedding, { limit: maxNotes });
      logToFile('DEBUG', 'Plugin: hybrid context search', { 
        query: query.substring(0, 50), 
        found: results.length,
        mode: 'hybrid',
      }, config);
      return results;
    }

    // Fallback: keyword extraction + FTS5
    const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 
      'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
      'may', 'might', 'must', 'can', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by',
      'from', 'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
      'between', 'under', 'again', 'further', 'then', 'once', 'here', 'there', 'when',
      'where', 'why', 'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
      'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
      'and', 'but', 'if', 'or', 'because', 'until', 'while', 'about', 'against',
      'i', 'me', 'my', 'myself', 'we', 'our', 'you', 'your', 'he', 'she', 'it', 'they',
      'what', 'which', 'who', 'whom', 'this', 'that', 'these', 'those', 'am', 'help']);
    
    const keywords = query.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w))
      .slice(0, 5);
    
    if (keywords.length === 0) return [];
    
    const searchQuery = keywords.join(' OR ');
    const results = repo.search(searchQuery, { limit: maxNotes * 2 });
    
    const sorted = results.sort((a, b) => {
      if (a.status === 'permanent' && b.status !== 'permanent') return -1;
      if (b.status === 'permanent' && a.status !== 'permanent') return 1;
      return (b.access_count || 0) - (a.access_count || 0);
    });
    
    logToFile('DEBUG', 'Plugin: FTS-only context search', { 
      query: searchQuery, 
      found: sorted.length,
      mode: 'fts5',
    }, config);
    
    return sorted.slice(0, maxNotes);
  } catch (error) {
    logToFile('ERROR', 'Plugin: context search failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

// Format notes as XML for injection into system prompt
function formatNotesForSystemPrompt(notes: NoteMetadata[], label: string = 'relevant'): string {
  if (notes.length === 0) return '';
  
  let output = '\n<knowledge-context>\n';
  output += '<!-- Auto-injected from open-zk-kb knowledge base -->\n';
  output += `<!-- ${notes.length} ${label} notes for this session -->\n\n`;
  
  for (const note of notes) {
    output += renderNoteForAgent(note) + '\n';
  }
  
  output += '</knowledge-context>\n';
  return output;
}



export function scoreContent(content: string): number {
  let score = 0;
  const lower = content.toLowerCase();

  // Strong personal signals (+3)
  if (lower.match(/\b(i want|i prefer|i always|i never|my standard|my default|i don't want|i hate|from now on|going forward)\b/)) {
    score += 3;
  }

  // Decision language (+2)
  if (lower.match(/\b(decide|decided|choice|chose|option|prefer|recommend|suggest|trade.?off|opted|selected)\b/)) {
    score += 2;
  }

  // Causal / explanatory language (+2)
  if (lower.match(/\b(because|therefore|the reason|as a result|leads to|results in|due to|caused by|root cause)\b/)) {
    score += 2;
  }

  // Generalizable knowledge (+2)
  if (lower.match(/\b(pattern|workflow|approach|method|process|procedure|principle|convention|framework|best practice|rule of thumb)\b/)) {
    score += 2;
  }

  // Insight / discovery language (+2)
  if (lower.match(/\b(turns out|realized|discovered|learned|key insight|takeaway|surprisingly|interestingly|important to note)\b/)) {
    score += 2;
  }

  // Evaluative / comparative language (+1)
  if (lower.match(/\b(better than|worse than|faster|slower|simpler|safer|compared to|unlike|in contrast|the difference)\b/)) {
    score += 1;
  }

  // Imperative / rule language (+1)
  if (lower.match(/\b(always|never|must|should|avoid|make sure|ensure|be careful|watch out|don't forget)\b/)) {
    score += 1;
  }

  // Definitional language (+1)
  if (lower.match(/\b(is defined as|means that|refers to|in other words|is called|is essentially)\b/)) {
    score += 1;
  }

  return Math.min(score, 10);
}

export default async function plugin(input: { 
  client: any; 
  project: any; 
  directory: string; 
  worktree: string; 
  serverUrl: URL;
  $: any;
}): Promise<PluginHooks> {
  const { client } = input;
  pluginClient = client;
  
  currentProjectName = path.basename(input.worktree || input.directory || '') || null;
  
  logToFile('INFO', 'Plugin: initialized', {
    projectName: currentProjectName,
    worktree: input.worktree,
    directory: input.directory,
  }, getConfig());
  
  return {
    event: async ({ event }) => {
      const config = getConfig();
      
      if (event.type === 'session.created') {
        const sessionId = (event as any).properties?.sessionID || Date.now().toString();
        resetSessionState(sessionId);
        qualityGateSuccessCount = 0;
        gateInFlight = null;
        pendingUserCaptures = [];
        baselineNotesCache = null;
        baselineInvalidated = true;
        cachedEmbeddingConfig = undefined;
        
        const cfg = getOpenCodeConfig();
        
        logToFile('INFO', 'Plugin: session started', { sessionId }, config);
        
        if (cfg?.capture?.auto) {
          await client.app.log({
            body: {
              service: 'open-zk-kb',
              level: 'info',
              message: '╔════════════════════════════════════════════════════════════╗',
            },
          });
          await client.app.log({
            body: {
              service: 'open-zk-kb',
              level: 'info',
              message: '║  🔍 open-zk-kb: Knowledge capture active                    ║',
            },
          });
          await client.app.log({
            body: {
              service: 'open-zk-kb',
              level: 'info',
              message: '║  Preferences & patterns will be captured automatically      ║',
            },
          });
          await client.app.log({
            body: {
              service: 'open-zk-kb',
              level: 'info',
              message: '╚════════════════════════════════════════════════════════════╝',
            },
          });
        }
      }
      
      if (event.type === 'session.deleted' || event.type === 'session.compacted') {
        logToFile('INFO', 'Plugin: session ended', {
          sessionId: sessionState.sessionId,
          knowledgeScore: sessionState.knowledgeScore,
          filesModified: sessionState.filesModified.length,
          toolsUsed: sessionState.toolsUsed.length,
          notesCreated: sessionState.notesCreated.length,
        }, config);
      }
    },
    
    'experimental.chat.system.transform': async (_input, output) => {
      const cfg = getOpenCodeConfig();
      const config = getConfig();
      
      if (!output.system || !Array.isArray(output.system)) {
        return;
      }
      
      const injectionEnabled = cfg?.injection?.enabled ?? true;
      const maxNotes = cfg?.injection?.max_notes ?? 10;
      
      if (injectionEnabled) {
        try {
          // Use cached baseline if available and not invalidated
          if (!baselineNotesCache || baselineInvalidated) {
            const notes = fetchNotesForInjection(maxNotes);
            if (notes.length > 0) {
              baselineNotesCache = {
                block: formatNotesForSystemPrompt(notes),
                noteIds: new Set(notes.map(n => n.id)),
                noteCount: notes.length,
              };
            } else {
              baselineNotesCache = { block: '', noteIds: new Set(), noteCount: 0 };
            }
            baselineInvalidated = false;
            logToFile('INFO', 'Plugin: refreshed baseline injection cache', {
              noteCount: baselineNotesCache.noteCount,
            }, config);
          }
          
          if (baselineNotesCache.block) {
            output.system.push(baselineNotesCache.block);
          }
        } catch (error) {
          logToFile('ERROR', 'Plugin: failed to inject knowledge context', {
            error: error instanceof Error ? error.message : String(error),
          }, config);
        }
      }
      
      if (cfg?.injection?.inject_capture_status) {
        output.system.push(
          '',
          '🔍 open-zk-kb: Knowledge capture active — Your preferences and patterns will be captured for future sessions.',
          ''
        );
      }
    },
    
    'tool.execute.after': async (input, output) => {
      const cfg = getOpenCodeConfig();
      const config = getConfig();
      const repo = getRepo();
      
      if (!cfg?.capture?.auto || !repo) {
        return;
      }
      
      const toolName = input.tool || '';
      const result = output.output || '';
      const title = output.title || '';
      const args = input.args || {};
      
      // Track tool usage for session state
      if (!sessionState.toolsUsed.includes(toolName)) {
        sessionState.toolsUsed.push(toolName);
      }
      
      // Track file modifications
      const filePath = args.filePath || args.path || '';
      if (filePath && (toolName === 'write' || toolName === 'edit' || toolName === 'create')) {
        if (!sessionState.filesModified.includes(filePath)) {
          sessionState.filesModified.push(filePath);
          sessionState.knowledgeScore += 2;
        }
      }
      
      // ── Documentation capture from external reference tools only ──
      const DOCUMENTATION_TOOLS = new Set([
        'webfetch',
        'context7_query-docs', 'context7_resolve-library-id',
        'ddg-search_search', 'ddg-search_fetch_content',
      ]);
      
      // Only capture from documentation-producing tools (not read/grep/glob)
      if (!DOCUMENTATION_TOOLS.has(toolName)) {
        return;
      }
      
      // Skip if result is too short or too long
      if (result.length < 200 || result.length > 50000) {
        return;
      }
      
      // Skip sensitive files
      const sensitivePatterns = ['.env', 'credentials', 'secret', 'password', 'token', 'key', 'auth'];
      const lowerPath = filePath.toLowerCase();
      if (sensitivePatterns.some(p => lowerPath.includes(p))) {
        logToFile('DEBUG', 'Plugin: skipped sensitive file', { toolName, filePath }, config);
        return;
      }
      
      // Check if this is documentation-worthy content
      const isDocumentation = 
        result.includes('##') ||
        result.includes('```') ||
        result.includes('function') ||
        result.includes('class') ||
        result.includes('interface') ||
        result.includes('Example') ||
        result.includes('Usage') ||
        result.includes('API');
      
      if (!isDocumentation && toolName !== 'webfetch') {
        return;
      }
      
      const captureBaseUrl = cfg ? resolveCaptureProviderUrl(cfg) : null;
      const captureApiKey = cfg ? resolveCaptureProviderKey(cfg) : null;
      if (!captureBaseUrl || !captureApiKey || !cfg?.capture?.model) return;
      
      try {
        const toolOutput = result;
        const truncatedContent = toolOutput.length > 3000 
          ? toolOutput.substring(0, 3000) + '\n\n[...truncated...]'
          : toolOutput;
        
        const gateResult = await callQualityGate({
          type: 'documentation',
          match: title || path.basename(filePath) || toolName,
          context: truncatedContent.substring(0, 800),
          source: 'tool',
        });
        
        if (gateResult && !gateResult.worthy) {
          logToFile('INFO', 'Plugin: quality gate rejected tool capture', {
            toolName,
            reason: gateResult.reason,
          }, config);
          return;
        }
        
        if (!gateResult) {
          logToFile('WARN', 'Plugin: quality gate returned null for tool capture, skipping', {
            toolName,
          }, config);
          return;
        }
        
        const noteTitle = gateResult.title;
        const noteContent = `# ${noteTitle}\n\n**Source:** ${toolName}\n**Path/URL:** ${filePath || title || 'N/A'}\n**Captured:** ${new Date().toISOString()}\n\n---\n\n${truncatedContent}`;
        
        const storeResult = repo.store({
          title: noteTitle.substring(0, 100),
          content: noteContent,
          kind: toCanonicalKind(gateResult.kind),
          status: 'fleeting' as NoteStatus,
          tags: [
            'auto-captured',
            'llm-verified',
            `source/${toolName}`,
            'documentation',
            ...(currentProjectName ? [`project:${currentProjectName}`] : []),
          ],
          summary: gateResult.summary,
          guidance: `Verified reference from ${toolName} \u2014 apply when relevant.`,
        });
        
        fireAndForgetEmbedding(repo, storeResult.id, noteTitle, gateResult.summary, truncatedContent);
        sessionState.notesCreated.push(storeResult.id);
        sessionState.knowledgeScore += 3;
        baselineInvalidated = true;
        
        logToFile('INFO', 'Plugin: captured documentation from tool', {
          noteId: storeResult.id,
          toolName,
          filePath: filePath || title,
          contentLength: toolOutput.length,
        }, config);
        
        if (client.tui?.showToast) {
          client.tui.showToast({
            body: {
              message: `\ud83d\udcda Captured: ${noteTitle.substring(0, 40)}...`,
              variant: 'info',
              duration: 2000,
            }
          });
        }
      } catch (error) {
        logToFile('ERROR', 'Plugin: failed to capture tool output', {
          error: error instanceof Error ? error.message : String(error),
          toolName,
        }, config);
      }
    },
    
    'chat.message': async (input, output) => {
      const cfg = getOpenCodeConfig();
      const config = getConfig();
      const repo = getRepo();
      
      if (!cfg?.capture?.auto || !repo) {
        return;
      }
      
      // Drain pending user captures from messages.transform
      // (messages.transform can't call quality gate without deadlocking,
      //  so it queues candidates here where we're outside the request pipeline)
      if (pendingUserCaptures.length > 0) {
        const captures = [...pendingUserCaptures];
        pendingUserCaptures.length = 0;
        
        for (const capture of captures) {
          const pHash = hashPattern(capture.pattern.match);
          if (sessionState.capturedPatterns.includes(pHash)) continue;
          
          try {
            const noteContent = capture.pattern.context || capture.pattern.match;
            const gateResult = await callQualityGate({
              type: capture.pattern.type,
              match: capture.pattern.match,
              context: noteContent,
              source: 'user',
            });
            
            if (gateResult && !gateResult.worthy) {
              logToFile('INFO', 'Plugin: quality gate rejected queued user capture', {
                pattern: capture.pattern.name, reason: gateResult.reason,
              }, config);
              continue;
            }
            
            if (!gateResult) {
              logToFile('WARN', 'Plugin: quality gate returned null for queued capture, skipping', {
                pattern: capture.pattern.name,
              }, config);
              continue;
            }
            
            const result = repo.store({
              title: gateResult.title,
              content: noteContent,
              kind: toCanonicalKind(gateResult.kind),
              status: 'fleeting' as NoteStatus,
              tags: [
                'auto-captured',
                'llm-verified',
                'source/user',
                `type/${capture.pattern.type}`,
                ...(currentProjectName ? [`project:${currentProjectName}`] : []),
              ],
              summary: gateResult.summary,
              guidance: 'User-stated preference \u2014 apply in future interactions.',
            });
            
            fireAndForgetEmbedding(repo, result.id, gateResult.title, gateResult.summary, noteContent);
            sessionState.capturedPatterns.push(pHash);
            sessionState.notesCreated.push(result.id);
            sessionState.knowledgeScore += capture.combinedScore;
            baselineInvalidated = true;
            
            logToFile('INFO', 'Plugin: processed queued user capture', {
              noteId: result.id,
              pattern: capture.pattern.name,
              kind: gateResult.kind,
              score: capture.combinedScore,
              preview: gateResult.title.substring(0, 50),
            }, config);
            
            if (pluginClient?.tui?.showToast) {
              pluginClient.tui.showToast({
                body: {
                  message: `\ud83d\udca1 Captured: ${gateResult.title.substring(0, 50)}`,
                  variant: 'info',
                  duration: 3000,
                }
              });
            }
          } catch (error) {
            logToFile('ERROR', 'Plugin: failed to process queued user capture', {
              error: error instanceof Error ? error.message : String(error),
              pattern: capture.pattern.name,
            }, config);
          }
        }
      }
      const autoThreshold = cfg.capture?.threshold ?? 7;
      const captureUrl = cfg ? resolveCaptureProviderUrl(cfg) : null;
      const captureKey = cfg ? resolveCaptureProviderKey(cfg) : null;
      
      if (!captureUrl || !captureKey || !cfg?.capture?.model) return;
      
      const messageText = output.parts
        ?.filter((p: any) => p.type === 'text')
        .map((p: any) => p.text)
        .join(' ') || '';
      
      if (!messageText || messageText.length < 20) return;
      
      // Determine if this is a user message or agent response
      const isUserMessage = input.agent === undefined || input.agent === 'user';
      const patterns = isUserMessage ? USER_CAPTURE_PATTERNS : AGENT_RESPONSE_PATTERNS;
      
      // Detect patterns in the message
      const detected = detectPatterns(messageText, patterns);
      
      for (const pattern of detected) {
        // Dedup: skip if already captured in this session
        const patternHash = hashPattern(pattern.match);
        if (sessionState.capturedPatterns.includes(patternHash)) {
          continue;
        }
        
        // Calculate score based on pattern confidence + content scoring
        const contentScore = scoreContent(messageText);
        const combinedScore = Math.round(pattern.confidence * 10 + contentScore);
        
        // Only auto-capture if above threshold
        if (combinedScore < autoThreshold) {
          logToFile('DEBUG', 'Plugin: pattern below threshold', {
            pattern: pattern.name,
            score: combinedScore,
            threshold: autoThreshold,
          }, config);
          continue;
        }
        
        try {
          const noteContent = pattern.context || pattern.match;
          const gateResult = await callQualityGate({
            type: pattern.type,
            match: pattern.match,
            context: noteContent,
            source: isUserMessage ? 'user' : 'agent',
          });
          
          if (gateResult && !gateResult.worthy) {
            logToFile('INFO', 'Plugin: quality gate rejected capture', {
              pattern: pattern.name,
              reason: gateResult.reason,
            }, config);
            continue;
          }
          
          if (!gateResult) {
            // LLM gate failed (timeout, rate limit) — skip rather than store junk
            logToFile('WARN', 'Plugin: quality gate returned null, skipping capture', {
              pattern: pattern.name,
            }, config);
            continue;
          }
          
          const noteTitle = gateResult.title;
          const noteSummary = gateResult.summary;
          const noteKind = toCanonicalKind(gateResult.kind);
          const noteGuidance = isUserMessage
            ? 'User-stated preference \u2014 apply in future interactions.'
            : `Verified ${gateResult.kind} \u2014 apply when relevant.`;
          const noteStatus: NoteStatus = 'fleeting';
          
          const result = repo.store({
            title: noteTitle,
            content: noteContent,
            kind: noteKind,
            status: noteStatus,
            tags: [
              'auto-captured',
              'llm-verified',
              `source/${isUserMessage ? 'user' : 'agent'}`,
              `type/${pattern.type}`,
              ...(currentProjectName ? [`project:${currentProjectName}`] : []),
            ],
            summary: noteSummary,
            guidance: noteGuidance,
          });
          const noteId = result.id;
          
          fireAndForgetEmbedding(repo, noteId, noteTitle, noteSummary, noteContent);
          sessionState.capturedPatterns.push(patternHash);
          sessionState.notesCreated.push(noteId);
          sessionState.knowledgeScore += combinedScore;
          baselineInvalidated = true;
          
          logToFile('INFO', 'Plugin: auto-captured from chat', {
            noteId,
            pattern: pattern.name,
            kind: noteKind,
            confidence: pattern.confidence,
            score: combinedScore,
            llmGated: true,
            isUserMessage,
            preview: noteTitle.substring(0, 50),
          }, config);
          
          // Notify via client if available
          if (client.tui?.showToast) {
            client.tui.showToast({
              body: {
                message: `💡 Captured: ${noteTitle.substring(0, 50)}`,
                variant: 'info',
                duration: 3000,
              }
            });
          }
        } catch (error) {
          logToFile('ERROR', 'Plugin: failed to auto-capture', {
            error: error instanceof Error ? error.message : String(error),
            pattern: pattern.name,
          }, config);
        }
      }
    },
    
    // Context-aware knowledge injection + user message pattern detection
    'experimental.chat.messages.transform': async (_input, output) => {
      const cfg = getOpenCodeConfig();
      const config = getConfig();
      const repo = getRepo();
      
      try {
        // Find the most recent user message
        const messages = output.messages || [];
        const userMessages = messages.filter((m: any) => m.info?.role === 'user');
        const lastUserMessage = userMessages[userMessages.length - 1];
        
        if (!lastUserMessage) return;
        
        // Extract text from the user message
        const userText = lastUserMessage.parts
          ?.filter((p: any) => p.type === 'text')
          .map((p: any) => p.text)
          .join(' ') || '';
        
        if (userText.length < 10) return;
        
        // ── Context-aware injection ──
        const contextAwareEnabled = cfg?.injection?.context_aware ?? true;
        if (contextAwareEnabled) {
          let contextNotes = await searchRelevantNotes(userText, 5);
          
          // Deduplicate: remove notes already in the baseline injection (Layer 1)
          if (baselineNotesCache && baselineNotesCache.noteIds.size > 0) {
            contextNotes = contextNotes.filter(n => !baselineNotesCache!.noteIds.has(n.id));
          }
          
          if (contextNotes.length > 0) {
            const contextBlock = formatNotesForSystemPrompt(contextNotes, 'query-relevant');
            output.messages.unshift({
              info: { role: 'system', id: 'kb-context' },
              parts: [{ type: 'text', text: contextBlock }]
            });
            
            logToFile('INFO', 'Plugin: injected context-aware notes', { 
              query: userText.substring(0, 50),
              noteCount: contextNotes.length 
            }, config);
          }
        }
        
        // ── User message pattern detection ──
        // (chat.message hook only fires for agent messages, so we detect user patterns here)
        if (cfg?.capture?.auto && repo && userText.length >= 20) {
            const captureUrl = cfg ? resolveCaptureProviderUrl(cfg) : null;
            const captureKey = cfg ? resolveCaptureProviderKey(cfg) : null;
            if (!captureUrl || !captureKey || !cfg?.capture?.model) {
            logToFile('DEBUG', 'Plugin: skipping user capture detection (provider not configured)', {}, config);
          } else {
            const autoThreshold = cfg.capture?.threshold ?? 7;
            const detected = detectPatterns(userText, USER_CAPTURE_PATTERNS);
            
            logToFile('INFO', 'Plugin: user message pattern scan', {
              textLength: userText.length,
              patternsFound: detected.length,
              patterns: detected.map(d => d.name),
            }, config);
            
            for (const pattern of detected) {
              const patternHash = hashPattern(pattern.match);
              if (sessionState.capturedPatterns.includes(patternHash)) continue;
              
              const contentScore = scoreContent(userText);
              const combinedScore = Math.round(pattern.confidence * 10 + contentScore);
              
              if (combinedScore < autoThreshold) {
                logToFile('INFO', 'Plugin: user pattern below threshold', {
                  pattern: pattern.name, score: combinedScore, threshold: autoThreshold,
                }, config);
                continue;
              }
              
              // Queue for quality gate processing in chat.message hook
              // (calling quality gate here would deadlock the request pipeline)
              if (pendingUserCaptures.length >= MAX_PENDING_CAPTURES) {
                logToFile('DEBUG', 'Plugin: pending capture queue full, dropping oldest', {}, config);
                pendingUserCaptures.shift();
              }
              pendingUserCaptures.push({ pattern, messageText: userText, combinedScore });
              logToFile('INFO', 'Plugin: queued user capture for quality gate', {
                pattern: pattern.name, score: combinedScore, queueSize: pendingUserCaptures.length,
              }, config);
            }
          }
        }
      } catch (error) {
        logToFile('ERROR', 'Plugin: messages.transform failed', {
          error: error instanceof Error ? error.message : String(error),
        }, config);
      }
    },
    
    // Session compaction - add KB activity summary to preserved context
    'experimental.session.compacting': async (_input: { sessionID: string }, output: { context?: string[] }) => {
      const config = getConfig();
      
      // Only add context if there was meaningful KB activity
      if (sessionState.notesCreated.length === 0 && sessionState.knowledgeScore < 5) {
        return;
      }
      
      output.context = output.context || [];
      
      let summaryLines = ['## Knowledge Base Activity (this session)'];
      summaryLines.push('');
      summaryLines.push(`- **Knowledge score:** ${sessionState.knowledgeScore}`);
      summaryLines.push(`- **Files modified:** ${sessionState.filesModified.length}`);
      summaryLines.push(`- **Tools used:** ${sessionState.toolsUsed.length}`);
      
      if (sessionState.notesCreated.length > 0) {
        summaryLines.push(`- **Notes captured:** ${sessionState.notesCreated.length}`);
        summaryLines.push('');
        summaryLines.push('### Captured Notes');
        const repo = getRepo();
        for (const noteId of sessionState.notesCreated.slice(0, 10)) {
          const note = repo?.getById(noteId);
          if (note) {
            const summary = note.summary || note.title;
            summaryLines.push(`- ${noteId}: ${summary}`);
          } else {
            summaryLines.push(`- ${noteId}`);
          }
        }
        if (sessionState.notesCreated.length > 10) {
          summaryLines.push(`- ... and ${sessionState.notesCreated.length - 10} more`);
        }
      }
      
      output.context.push(summaryLines.join('\n'));
      
      logToFile('INFO', 'Plugin: added KB summary to compaction context', {
        sessionId: sessionState.sessionId,
        notesCreated: sessionState.notesCreated.length,
        knowledgeScore: sessionState.knowledgeScore,
      }, config);
    },
  };
}
