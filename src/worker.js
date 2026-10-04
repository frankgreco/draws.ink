// Worker entry for draws.ink. The page and its files are served from
// Cloudflare's static assets (./public). Drawing needs Python, so POST
// /api/sketch goes to a container that runs server.mjs, reached through the
// Studio Durable Object below. The www host redirects to the canonical one, so
// there is exactly one origin.
import { Container, getContainer } from "@cloudflare/containers";
import { SECURITY_HEADERS, DAY_MS, limitsFrom, refusal, decide } from "../shared.mjs";

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...headers } });
const refuse = (status, code, retryAfter) => json(status, refusal(code, retryAfter), retryAfter ? { "Retry-After": String(retryAfter) } : {});
const addressOf = (request) => request.headers.get("CF-Connecting-IP") ?? "unknown";

// The container, and the count of who has drawn what today. The container is
// stopped when nobody is drawing and its memory goes with it, so the counts
// live here, in the Durable Object's storage, and server.mjs is started with
// SKETCH_GATED=1 to leave them to us. It still caps the drawings in progress.
export class Studio extends Container {
  defaultPort = 8080;
  sleepAfter = "5m";
  #limits;

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = { OPENROUTER_API_KEY: env.OPENROUTER_API_KEY ?? "" };
    this.#limits = limitsFrom(env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS drawn (id INTEGER PRIMARY KEY, address TEXT NOT NULL, at INTEGER NOT NULL)");
  }

  async fetch(request) {
    const sql = this.ctx.storage.sql;
    const address = addressOf(request);
    const now = Date.now();
    sql.exec("DELETE FROM drawn WHERE at <= ?", now - DAY_MS);
    const mine = sql.exec("SELECT at FROM drawn WHERE address = ? ORDER BY at", address).toArray().map((row) => row.at);
    const everyone = sql.exec("SELECT COUNT(*) AS count, MIN(at) AS oldest FROM drawn").one();
    const refused = decide({ mine, everyone, inProgress: 0, limits: this.#limits, now });
    if (refused) return refuse(refused.status, refused.code, refused.retryAfter);

    // Counted before the drawing starts, so requests arriving together cannot
    // all slip under a limit; taken back if the server turns the request away.
    const { id } = sql.exec("INSERT INTO drawn (address, at) VALUES (?, ?) RETURNING id", address, now).one();
    try {
      const response = await this.containerFetch(request);
      if (response.status !== 200) sql.exec("DELETE FROM drawn WHERE id = ?", id);
      return response;
    } catch (err) {
      sql.exec("DELETE FROM drawn WHERE id = ?", id);
      console.error("container:", err);
      return refuse(503, "unavailable");
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Canonical host and https. Local dev and the workers.dev preview are exempt.
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname.endsWith(".workers.dev");
    const insecure = url.protocol === "http:" || request.headers.get("x-forwarded-proto") === "http";
    if (!local && (url.hostname !== env.CANONICAL_HOST || insecure)) {
      url.hostname = env.CANONICAL_HOST;
      url.protocol = "https:";
      url.port = "";
      return Response.redirect(url.toString(), 301);
    }

    if (url.pathname === "/api/health") return json(200, { ok: true });

    if (url.pathname === "/api/sketch") {
      if (request.method !== "POST") return new Response("Method not allowed\n", { status: 405, headers: { Allow: "POST", ...SECURITY_HEADERS } });
      // A cheap guard at the edge, before anything wakes the container.
      const { success } = await env.DRAW_LIMITER.limit({ key: addressOf(request) });
      if (!success) return refuse(429, "rate_limited", 60);
      return getContainer(env.STUDIO).fetch(request);
    }
    if (url.pathname.startsWith("/api/")) return json(404, { error: { code: "not_found", message: "Not found." } });

    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
