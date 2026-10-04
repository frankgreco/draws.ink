# draws.ink

Type what you want drawn and watch a pen draw it. An image model makes a pen-and-ink
picture, a tracer turns it into single pen strokes, and the page plays them back in
drawing order. The drawing can be saved as an image, a video, a GIF or an SVG for a
pen plotter.

## How it works

1. The page (`public/`) posts `{prompt, aspect}` to `POST /api/sketch`.
2. `server.mjs` asks an image model on OpenRouter for the picture, runs `trace.py`
   (Python: scikit-image, SciPy) to find the centre line of every stroke, and runs
   vpype to join and simplify them. Progress and the finished SVG stream back as
   newline-delimited JSON.
3. The page animates the strokes. Video and GIF are encoded in the browser
   (`public/export.js`), so downloads cost the server nothing.

Every drawing costs money (about $0.02 for the picture), so drawing is limited: five per
visitor per ten minutes, 25 per visitor per day, 500 a day for everyone, four in progress
at once. The numbers and the messages are in `shared.mjs`.

## Repository layout

| Path | What it is |
|---|---|
| `public/` | The page: `index.html`, `app.js` (player), `export.js` (video and GIF), `styles.css` |
| `server.mjs` | The drawing server (Node, no dependencies) |
| `trace.py` | Picture to pen strokes |
| `shared.mjs` | Limits, visitor messages and security headers, shared by the server and the Worker |
| `src/worker.js` | Cloudflare Worker: serves the page, counts drawings, forwards to the container |
| `wrangler.jsonc` | The Cloudflare infrastructure: Worker, assets, container, domains |
| `Dockerfile`, `requirements.txt` | The container image: Node, Python and the pinned libraries |
| `test/` | Tests for the limits |
| `render/`, `eval.mjs`, `public/lab.html`, `public/designs/` | Development only: the older 3D modes, the comparison harness and the lab pages. Not deployed. |

## Local development

Requirements: Node 22+, pnpm (via corepack), [uv](https://docs.astral.sh/uv/), Go (only for the lab's 3D modes).

```bash
pnpm install
pnpm setup              # Python environment (.venv) and the Go renderer
pnpm start              # the public site on http://localhost:5177
pnpm dev                # the same with the lab at /lab and the limits off
pnpm test               # the limit tests
```

Two secret files, both gitignored. `.dev.vars` holds `OPENROUTER_API_KEY` and is read by
`node server.mjs` and by `wrangler dev`. `.prod.vars` holds the production values
(`OPENROUTER_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) and is what gets
copied into GitHub Actions secrets.

`pnpm dev:worker` runs the Worker and the container together on :8787, as deployed. It
needs Docker. Wrangler always builds the image for amd64, so on an Apple Silicon Mac
Docker must be able to run amd64 images (Docker Desktop: Settings, General, "Use Rosetta
for x86_64/amd64 emulation"). The same applies to `pnpm run deploy` from a Mac. GitHub's
runners are amd64 and need nothing.

Checks: `pnpm check` runs the syntax checks, the tests and a dry-run deploy.

## Deploying

The site runs on Cloudflare. A Worker serves the page from static assets and answers
`/api/health`. Drawing needs Python, which a Worker cannot run, so `/api/sketch` goes to a
[container](https://developers.cloudflare.com/containers/) that runs `server.mjs`. The
container sleeps five minutes after the last drawing and a request wakes it. Its memory
goes when it sleeps, so the Worker keeps the count of each visitor's drawings in the
Durable Object in front of the container (`src/worker.js`).

One-time setup:

1. **Workers Paid plan** ($5 a month). Containers are not available on the free plan.
2. **API token.** Give `CLOUDFLARE_API_TOKEN` these account permissions: Workers
   Scripts:Edit, Containers:Edit, Account Settings:Read.
3. **Domain.** `draws.ink` must be a zone in the Cloudflare account (it is). `wrangler
   deploy` attaches `draws.ink` and `www.draws.ink` as custom domains from the `routes`
   block in `wrangler.jsonc` and issues certificates. The Worker redirects `www` to
   `draws.ink`.
4. **GitHub.** Create a `production` environment and add the repository secrets:

   | Secret | Notes |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | permissions as above |
   | `CLOUDFLARE_ACCOUNT_ID` | |
   | `OPENROUTER_API_KEY` | pays for the image model; set a credit limit on the key in OpenRouter |

   All three are in `.prod.vars`: `gh secret set -f .prod.vars`.

Every push to `main` runs `.github/workflows/deploy.yml`: tests, then `wrangler deploy`,
which uploads the Worker and the page, builds the container image and rolls it out, with
the secret attached to the same version, then a smoke test of `/api/health`. Pull requests
run `check.yml` with no secrets. The first deploy takes a few minutes while Cloudflare
provisions the container; drawing fails until it has.

## Operations

- **Cost.** Each drawing is about $0.02 to OpenRouter. Cloudflare bills the container only
  while it is awake: about $0.06 an hour for the `standard-2` instance (1 vCPU, 6 GiB),
  after the allowance that comes with the paid plan (roughly four hours awake a month).
  Awake all month it would be about $42. `standard-1` in `wrangler.jsonc` costs a third
  less and makes each drawing about five seconds slower.
- **Limits.** Change them with `vars` in `wrangler.jsonc` (`SKETCH_IP_LIMIT`,
  `SKETCH_IP_DAILY`, `SKETCH_DAILY_CAP`). At 500 a day the most the image model can cost
  is about $10 a day.
- **Logs.** `pnpm exec wrangler tail` streams the Worker; the container logs one JSON line
  per drawing (prompt, shape, time, cost). Both are in the Cloudflare dashboard, where
  observability is enabled.
- **Changing the key.** A new `OPENROUTER_API_KEY` reaches the container the next time it
  starts, so within five minutes of the last drawing after a deploy.
- **Image model.** `IMAGE_MODELS` in `server.mjs`; the first is the one the site uses.
