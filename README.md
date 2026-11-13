# Lifehub

A personal dashboard that runs on your own machine:
- **Mail:** your Gmail inbox, sorted and summarized, with draft replies that wait for your OK
- **Day:** calendar, to-dos and notes, plus a morning brief
- **Reading:** news from the sources you pick, and a price watcher
- **Ask:** an assistant (⌘K) that can look across all of it

## Get started

You need [Claude Code](https://claude.com/claude-code). Claude sets everything else up with you.

```
git clone <this repo> lifehub
cd lifehub
claude
```

Then type `/setup`. Claude asks you a few questions:
- your name and city
- which email accounts and calendars to connect
- the news you like
- which AI model to use
- whether to run it in Docker

From your answers it writes the config, connects each account and checks it works, then starts Lifehub. It takes 20–30 minutes, mostly on Google settings pages.

When it's done, open **http://localhost:8400**.

## Good to know

- **Privacy:** Lifehub is meant for your home network only, behind a login. Don't expose it to the internet.
- **Approval:** nothing is sent, deleted or unsubscribed without your approval in the app.
- **Your secrets stay local:** passwords and keys live in `lifehub.toml`, which is never committed.
- **Later changes:** run `/setup` again to add an account or change things.
