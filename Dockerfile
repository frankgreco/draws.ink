# The drawing server as it runs on Cloudflare: Node for server.mjs, and a
# Python environment with the tracer's libraries and vpype. The 3D lab modes
# (Go and ln) are development only and are left out.
FROM node:24-bookworm-slim

COPY --from=ghcr.io/astral-sh/uv:0.12.22 /uv /usr/local/bin/uv
WORKDIR /app

# server.mjs looks for .venv/bin/python and .venv/bin/vpype beside itself.
ENV UV_PYTHON_INSTALL_DIR=/opt/python
COPY requirements.txt ./
RUN uv venv .venv --python 3.13 \
 && uv pip install --python .venv/bin/python --no-cache -r requirements.txt

COPY package.json server.mjs shared.mjs trace.py ./
COPY public ./public

# SKETCH_GATED: the Worker counts each visitor's drawings (src/worker.js).
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 SKETCH_GATED=1
EXPOSE 8080
USER node
CMD ["node", "server.mjs"]
