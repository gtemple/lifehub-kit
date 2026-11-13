---
name: setup
description: Set up this Lifehub install for a new owner - interview them, write lifehub.toml, personalize the prompts, connect email/calendar/news/models one at a time, build, and run it. Use on first run (no lifehub.toml), or when they say "set up", "configure", "install", or want to add a connection.
---

# Lifehub setup

You are setting Lifehub up for its new owner. Be a friendly guide, not a form: ask a few questions at a time, explain why each matters in one line, and verify each step works before moving on. Never print secrets back to them after they paste one.

If `lifehub.toml` already exists, read it, say what's configured, and ask what they want to add or change. Skip to that phase.

## Phase 1: interview

Ask in small batches (AskUserQuestion when it fits), wait for answers:

1. **Who**: first name and full name (drafted email replies are signed with it). Pronouns aren't needed; the prompts use "them".
2. **Where and how it runs**: this machine only, or an always-on box (mini PC, Raspberry Pi 5, old laptop)? Linux, macOS or Windows (WSL)? The fetch job needs to run every few minutes, so an always-on machine is best. On a laptop, say plainly: while it sleeps, mail isn't sorted or drafted and the 7:40 brief waits until it wakes. Fine to try it out; a spare always-on machine is better long-term.
   Then: **Docker** (recommended if they have it or are happy to install it: one command to run, easy to move) or **native** (uv + pm2/systemd)?
3. **Location**: city (for weather and the time zone). Look up lat/lon and the IANA time zone yourself; confirm them.
4. **Email**: which Gmail / Google Workspace accounts (a short name each, like Personal or Work). Other IMAP providers work if they give host + app password; say so if they use one. Warn up front: work (Workspace) accounts often have app passwords blocked by their admin; if so, skip that account for now and add it later in Settings → Connections once IT allows it.
5. **Calendar**: Google calendars to show on Today (optional).
6. **News**: topics they care about, and the sites, subreddits, blogs or newsletters they already read. Find a feed for each source they name (Reddit: `https://www.reddit.com/r/<sub>/.rss`; Substack: `<name>.substack.com/feed`; otherwise look for the site's RSS/Atom link), then propose 2–3 more per topic to fill gaps. Verify every URL returns a feed with curl before adding it. A source with no public feed (paywalled, like The Athletic): say so, and offer a Google News search feed for its headlines instead, `https://news.google.com/rss/search?q=site:<domain>+<topic>&hl=en`, which links to the site (they still need their subscription to read). Each feed gets a `topic`; the news brief favours the topics in `YOUR_INTERESTS`.
7. **AI models**: Lifehub sorts mail, drafts replies and writes a day brief with a model.
   - Ollama (local, free, private; needs ~8 GB RAM for `qwen3.5:4b`, more for bigger models). Recommend this for private data.
   - Gemini API key (optional; cheap, used for news and the AI daily card, and for private data only if they turn it on in Settings).
   They need at least one. **Gemini only**: private data (mail, notes, calendar) goes to Ollama unless "Allow Gemini for private data" is on, so without it mail is never sorted or drafted. Explain that and ask; if yes, turn it on once Gemini is connected (Phase 4). **On a Mac**, install Ollama natively (the app from ollama.com) even when Lifehub runs in Docker: Docker on macOS can't reach the Apple GPU, so a containerized Ollama runs CPU-only and slow. Point Lifehub at it with `http://host.docker.internal:11434` and skip the `ollama` profile. Docker Desktop's VM needs about 2 GB for Lifehub itself; the Server page's memory figures are the VM's, not the Mac's. With Docker on Linux, ask whether Ollama should run in a container (the `ollama` profile) or on the host (already installed, or on a Mac where a container can't use the GPU). If in a container: do they have an NVIDIA GPU? Then the GPU block in `compose.yml` and the NVIDIA Container Toolkit; otherwise it runs on the CPU, which is fine for a 4B model but slow for bigger ones.
8. **Server page** (optional): a page to see and control the containers and compose stacks on this machine (start/stop, logs, updates, memory limits), plus pm2 apps and Ollama, with a red dot when a container crashes. Needs Docker on the machine.
   - Ask if they have **other projects already running in Docker Compose**. Those show up on their own once they've been started (`docker compose up`) at least once; note where they live (`PROJECTS_DIR`).
   - Ask if they have **projects not in Docker yet** that they'd like containerized. Offer to write a `Dockerfile` and `compose.yml` for each, one project at a time, now or later in that project's own folder. Don't do this inside the Lifehub repo.
   - If Lifehub itself runs in Docker, the page needs the Docker socket mounted, which gives Lifehub root-level access to the machine. Say so plainly; it's fine for a LAN-only app behind a login, and they can skip the page.

Then summarize the plan back in a short list and get a yes before writing anything.

## Phase 2: config

1. `cp lifehub.example.toml lifehub.toml` and fill it from the answers. Generate `secret_key` and `api_token` with `python3 -c 'import secrets; print(secrets.token_urlsafe(50))'`.
2. Personalize the prompts: replace `YOUR_NAME` in `hub/*.py` with their first name (use the full name in `hub/drafts.py` `VOICE` and `REWRITER` first lines). Replace `YOUR_INTERESTS` in `hub/news.py` with a short phrase from their topics.
3. `lifehub.toml` is gitignored; never commit it.

## Phase 3: install

### Docker

Prerequisite: Docker with the compose plugin (`docker compose version`). On macOS/Windows, Docker Desktop.

1. In `lifehub.toml`, `ollama_url` is `http://ollama:11434` (ollama profile) or `http://host.docker.internal:11434` (host Ollama). On Linux, host Ollama must listen beyond localhost: `OLLAMA_HOST=0.0.0.0` in its systemd unit.
2. Server page: `server = true` in `lifehub.toml`, and a `.env` beside `compose.yml`:
   ```
   COMPOSE_FILE=compose.yml:compose.server.yml
   PROJECTS_DIR=/absolute/path/to/their/projects
   ```
3. Ollama in a container: add `COMPOSE_PROFILES=ollama` to `.env` (so plain `docker compose up` includes it).
4. `docker compose up -d --build`, then have them create their login **in their own terminal** (it prompts for a password, which Claude Code can't answer): `docker compose exec web python manage.py createsuperuser`.
5. Ollama in a container: `docker compose exec ollama ollama pull <model>`.
6. Check `docker compose ps` and `docker compose logs web fetch`.

It restarts on its own (`restart: unless-stopped`); skip Phase 5's pm2/systemd. Updating later: `git pull && docker compose up -d --build`.

### Native

Check prerequisites first and walk them through any that are missing: `uv` (https://docs.astral.sh/uv/), Node 20+, git.

```
uv sync
uv run manage.py migrate
uv run manage.py createsuperuser   # prompts for a password: have them run it in their own terminal, not through Claude
cd frontend && npm ci && npm run build && cd ..
uv run manage.py collectstatic --noinput
uv run manage.py test hub
```

## Phase 4: connect, one at a time

For each, walk through getting the credential, write it, then verify before the next:

- **Gmail**: needs 2-Step Verification on, then an app password at https://myaccount.google.com/apppasswords. "The setting you are looking for is not available" with 2-Step on means a Workspace admin blocked it: skip the account (see Phase 1). Verify: start the server and use Settings → Connections → test, or a one-off `uv run manage.py fetch` and check for errors.
- **Calendar**: Google Calendar → Settings → the calendar → Integrate calendar → "Secret address in iCal format". Verify with `curl -s <url> | head -3` (should start `BEGIN:VCALENDAR`).
- **Ollama**: install from https://ollama.com, `ollama pull <model>`, verify `curl -s localhost:11434/api/tags`.
- **Gemini**: key from https://aistudio.google.com/apikey. Verify with one cheap request. If they agreed to Gemini for private data, turn it on (Settings → Models in the app, or `python manage.py shell -c "from hub.models import Setting; Setting.objects.update_or_create(key='gemini_private', defaults={'value': True})"`, prefixed with `docker compose exec web` in Docker).
- **Feeds**: already checked in phase 1.

Sending email stays off until they switch it on in Settings; mention this. Drafts always wait for their approval ("stamp").

## Phase 5: run it (native only)

Native installs that want the Server page: `server = true` in `lifehub.toml`, and the user running Lifehub must be in the `docker` group.

1. Try it: `uv run manage.py runserver 0.0.0.0:8400` and open http://localhost:8400, log in with the superuser.
2. Background fetch (mail, news, drafts, brief): `uv run manage.py fetch --every 300` must keep running.
3. Make both permanent for their platform. Pick one and set it up with them:
   - pm2 (any OS with Node): `pm2 start "uv run gunicorn config.wsgi -b 0.0.0.0:8400 -w 2" --name lifehub` and `pm2 start "uv run manage.py fetch --every 300" --name lifehub-fetch`, then `pm2 save` and `pm2 startup`.
   - systemd (Linux): two user services with the same commands.
4. It's LAN-only with a Django login. Don't expose it to the internet; for phone access away from home suggest Tailscale.

Finish with: the URL, how to restart, and that they can ask Claude in this repo to add new tiles or connections.
