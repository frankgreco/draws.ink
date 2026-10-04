// What the Node server and the Cloudflare Worker must agree on: the response
// headers, the drawing limits and what visitors are told when one is reached.
// The server keeps its counts in memory; the Worker keeps them in storage that
// outlives the container the server runs in.

export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

export const MAX_PROMPT = 200;
export const WINDOW_MS = 10 * 60_000;
export const DAY_MS = 24 * 60 * 60_000;

// Every drawing costs money, so visitors are limited: a few per ten minutes
// and per day each, a daily total for everyone, and a cap on how many are in
// progress at once.
export const limitsFrom = (env) => ({
  perVisitor: Number(env.SKETCH_IP_LIMIT ?? 5),
  perVisitorDaily: Number(env.SKETCH_IP_DAILY ?? 25),
  daily: Number(env.SKETCH_DAILY_CAP ?? 500),
  concurrent: Number(env.SKETCH_CONCURRENCY ?? 4),
});

// What visitors are told. Details of a failure stay in the server log.
const wait = (seconds) => (seconds < 90 ? "a minute" : seconds < 5400 ? `${Math.round(seconds / 60)} minutes` : `${Math.round(seconds / 3600)} hours`);
export const MESSAGES = {
  bad_prompt: () => `Tell us what to draw, in up to ${MAX_PROMPT} characters.`,
  rate_limited: (seconds) => `You've reached the drawing limit for now. Try again in ${wait(seconds)}.`,
  closed: () => "We've reached today's drawing limit. Come back tomorrow.",
  busy: () => "Lots of people are drawing right now. Try again in a moment.",
  unavailable: () => "Drawing isn't available right now. Please try again later.",
  failed: () => "We couldn't draw that one. Try describing it a little differently.",
};
export const refusal = (code, retryAfter) => ({ error: { code, message: MESSAGES[code](retryAfter) } });

// Whether one more drawing may start: null, or why not. `mine` holds the
// times (ms, oldest first) of this visitor's drawings in the last day;
// `everyone` is the count of all drawings in the last day and the oldest time.
export function decide({ mine, everyone, inProgress, limits, now }) {
  const recent = mine.filter((t) => now - t < WINDOW_MS);
  const until = (t, span) => Math.ceil((t + span - now) / 1000);
  if (recent.length >= limits.perVisitor) return { status: 429, code: "rate_limited", retryAfter: until(recent[0], WINDOW_MS) };
  if (mine.length >= limits.perVisitorDaily) return { status: 429, code: "rate_limited", retryAfter: until(mine[0], DAY_MS) };
  if (everyone.count >= limits.daily) return { status: 503, code: "closed", retryAfter: until(everyone.oldest, DAY_MS) };
  if (inProgress >= limits.concurrent) return { status: 503, code: "busy", retryAfter: 10 };
  return null;
}
