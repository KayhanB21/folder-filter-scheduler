# Privacy Policy

**Folder Filter Scheduler does not collect, transmit, sell, or share any data.**

Everything the add-on does happens locally, inside your own Thunderbird, on your
own device.

## What it accesses, and why

To evaluate the rules you create, the add-on reads message data (such as the
`From`, `Subject`, and `Reply-To` headers, and — only when a rule needs it — the
full message) from the folders **you** select. It uses this access solely to:

- decide whether a message matches one of your rules, and
- perform the action you configured (move, copy, mark, or delete that message).

## What leaves your device

**Nothing.** The add-on makes no network requests of its own, contacts no external
servers, and includes no analytics, telemetry, or tracking. Message content is
never sent anywhere; it is only inspected in memory to test your rules.

## What is stored

Your rule configuration (folders, conditions, actions, and the schedule interval)
is saved with Thunderbird's local extension storage on your device. It is not
uploaded anywhere and is removed if you uninstall the add-on.

## Permissions

The requested permissions (`accountsRead`, `messagesRead`, `messagesMove`,
`messagesDelete`, `messagesUpdate`, `storage`, `alarms`) are used only to read the
folders you choose, act on matching messages as you configured, store your rules,
and run them on a timer. They are not used for any other purpose.

## Contact

Questions or concerns: open an issue at
https://github.com/KayhanB21/folder-filter-scheduler/issues
