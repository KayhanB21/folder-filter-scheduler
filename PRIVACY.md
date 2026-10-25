# Privacy Policy

**Folder Filter Scheduler does not collect, sell, or share any data.**

Everything the add-on does happens locally, inside your own Thunderbird, on your
own device. The one exception is the DKIM check described under
"What leaves your device", which sends DNS lookups only after you allow it.

## What it accesses, and why

To evaluate the rules you create, the add-on reads message data (such as the
`From`, `Subject`, and `Reply-To` headers, and — only when a rule needs it — the
full message) from the folders **you** select. It uses this access solely to:

- decide whether a message matches one of your rules, and
- perform the action you configured (move, copy, mark, or delete that message).

## What leaves your device

Message content is never sent anywhere; it is only inspected in memory to test
your rules. The add-on includes no analytics, telemetry, or tracking.

The add-on contacts one external server, and only in this case: a rule has an
authentication condition (SPF, DKIM, or DMARC), **Verify DKIM myself** is on
under **Advanced**, and you allowed the DNS server when Thunderbird asked. To
verify a DKIM signature, the add-on looks up the sender's public key and DMARC
record with DNS over HTTPS. It sends the server you chose (Cloudflare or Google)
domain names such as `selector._domainkey.example.com` and
`_dmarc.example.com`. That server sees these names and your IP address, under
its own privacy policy. Nothing else from the message is sent.

To avoid these lookups, turn off **Verify DKIM myself**, or don't allow the DNS
server. Rules without an authentication condition never contact it.

## What is stored

Your rule configuration (folders, conditions, actions, and the schedule interval)
is saved with Thunderbird's local extension storage on your device. The results
of authentication checks are kept there too, for up to 90 days, keyed by a hash
of each message's Message-ID, sender, date, and size. Nothing is uploaded
anywhere, and everything is removed if you uninstall the add-on.

## Permissions

The requested permissions (`accountsRead`, `messagesRead`, `messagesMove`,
`messagesDelete`, `messagesUpdate`, `storage`, `alarms`) are used only to read the
folders you choose, act on matching messages as you configured, store your rules,
and run them on a timer. They are not used for any other purpose.

Optional permissions are asked for only when you use the feature that needs them:
address books for address-book conditions, the tag list for tag conditions and
actions, and one DNS server (`cloudflare-dns.com` or `dns.google`) for the DKIM
check.

## Contact

Questions or concerns: open an issue at
https://github.com/KayhanB21/folder-filter-scheduler/issues
