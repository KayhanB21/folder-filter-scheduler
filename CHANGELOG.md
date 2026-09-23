# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.5]

### Added
- **Include subfolders.** A rule can scan every folder under the ones you
  picked, worked out on each run so new subfolders are covered. A Trash folder
  and any folder the rule moves or copies into are skipped, so a rule never
  deletes mail from Trash for good or scans its own output again. New mail in a
  subfolder triggers the rule too.
- **Folder filter.** A search box above each rule's folder list narrows it to
  matching paths, and *Select all matching* picks every match. Selections made
  earlier are kept while you filter, and a count shows how many the filter hides.
- **Theme switch.** A sun, moon, and monitor switch in the header picks Light,
  Dark, or System. System, the default, follows Thunderbird's theme.

### Changed
- **The folder list is a tree.** Folders are grouped by account with a line
  between accounts, indented under their parent, and joined by dashed guide
  lines. While a filter is active, each
  match shows its full path. With *Include subfolders* on, the list marks every
  folder the rule scans without you picking it.

## [0.3.4]

### Added
- **Archive action.** Archives matched mail the way Thunderbird's Archive
  button does, so each message follows its own account's archive settings,
  including yearly or monthly subfolders. An account with archiving turned off
  keeps its mail in place. Like Move and Trash, Archive ends the rule, so a tag
  action in the same rule runs first.

## [0.3.3]

### Changed
- **No action is pre-selected any more.** New rules and "+ Add action" used to
  start on "Move to Trash", so adding a tag action and missing the row above it
  sent the mail you meant to tag to Trash. A new action row now starts on
  "Choose an action…", and Save is refused, with the rule named, until every
  row has a real action.

### Added
- **To and Cc in address-book conditions.** The condition matches when any
  recipient is in the chosen book.

## [0.3.2]

### Added
- **Tag action**: apply one of your Thunderbird tags to matched mail. Tags
  already on a message are preserved, since `messages.update` replaces the whole
  tag array, so several rules can tag the same message. Listing your tags for
  the picker needs the `messagesTagsList` permission, which is optional and
  requested from the options page only when you add a tag action; applying a tag
  does not need it, so a rule keeps working if the permission is later revoked.
- **Several actions per rule.** "If from is in address book Friends, tag as
  Friends and move to the Friends folder" is now one rule instead of two.
- **Runs on new mail**, alongside the timer, as suggested by the Thunderbird
  reviewer. `messages.onNewMailReceived` is registered with `monitorAllFolders`,
  since the folders this add-on exists for are the ones that are not the Inbox.
  Arrivals arm a debounce (10s by default), so one mail sync produces one run,
  and the run is scoped to the rules watching the folders that received mail.
  Needs no new permission: `accountsRead` and `messagesRead` are already held.
- **A re-entrancy gate** (`src/runner.js`) in front of every run. Two runs can
  no longer overlap and corrupt the per-rule run state, triggers arriving during
  a run collapse into a single follow-up, and a manual "Run all rules now" is
  never answered by an incremental pass that happened to be underway.
- **Advanced settings** at the bottom of the options page: the new-mail trigger
  and its delay, the catch-up interval and lookback, and the scan overlap. What
  were constants in `scan.js` are now configurable, clamped in `src/settings.js`
  so no value can make every run a full folder scan. They travel with rule
  export and import.

### Changed
- A rule stores `actions` (a list) instead of `action`. Existing rules are
  migrated on first load and older export files still import.
- Execution order is derived, not stored: the action that consumes the message
  (move, Trash, delete permanently) always runs last, and at most one such action
  is allowed per rule. A move invalidates the message ids, so "move then tag"
  would otherwise tag nothing.

### Fixed
- Dark mode. The options and confirmation pages already followed Thunderbird's
  theme through `color-scheme` and the system colours, but the two fixed accents
  did not: the danger red (`#d70022`) and the accent blue used as text were both
  close to unreadable on a dark background. Each now has a dark variant, and the
  accent is split into a button-background colour and a text colour, which need
  contrast in opposite directions.

## [0.3.1]

### Added
- **Address-book conditions**: `from` / `reply-to` / `sender` · `is in address
  book` · a chosen book or all local books, negatable. Books are loaded once per
  run into a set, so each message is a single lookup. A book that cannot be
  read, is empty, or no longer exists never matches in either polarity, nor does
  a message with no usable sender address; with "all books", one unreadable book
  makes the whole condition inert. LDAP books are skipped since they cannot be
  enumerated. The `addressBooks` permission is optional and requested from the
  options page only when this condition is used, so existing users see no update
  prompt.
- **Diagnostics**: a persistent log of the last 1000 engine events and a
  plain-text report (copy or save) on the options page, including Thunderbird
  version, interval, next alarm, each rule's shape and run state, and the log.
  Condition values, domain lists and folder ids are redacted unless the user
  opts in.

### Changed
- Every run now logs one line per rule: scan kind, date range, messages scanned,
  matched and actioned, duration, and whether errors occurred.

## [0.3.0]

### Added
- **Age conditions**: `age` · `older than` / `newer than` · N days. Lets a rule
  express "move mail to Archive after 30 days" or "mark anything older than a
  week as read", which the built-in retention policy cannot, since it only
  deletes. Age is measured from the `Date` header, as Thunderbird's own "Age in
  Days" filter does. A condition with a blank or zero day count never matches.
  Requested in [#2](https://github.com/KayhanB21/folder-filter-scheduler/issues/2).

### Changed
- Rules with an age condition are not scanned incrementally, since the messages
  they target are by definition old. An `all` rule with `older than N` is
  queried with an upper Date bound instead, so only the old tail of the folder
  is read.

## [0.2.1]

### Fixed
- Scheduled runs could permanently miss mail whose `Date` header sits hours
  behind its real arrival time. Incremental scans filter on that header, which
  the sender controls, so such a message never fell inside the window and was
  only ever caught by a manual run. Scheduled runs now do a wider catch-up scan
  (the last 30 days of the folder) on the first pass and then every 30 minutes,
  bounding the worst case to half an hour. **Run all rules now** is unchanged
  and still scans everything. Reported against a Hotmail Junk folder where
  spam arrived with a `Date` seven hours old.

## [0.2.0]

### Added
- **Add spam domains to Folder Filter Scheduler**: a message-list context-menu
  action that extracts sender domains from the selected messages and merges them
  into a standing block rule. Domains are harvested from both `Reply-To` and
  `From` and presented in separate groups, since most spam carries only one of
  the two and a `From` domain is forgeable enough to warrant its own review.
  Well-known provider domains are never blocked, and a confirmation dialog (with
  a "don't show this again" opt-out) lists exactly what will be added before
  anything is written.
- Conditions may watch several headers at once via `fields`, so one domain list
  can cover `reply-to` and `from` together.
- Collapsible rule cards with a one-line summary, plus **Collapse all**. Stored
  in `localStorage` as a view preference only, never in the saved config, and
  rules default to collapsed on a first visit with more than three of them.
- Content hashing of rules (`ruleFingerprint` / `ruleHash`). Importing a rule
  that already exists skips it and names the rule it duplicates, so re-importing
  the same file is a no-op. The hash covers folders, conditions, and action but
  ignores name and enabled state, so renaming a rule does not change it.
- Import and export of rule sets as JSON (`src/rules.js`). Exports are named with
  the local date and time (`ffs-rules-YYYY-MM-DD-HHMM.json`) so successive backups
  sort chronologically rather than overwriting each other, and the file records an `exportedAt` timestamp. Imported rules are
  rebuilt field by field from known-good values, so an unknown action, an empty
  domain list, an empty operator value, or a folder absent from this profile is
  dropped and reported instead of stored. Nothing is written until Save.
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
