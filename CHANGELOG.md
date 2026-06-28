# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — Unreleased

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
