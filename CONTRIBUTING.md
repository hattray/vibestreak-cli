# Contributing

Issues and pull requests are welcome.

## Running it

Node.js 22.13 or newer, no dependencies:

```bash
npm test                          # unit tests
node bin/vibestreak.mjs collect   # what this machine would send (nothing leaves it)
node bin/vibestreak.mjs collect --json
```

`VIBESTREAK_SERVER` points the CLI at another server, `VIBESTREAK_CONFIG` at
another config file (handy for keeping your own setup out of an experiment).

## A count looks wrong

Open an issue with the tool, your OS, `node bin/vibestreak.mjs --version`, and
the lines from `collect` that look off. Please don't paste your history files or
anything from them: they hold your prompts and code.

## The one rule

The CLI sends per-day counts and keyed commit hashes, nothing else. A change
that would send any content (prompts, responses, code, paths, repository names,
commit messages, email addresses) won't be merged. Readers for new tools are
very welcome: see `src/` for the existing ones and add a test with a small,
made-up fixture.
