import { SharedRedis, RedisLease } from './redis.ts';
/**
 * The daily suggestion pool behind `GET /v1/suggestions`.
 *
 * WHAT THIS IS. The chat empty state shows a handful of starter prompts. They
 * used to be four strings hardcoded in Welcome.tsx that never changed. This
 * module owns that list instead: a curated pool that ships with the server, and
 * a scheduler that once a day tries to replace it with a freshly generated one.
 *
 * WHY A SCHEDULER AND NOT LAZY GENERATION. `GET /v1/suggestions` is a pure,
 * synchronous read of `store` below. It never awaits, never calls a model, and
 * takes no parameter that could cause one to be called - there is deliberately
 * no `date`, no `refresh`, no cache key a client can influence. A million
 * requests cost exactly what one costs. Generation happens on a timer owned by
 * this process, so the public endpoint cannot be used as an amplifier against
 * the free providers below, and a traffic spike cannot turn into a spend spike.
 *
 * WHY NO API KEY. Every generator in KEYLESS_GENERATORS answers with no
 * Authorization header at all. That is not a default that happens to be empty:
 * there is no key parameter in this file, nothing here reads process.env or the
 * config for one, and `verify:relay` greps this file to assert it stays that
 * way. The app's promise is "no account, no API key" and the suggestion path
 * has to hold to it too.
 *
 * WHY THE STORE IS MEMORY-ONLY. The production systemd unit mounts the
 * filesystem read-only (ProtectSystem=strict) and there is no database
 * anywhere in this architecture. A restart rebuilds from CURATED and the next
 * tick regenerates. That is the intended behaviour, not a limitation worked
 * around.
 *
 * DEPENDENCIES. Node built-ins only - global fetch and setInterval. verify:relay
 * fails the build on a fourth server npm dependency, so nothing may be added.
 */

export type DayPart = "morning" | "afternoon" | "evening" | "night";
export type Capability = "vision" | "tools" | "reasoning";
/** A suggestion tagged "any" is shown at every hour. */
export type WhenTag = DayPart | "any";

export const DAY_PARTS: DayPart[] = ["morning", "afternoon", "evening", "night"];

export interface Suggestion {
  id: string;
  /** Rendered as the card's bold line. */
  title: string;
  /** Sent verbatim to the model when the card is clicked. */
  prompt: string;
  /** Model capabilities this prompt needs. Empty means it works on anything. */
  needs: Capability[];
  when: WhenTag[];
}

/** What the route hands back. Tags are internal and are not exposed. */
export interface PublicSuggestion {
  id: string;
  title: string;
  prompt: string;
}

/**
 * Length budgets, set by the card's own geometry rather than by taste: the
 * preview span is `line-clamp-2` at text-xs inside a max-w-2xl two-column grid,
 * which shows roughly 110-140 characters. A longer prompt is not wrong, it is
 * just invisible past the clamp, so generated ones are held to it.
 */
const MAX_TITLE = 32;
const MAX_PROMPT = 140;

/** How many the route returns. Four are shown; the rest feed the shuffle button. */
const SERVE_COUNT = 12;

/**
 * How many to ask for, and the floor below which a batch is not worth
 * preferring over CURATED.
 *
 * ASK is deliberately modest. Every provider in the chain caps output well
 * below its advertised max_tokens - measured: a request for 40 entries came
 * back from Pollinations with finish_reason "length" after 705 characters,
 * roughly five entries in. Asking for a number that actually fits turns a
 * truncated, wasted call into a complete one.
 *
 * MIN is low for a different reason: the served pool is the generated batch
 * PLUS all 41 curated entries, so eight fresh prompts is a real daily refresh,
 * not a thin one. Setting it higher would reject usable batches and leave the
 * pool purely curated more often.
 */
const ASK_COUNT = 16;
const MIN_GENERATED = 8;

/**
 * Per-attempt budget. Generous on purpose: generation runs on the scheduler,
 * never on the request path, so nobody is waiting on it and the only cost of a
 * long timeout is a slightly later refresh. It was 20s and that was measurably
 * too tight - llm7's mistral-Nemo returns a complete, valid batch in about 22
 * seconds, so a 20s budget threw away the one provider that was working.
 */
const GENERATE_TIMEOUT_MS = 45_000;
const DISCOVER_TIMEOUT_MS = 5_000;
const TICK_MS = 3_600_000;

/**
 * The default pool, and the only prompt copy in the product - the client ships
 * none. This is what serves before the first generation lands, whenever all
 * four providers fail, and forever on a deployment with no outbound network.
 * It therefore has to stand on its own rather than read as placeholder text.
 *
 * Tagging notes: most entries are `needs: []` on purpose, because the majority
 * of users arrive on a small keyless or local model that can neither see images
 * nor call tools. `when` skews to "any" for the same reason - a pool that is
 * mostly time-gated leaves thin sets at the edges of the day.
 */
export const CURATED: Suggestion[] = [
  // ---------------------------------------------------------------- writing
  { id: "c-email-followup", title: "Chase a stalled thread", prompt: "Write a short, friendly email asking for a status update on something I raised two weeks ago and never heard back about.", needs: [], when: ["morning", "afternoon"] },
  { id: "c-say-no", title: "Decline without burning it", prompt: "Help me turn down a request from a colleague politely, without sounding like I'm making excuses.", needs: [], when: ["any"] },
  { id: "c-shorter", title: "Cut this in half", prompt: "Take a paragraph I'll paste and cut it to half the length without losing anything that matters.", needs: [], when: ["any"] },
  { id: "c-plain-english", title: "Strip the jargon", prompt: "Rewrite something I'll paste in plain English, as if explaining it to a smart person outside my field.", needs: [], when: ["any"] },
  { id: "c-tone-check", title: "Does this read badly?", prompt: "Read a message I'm about to send and tell me honestly how it comes across, then suggest a better version.", needs: [], when: ["any"] },
  { id: "c-bad-news", title: "Deliver bad news well", prompt: "Help me tell a client that a deadline is slipping, taking responsibility without over-apologising.", needs: [], when: ["morning", "afternoon"] },

  // ------------------------------------------------------------------- code
  { id: "c-explain-code", title: "Explain this code", prompt: "Walk me through what a snippet I'll paste actually does, step by step, and flag anything surprising in it.", needs: [], when: ["any"] },
  { id: "c-regex", title: "Build a regex", prompt: "Help me write a regular expression, then explain each part so I can change it later without guessing.", needs: [], when: ["any"] },
  { id: "c-review-diff", title: "Review my change", prompt: "Review a diff I'll paste for bugs, edge cases and anything a careful reviewer would flag. Be blunt.", needs: [], when: ["any"] },
  { id: "c-name-things", title: "Name this properly", prompt: "I'll describe a function and its job. Suggest five names for it and say which one you'd pick and why.", needs: [], when: ["any"] },
  { id: "c-error", title: "Decode a stack trace", prompt: "I'll paste an error and the code around it. Work out the likely cause rather than listing generic fixes.", needs: [], when: ["any"] },
  { id: "c-sql", title: "Write the query", prompt: "Help me write a SQL query from a description of my tables, then explain how to check it returns what I meant.", needs: [], when: ["any"] },
  { id: "c-test-cases", title: "What should I test?", prompt: "I'll describe a function. List the test cases worth writing, especially the edge cases I'd forget.", needs: [], when: ["any"] },
  { id: "c-refactor", title: "Untangle this function", prompt: "Take a long function I'll paste and suggest how to break it up, with the reasoning behind each split.", needs: [], when: ["any"] },
  { id: "c-run-python", title: "Run some Python", prompt: "Write and run a short Python script that generates sample data and prints a small summary table.", needs: ["tools"], when: ["any"] },
  { id: "c-scrape", title: "Pull data off a page", prompt: "Fetch a web page I'll name and pull out the key facts as a clean, readable list.", needs: ["tools"], when: ["any"] },

  // -------------------------------------------------------------- thinking
  { id: "c-devils-advocate", title: "Argue against me", prompt: "I'll state a decision I've made. Give me the strongest case against it, not a balanced summary.", needs: ["reasoning"], when: ["any"] },
  { id: "c-tradeoffs", title: "Compare two options", prompt: "Help me choose between two options by laying out what each one actually costs me, not just a pros list.", needs: ["reasoning"], when: ["any"] },
  { id: "c-first-principles", title: "Break it down", prompt: "Take a problem I'll describe and break it into the smallest pieces that can be solved independently.", needs: ["reasoning"], when: ["any"] },
  { id: "c-premortem", title: "How would this fail?", prompt: "Assume a plan I'll describe has failed badly six months from now. Work backwards and tell me why.", needs: ["reasoning"], when: ["any"] },
  { id: "c-estimate", title: "Estimate from nothing", prompt: "Walk me through estimating a number with no data to hand, showing the assumptions at each step.", needs: ["reasoning"], when: ["any"] },
  { id: "c-second-opinion", title: "Check my reasoning", prompt: "I'll explain how I reached a conclusion. Find the weakest link in the chain rather than agreeing with me.", needs: ["reasoning"], when: ["any"] },

  // -------------------------------------------------------------- learning
  { id: "c-explain-5", title: "Explain it simply", prompt: "Explain a concept I'll name using one everyday analogy, then say exactly where that analogy breaks down.", needs: [], when: ["any"] },
  { id: "c-summarise", title: "Summarise a long read", prompt: "Summarise something long I'll paste into five bullet points, then one sentence on why it matters.", needs: [], when: ["morning", "evening"] },
  { id: "c-quiz-me", title: "Quiz me on this", prompt: "Ask me questions one at a time about a topic I'll name, getting harder as I get them right.", needs: [], when: ["evening", "night"] },
  { id: "c-timeline", title: "Give me the timeline", prompt: "Lay out how something I'll name developed over time, and what actually changed at each turning point.", needs: [], when: ["any"] },
  { id: "c-jargon", title: "Decode the terminology", prompt: "I keep seeing terms I half-understand in a field I'll name. Define them and show how they relate.", needs: [], when: ["any"] },

  // ------------------------------------------------------------- planning
  { id: "c-plan-day", title: "Plan the day", prompt: "I'll list what's on my plate today. Help me decide the order and what to drop if I run out of time.", needs: [], when: ["morning"] },
  { id: "c-unblock", title: "I'm stuck", prompt: "I'll describe something I've been avoiding. Ask me questions until we find the actual blocker.", needs: [], when: ["morning", "afternoon"] },
  { id: "c-wrap-up", title: "Close out the day", prompt: "Help me turn a messy list of what I did today into a short, clear update I can send to my team.", needs: [], when: ["evening"] },
  { id: "c-meeting-prep", title: "Prep for a meeting", prompt: "I'll describe a meeting I have coming up. Help me work out what I actually want out of it.", needs: [], when: ["morning", "afternoon"] },
  { id: "c-checklist", title: "Turn this into steps", prompt: "Turn something vague I'll describe into a concrete checklist where every item is small enough to start.", needs: [], when: ["any"] },
  { id: "c-weekly-review", title: "Look back at the week", prompt: "Ask me a handful of questions about my week, then reflect back what you notice in my answers.", needs: [], when: ["evening", "night"] },

  // ----------------------------------------------------------------- vision
  { id: "c-image-explain", title: "What's in this image?", prompt: "I'll share an image. Describe what's actually in it and point out anything I might have missed.", needs: ["vision"], when: ["any"] },
  { id: "c-screenshot-debug", title: "Read this screenshot", prompt: "I'll share a screenshot of an error or a confusing UI. Work out what's happening and what to do next.", needs: ["vision"], when: ["any"] },
  { id: "c-chart-read", title: "Interpret a chart", prompt: "I'll share a chart. Tell me what it shows, and flag anything about how it's drawn that could mislead.", needs: ["vision"], when: ["any"] },
  { id: "c-handwriting", title: "Transcribe a photo", prompt: "I'll share a photo of handwritten or printed notes. Transcribe it and tidy it into something readable.", needs: ["vision"], when: ["any"] },
  { id: "c-design-critique", title: "Critique this design", prompt: "I'll share a screenshot of something I designed. Give me a blunt critique of the layout and hierarchy.", needs: ["vision"], when: ["any"] },

  // ------------------------------------------------------------- open-ended
  { id: "c-brainstorm", title: "Brainstorm with me", prompt: "I'll name something I'm trying to come up with ideas for. Give me ten, including a few bad ones.", needs: [], when: ["any"] },
  { id: "c-what-if", title: "Follow a what-if", prompt: "Take a what-if question I'll ask and follow the consequences out honestly, several steps deep.", needs: ["reasoning"], when: ["evening", "night"] },
  { id: "c-recommend", title: "Recommend something", prompt: "Ask me a few questions about what I'm in the mood for, then recommend something and say why it fits.", needs: [], when: ["evening", "night"] },
];

/**
 * Keyless, free, OpenAI-compatible endpoints, tried in order until one returns
 * a batch that validates. Every one of these is live-verified in this repo to
 * answer with no Authorization header at all - see the research notes in
 * src/lib/gateway/providerPresets.ts and KEYLESS_PROVIDERS.md.
 *
 * Deliberately excluded: Kilo Gateway, BlockRun and Vireonix are keyless but
 * marked requiresProxy, and this project's rule is that a proxy-required
 * provider never silently falls back to a direct request. AI Horde is keyless
 * but its shared volunteer queue can take minutes, which does not fit the
 * timeout below.
 *
 * Generation runs once a day, which sits far inside the tightest anonymous
 * limit here (Pollinations, roughly one request per fifteen seconds).
 */
interface Generator {
  label: string;
  baseUrl: string;
  /**
   * null means "ask the provider". Uncloseai hosts a single model that rotates
   * as its operator swaps it - a hardcoded id there goes 404 without warning
   * (it already did once during development), so that entry discovers its id
   * from /v1/models instead of pinning one.
   */
  model: string | null;
}

const KEYLESS_GENERATORS: Generator[] = [
  // Live-verified keyless. Model ids drift on free tiers, so each one here was
  // checked against the provider's own /v1/models rather than copied from the
  // starterModels lists in providerPresets.ts, which had already gone stale:
  // llm7's "gpt-oss" now answers model_unavailable, and llm7's
  // "gemini-3.1-flash-lite" answers 401 because it is pro-tier, not turbo.
  { label: "ovhcloud", baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1", model: "gpt-oss-120b" },
  { label: "llm7", baseUrl: "https://api.llm7.io/v1", model: "mistral-Nemo-Instruct-2407" },
  { label: "pollinations", baseUrl: "https://text.pollinations.ai/openai", model: "openai" },
  { label: "uncloseai", baseUrl: "https://hermes.ai.unturf.com/v1", model: null },
];

/** First model the provider lists, or null. Keyless, like everything else here. */
async function discoverModel(baseUrl: string, signal: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(DISCOVER_TIMEOUT_MS)]),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    const id = body?.data?.[0]?.id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

const SYSTEM_PROMPT = [
  "You write starter prompts for the empty state of a general-purpose AI chat app.",
  "The user has not typed anything yet. A good suggestion makes someone think 'oh, I could use this for that'.",
  "",
  "Reply with ONLY a JSON array. No prose, no markdown, no code fence.",
  "Each element: {\"title\": string, \"prompt\": string, \"needs\": string[], \"when\": string[]}",
  "",
  `- title: at most ${MAX_TITLE} characters. An imperative label, not a sentence. No trailing period.`,
  `- prompt: at most ${MAX_PROMPT} characters. Written in the user's voice, addressed to the assistant.`,
  '- needs: any of "vision" (needs to look at an image), "tools" (needs to run code or fetch a URL),',
  '  "reasoning" (needs genuine multi-step thinking). Use [] when a small model could handle it.',
  '- when: any of "morning", "afternoon", "evening", "night", or "any" if the hour does not matter.',
  "",
  "Rules that matter:",
  "- Most entries should have needs: [] - most users are on a small local or free model.",
  "- Vary the domains: writing, code, analysis, learning, planning, everyday life, creative work.",
  "- No corporate filler, no 'leverage synergies', no prompts about prompting or about this app itself.",
  "- Each prompt must be usable as-is. A prompt that references a file or image the user has not",
  "  provided is fine only if it says 'I'll share' or 'I'll paste' so the intent is clear.",
].join("\n");

const USER_PROMPT = `Write ${ASK_COUNT} varied starter prompts as the JSON array described. Return the array and nothing else.`;

// ---------------------------------------------------------------- the store

export interface Store {
  /** UTC date of the last successful refresh. null until one lands. */
  dateKey: string | null;
  generatedAt: number;
  source: "generated" | "curated";
  pool: Suggestion[];
}

/**
 * Seeded with CURATED at module load, which is what makes the route total: it
 * is answerable from the first millisecond of the process, before any network
 * call has been attempted, and there is no error path to handle in the handler.
 */
const curatedStore: Store = {
  dateKey: null,
  generatedAt: Date.now(),
  source: "curated",
  pool: shuffled(CURATED),
};

function utcDateKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Fisher-Yates on a copy. Runs once a day, so Math.random is entirely adequate. */
function shuffled<T>(items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ------------------------------------------------------------- validation

const CAPABILITIES: Capability[] = ["vision", "tools", "reasoning"];
const WHEN_TAGS: WhenTag[] = [...DAY_PARTS, "any"];

function tidy(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // Newlines would break the single-line card layout, and a model asked for a
  // short label will occasionally return a wrapped paragraph anyway.
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  // Truncate on a word boundary when there is one reasonably close to the end,
  // so a clamped prompt still reads as a sentence rather than a cut-off word.
  const cut = collapsed.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trim();
}

function tagsFrom<T extends string>(value: unknown, allowed: T[]): T[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<T>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const match = allowed.find((a) => a === entry.toLowerCase().trim());
    if (match) seen.add(match);
  }
  return [...seen];
}

/**
 * Turns raw model output into suggestions, or null if the batch is not worth
 * preferring over CURATED.
 *
 * Deliberately strict: this is model output reaching a public endpoint, so
 * unknown tags are dropped rather than passed through, and anything that would
 * render as an empty or malformed card is discarded rather than repaired.
 */
export function validate(raw: string, generatedAt: number): Suggestion[] | null {
  const text = raw.trim();
  // Models fence JSON even when told not to, and occasionally add a sentence
  // before it. Take the outermost array rather than failing on either.
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return null;

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    // Fall through to salvage.
  }

  if (!Array.isArray(parsed)) {
    // A batch cut off mid-array by the provider's output cap is the single most
    // common failure here, and the entries before the cut are perfectly good.
    // Trim to the last complete object and close the bracket rather than
    // throwing away a whole generation over its final, half-written entry.
    const lastComplete = text.lastIndexOf("}");
    if (lastComplete <= start) return null;
    try {
      parsed = JSON.parse(`${text.slice(start, lastComplete + 1)}]`);
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) return null;
  }

  const out: Suggestion[] = [];
  const seenTitles = new Set<string>();

  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;

    const title = tidy(record.title, MAX_TITLE);
    const prompt = tidy(record.prompt, MAX_PROMPT);
    // A one-word prompt is a label, not something worth sending to a model.
    if (title.length < 2 || prompt.length < 16) continue;

    const key = title.toLowerCase();
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);

    const when = tagsFrom(record.when, WHEN_TAGS);
    out.push({
      id: `g${generatedAt.toString(36)}-${out.length}`,
      title,
      prompt,
      needs: tagsFrom(record.needs, CAPABILITIES),
      when: when.length > 0 ? when : ["any"],
    });
  }

  return out.length >= MIN_GENERATED ? out : null;
}

// ------------------------------------------------------------- generation

/**
 * Walks the keyless chain and returns the first batch that validates.
 *
 * Note the complete absence of any credential: no Authorization header, no key
 * parameter, nothing read from process.env. That is the point, and verify:relay
 * greps this file to keep it true.
 */
async function generate(signal: AbortSignal): Promise<Suggestion[] | null> {
  const generatedAt = Date.now();

  for (const generator of KEYLESS_GENERATORS) {
    if (signal.aborted) return null;
    const started = Date.now();
    try {
      const model = generator.model ?? (await discoverModel(generator.baseUrl, signal));
      if (!model) {
        note(generator.label, "no_model", started);
        continue;
      }

      const response = await fetch(`${generator.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: USER_PROMPT },
          ],
          // Generous: 40 entries of tagged JSON is a real amount of output, and
          // a truncated array fails validate() and wastes the whole attempt.
          max_tokens: 4096,
          temperature: 1,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(GENERATE_TIMEOUT_MS)]),
      });
      if (!response.ok) {
        note(generator.label, `http_${response.status}`, started);
        continue;
      }

      const body = (await response.json()) as {
        choices?: { message?: { content?: unknown } }[];
      };
      const content = body?.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        note(generator.label, "no_content", started);
        continue;
      }

      const validated = validate(content, generatedAt);
      if (validated) {
        note(generator.label, `ok_${validated.length}`, started);
        return validated;
      }
      note(generator.label, "unusable_batch", started);
    } catch {
      note(generator.label, "unreachable", started);
      // Timeout, DNS failure, malformed JSON body, a provider that quietly
      // started requiring a key - all the same here: try the next one.
    }
  }

  return null;
}

// -------------------------------------------------------------- scheduling

/**
 * Opt-in, off by default, and modelled on the relay's own RELAY_DEBUG_LOG.
 *
 * Emits one line per generator attempt: which provider, a non-identifying
 * outcome category, and a duration. Never a prompt, a response body or a
 * header - there is no user data on this path to leak in the first place, and
 * the "logs nothing" claim stays intact in the normal case because this is
 * silent unless explicitly switched on.
 *
 * Exists because these are third-party free tiers that drift: model ids go
 * stale and anonymous tiers start refusing. Without this, "suggestions stopped
 * refreshing" is undiagnosable in production.
 */
function note(provider: string, outcome: string, startedAt: number): void {
  if (process.env.SUGGESTIONS_DEBUG_LOG !== "1") return;
  console.log(JSON.stringify({ evt: "suggestions_attempt", provider, outcome, durationMs: Date.now() - startedAt }));
}

/** Scheduled generation is shared through Redis and never invoked by a route. */
export async function refresh(redis: SharedRedis): Promise<void> {
  const lease = await RedisLease.acquire(redis, 'suggestions');
  if (!lease) return;
  try {
    const previous = await redis.json<Store>('suggestions:pool');
    if (previous?.dateKey === utcDateKey()) return;
    const generated = await generate(lease.signal);
    if (lease.signal.aborted) return;
    const pool: Store = generated
      ? { dateKey: utcDateKey(), generatedAt: Date.now(), source: 'generated', pool: shuffled([...generated, ...CURATED]) }
      : { ...curatedStore, dateKey: utcDateKey(), generatedAt: Date.now(), pool: shuffled(CURATED) };
    await lease.setJson('suggestions:pool', pool, 172800);
  } finally { await lease.release(); }
}

export function startSuggestionScheduler(redis: SharedRedis, env: NodeJS.ProcessEnv = process.env): () => void {
  if (env.SUGGESTIONS_DISABLED === '1') return () => {};
  const tick = () => { void refresh(redis).catch(() => {}); };
  tick();
  const timer = setInterval(tick, TICK_MS); timer.unref();
  return () => clearInterval(timer);
}

// ------------------------------------------------------------- the read path

export interface SelectOptions {
  part: WhenTag;
  caps: Capability[];
}

export interface SelectResult {
  generatedAt: number;
  source: "generated" | "curated";
  suggestions: PublicSuggestion[];
}

/**
 * Synchronous. Filters the stored pool; never generates.
 *
 * Filtering per request is what keeps the two personalisation signals working
 * against a single shared daily pool: the caller's model capabilities, so a
 * text-only model is never offered an image prompt it would fail, and the
 * caller's local time of day, which only the browser knows.
 */
export async function selectSuggestions({ part, caps }: SelectOptions, redis: SharedRedis): Promise<SelectResult> {
  const granted = new Set(caps);
  const stored = await redis.json<Store>('suggestions:pool').catch(() => null);
  const current = stored && Array.isArray(stored.pool) && stored.pool.length ? stored : curatedStore;

  const capable = current.pool.filter((s) => s.needs.every((need) => granted.has(need)));
  // Time of day narrows an already-capable set. If that leaves too few - a
  // narrow capability set at an unusual hour - widen back to the capable ones
  // rather than padding with prompts the model cannot actually run.
  const timely = part === "any" ? capable : capable.filter((s) => s.when.includes(part) || s.when.includes("any"));
  const chosen = timely.length >= SERVE_COUNT ? timely : capable;

  return {
    generatedAt: current.generatedAt,
    source: current.source,
    suggestions: chosen.slice(0, SERVE_COUNT).map(({ id, title, prompt }) => ({ id, title, prompt })),
  };
}

/** Narrows an arbitrary query value to a known day part. Anything else is "any". */
export function parseDayPart(value: unknown): WhenTag {
  return typeof value === "string" && (DAY_PARTS as string[]).includes(value) ? (value as DayPart) : "any";
}
