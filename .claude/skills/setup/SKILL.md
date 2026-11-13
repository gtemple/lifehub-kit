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
2. **Where it runs**: this machine only, or an always-on box (mini PC, Raspberry Pi 5, old laptop)? Linux, macOS or Windows (WSL)? The fetch job needs to run every few minutes, so an always-on machine is best.
3. **Location**: city (for weather and the time zone). Look up lat/lon and the IANA time zone yourself; confirm them.
4. **Email**: which Gmail / Google Workspace accounts (a short name each, like Personal or Work). Other IMAP providers work if they give host + app password; say so if they use one.
5. **Calendar**: Google calendars to show on Today (optional).
6. **News**: topics they care about. Propose 2–3 RSS feeds per topic (verify each URL returns a feed with curl before suggesting it).
7. **AI models**: Lifehub sorts mail, drafts replies and writes a day brief with a model.
   - Ollama (local, free, private; needs ~8 GB RAM for `qwen3.5:4b`, more for bigger models). Recommend this for private data.
   - Gemini API key (optional; cheap, used for news and the AI daily card, and for private data only if they turn it on in Settings).
   They need at least one.

Then summarize the plan back in a short list and get a yes before writing anything.

## Phase 2: config

1. `cp lifehub.example.toml lifehub.toml` and fill it from the answers. Generate `secret_key` and `api_token` with `python3 -c 'import secrets; print(secrets.token_urlsafe(50))'`.
2. Personalize the prompts: replace `YOUR_NAME` in `hub/*.py` with their first name (use the full name in `hub/drafts.py` `VOICE` and `REWRITER` first lines). Replace `YOUR_INTERESTS` in `hub/news.py` with a short phrase from their topics.
3. `lifehub.toml` is gitignored; never commit it.

## Phase 3: install

Check prerequisites first and walk them through any that are missing: `uv` (https://docs.astral.sh/uv/), Node 20+, git.

```
uv sync
uv run manage.py migrate
uv run manage.py createsuperuser   # they type their own password; tell them to run it with `! ` in Claude Code
cd frontend && npm ci && npm run build && cd ..
uv run manage.py collectstatic --noinput
uv run manage.py test hub
```

## Phase 4: connect, one at a time

For each, walk through getting the credential, write it, then verify before the next:

- **Gmail**: needs 2-Step Verification on, then an app password at https://myaccount.google.com/apppasswords. Verify: start the server and use Settings → Connections → test, or a one-off `uv run manage.py fetch` and check for errors.
- **Calendar**: Google Calendar → Settings → the calendar → Integrate calendar → "Secret address in iCal format". Verify with `curl -s <url> | head -3` (should start `BEGIN:VCALENDAR`).
- **Ollama**: install from https://ollama.com, `ollama pull <model>`, verify `curl -s localhost:11434/api/tags`.
- **Gemini**: key from https://aistudio.google.com/apikey. Verify with one cheap request.
- **Feeds**: already checked in phase 1.

Sending email stays off until they switch it on in Settings; mention this. Drafts always wait for their approval ("stamp").

## Phase 5: run it

1. Try it: `uv run manage.py runserver 0.0.0.0:8400` and open http://localhost:8400, log in with the superuser.
2. Background fetch (mail, news, drafts, brief): `uv run manage.py fetch --every 300` must keep running.
3. Make both permanent for their platform. Pick one and set it up with them:
   - pm2 (any OS with Node): `pm2 start "uv run gunicorn config.wsgi -b 0.0.0.0:8400 -w 2" --name lifehub` and `pm2 start "uv run manage.py fetch --every 300" --name lifehub-fetch`, then `pm2 save` and `pm2 startup`.
   - systemd (Linux): two user services with the same commands.
4. It's LAN-only with a Django login. Don't expose it to the internet; for phone access away from home suggest Tailscale.

Finish with: the URL, how to restart, and that they can ask Claude in this repo to add new tiles or connections.
