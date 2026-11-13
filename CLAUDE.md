# Lifehub

A personal dashboard: Gmail inbox sorted and summarized by a model, drafted replies that wait for approval, calendar, to-dos, notes, news brief, price watcher, a day brief, and a ⌘K agent over all of it.

**First run:** if `lifehub.toml` doesn't exist, this install isn't set up yet. Greet the user and offer to run `/setup`, which interviews them and configures everything.

## Layout
- `config/` Django settings; all config and secrets come from `lifehub.toml` (gitignored, see `lifehub.example.toml`). Email accounts, calendars and feeds edited in Settings are stored in the DB and win over the file.
- `hub/` the one Django app. `views.py` serves the API and tiles; `management/commands/fetch.py` is the background job (mail, triage, drafts, news, brief, prices).
- Models: `hub/health.py` picks Ollama; `hub/triage.py` has the Ollama/Gemini calls. Private data (mail, notes, calendar) goes to Ollama, or to Gemini only when allowed in Settings.
- `hub/server.py` + `frontend/src/ledger/ServerPage.tsx`: the optional Server page (`server = true`), driving the docker CLI.
- Docker: `Dockerfile`, `compose.yml` (web, fetch, optional `ollama` profile), `compose.server.yml` (opt-in Docker socket for the Server page). The database lives in `LIFEHUB_DATA` (the `data` volume in Docker).
- `frontend/` React + Vite. Two looks: `ledger/` (default) and the retro one (`App.tsx`, `tiles/`). Built to `frontend/dist`, served by Django.

## Commands
- Docker: `docker compose up -d --build` (add `--profile ollama` for Ollama in a container)
- Backend: `uv run manage.py runserver 0.0.0.0:8400`, tests `uv run manage.py test hub`
- Fetch job: `uv run manage.py fetch --every 300`
- Frontend: `cd frontend && npm run build` (or `npm run dev`)

## Rules
- Never send, delete or unsubscribe without the user's approval in the app; those always go through an Approval.
- Never commit `lifehub.toml`, `db.sqlite3` or anything with credentials.
- LAN only behind Django login; don't expose it to the internet.
