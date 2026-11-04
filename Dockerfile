FROM node:22-bookworm-slim AS node
FROM python:3.14-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libstdc++6 libatomic1 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY requirements-brain.txt ./
RUN pip install --no-cache-dir -r requirements-brain.txt
COPY server.js brain-service.js ./
COPY scripts/brain_worker.py ./scripts/brain_worker.py
COPY public/ ./public/
COPY data/brain-model/ ./data/brain-model/
COPY vendor/fly-saber/ ./vendor/fly-saber/

ENV HOST=0.0.0.0 PORT=8788 BRAIN_PYTHON=/usr/local/bin/python
EXPOSE 8788
CMD ["node", "server.js"]
