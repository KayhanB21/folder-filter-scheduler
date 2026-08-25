# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0]

### Added
- **Add spam domains to Folder Filter Scheduler**: a message-list context-menu
  action that extracts sender domains from the selected messages and merges them
  into a standing block rule. Matching uses `Reply-To`, well-known provider
  domains are never blocked, and a confirmation dialog (with a "don't show this
  again" opt-out) lists exactly what will be added before anything is written.
- New `domainInList` condition operator, holding a whole domain list in one
  editable box and matching subdomains automatically. An empty list never
  matches, so a blank block list cannot affect a folder.
- Editable protected-domains list on the options page, seeded with the major
  freemail providers.
- Stable per-rule ids, so run state survives renaming a rule.
- `src/domains.js`: pure, unit-tested domain extraction, validation, and list
  matching, following the same no-extension-APIs rule as `matcher.js`.

### Changed
- Scheduled runs are now incremental, examining only messages that arrived since
  the previous run (with an overlap for clock skew and mildly backdated mail).
  **Run all rules now** still scans folders in full, and is the escape hatch for
  backlog or forged `Date` headers.
- Header reads use `messages.getHeaders()` instead of `messages.getFull()`,
  skipping MIME parsing.
- Minimum supported Thunderbird raised from 128 to **147**. ESR 140 reached end
  of life in August 2026.

## [0.1.1]

First public release on addons.thunderbird.net. (0.1.0 was uploaded then deleted
before review, so AMO retired that version number.)

### Added
- Self-contained rule engine: conditions (`from`, `to`, `cc`, `subject`,
  `reply-to`, `list-id`, `sender`) with `contains` / `is` / `starts with` /
  `ends with` / `matches regex`, each optionally negated, combined with AND/OR.
- Actions: move to Trash, move/copy to a chosen folder, mark read/flagged/junk,
  delete permanently.
- Periodic execution on **any** folder via the `alarms` API, plus a manual
  "Run all rules now" button.
- Cross-account moves: "Move to folder…" can target a folder in a different
  account (e.g. Yahoo Bulk → Outlook Trash).
- Modular action registry (`src/actions.js`) as the single source of truth for
  both the engine and the options UI, with unit tests.
- Lazy full-message fetch: rules using only cheap indexed headers
  (`from`/`to`/`cc`/`subject`) download nothing.
- Options page for managing rules, source folders, and the interval.
- Localization for English, German, French, Spanish, Italian, Japanese,
  Simplified Chinese, and Korean.
- Unit tests for the matcher and a GitHub Actions CI pipeline.
