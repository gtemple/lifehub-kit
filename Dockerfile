FROM node:22-slim AS frontend
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim
COPY --from=ghcr.io/astral-sh/uv:0.13.8 /uv /usr/local/bin/uv
# the docker CLI and compose plugin, used only by the Server page (compose.server.yml gives it the socket)
COPY --from=docker:28-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker:28-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy LIFEHUB_DATA=/data
WORKDIR /app
COPY pyproject.toml uv.lock .python-version ./
RUN uv sync --frozen --no-dev --no-install-project
COPY . .
COPY --from=frontend /app/frontend/dist frontend/dist
ENV PATH=/app/.venv/bin:$PATH
EXPOSE 8400
