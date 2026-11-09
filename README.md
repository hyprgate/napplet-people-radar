<!-- HYPRGATE NAPPLET MIRROR NOTICE:START -->
> This repository is a read-only mirror of the `people-radar` napplet from `hyprgate/gui`.
> Open issues and pull requests in https://github.com/hyprgate/gui.
> Do not push commits to this standalone napplet repository; direct changes are overwritten by Hyprgate's mirror workflow.
<!-- HYPRGATE NAPPLET MIRROR NOTICE:END -->

# People Radar

See what the people you follow have been posting lately. The app is tracked in this
repo at `napplets/people-radar`; the standalone `hyprgate/napplet-people-radar`
repository is a generated, read-only mirror.

It lists you and everyone you follow, most recently active first, with avatars and
names from kind 0. People with no profile show their npub. Selecting someone shows
their recent notes. Their name or avatar opens their profile through the shared
intent, and a note opens in the note reader.

Profiles and notes come from `outbox.query` when the runtime offers it, and fall back
to `relay.subscribe`. The shell owns relay selection. The list covers your full follow
list, and the notes are whatever that one query returns, so someone can show no recent
notes without being inactive.

```bash
pnpm --filter ./napplets/people-radar test
pnpm --filter ./napplets/people-radar type-check
pnpm --filter ./napplets/people-radar build
```
