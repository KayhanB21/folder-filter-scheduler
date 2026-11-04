# Translate Folder Filter Scheduler

This page explains how to add or update a translation of the add-on's interface. After reading it, you can write a `messages.json` file for your language and check it with `npm test`.

## Files

The English source is `_locales/en/messages.json`. Every text on the settings page, the toolbar popup, the Add spam domains window, and the right-click menu comes from it.

To translate, follow these steps:

1. Copy `_locales/en/messages.json` to `_locales/LANG/messages.json`. `LANG` is a WebExtension locale code, such as `de`, `pt_BR`, or `zh_CN`.
2. Translate the `message` of each entry. Don't change the key names.
3. Delete or keep the `description` of each entry. Thunderbird doesn't show it.
4. Run `npm test`. The test in `test/i18n.test.js` checks your file.

If you leave out a key, Thunderbird shows the English text for it. You can translate part of the file and add the rest later.

The `extensionDescription` message must stay within 132 characters, because the add-ons manager cuts longer text.

## Key names

A key is an area, an underscore, and a name in camel case, such as `status_runFailed`. The area tells you where the text appears.

The following list names each area:

- `common`: text that more than one page uses.
- `menu`: the right-click menu.
- `options`, `allowlist`, `diag`, `adv`, and `help`: the sections of the settings page.
- `rule`, `cond`, `action`, `field`, `op`, `state`, and `priority`: a rule card and its condition and action rows.
- `folders`: the folder list of a rule.
- `summary`: the one-line summary of a folded rule.
- `schedule` and `cron`: the schedule of a rule and the description of a cron expression in words.
- `status`, `reject`, `setting`, and `import`: the status line, the corrections after **Save**, and the problems after **Import**.
- `popup` and `confirm`: the toolbar popup and the Add spam domains window.

A key with a hyphen in the stored name uses an underscore instead. For example, the field `reply-to` reads `field_reply_to`.

A `state` key also names the operator, such as `state_read_isOn` for "is read". The plural suffixes in the section on plural forms are the only other underscores.

## Values in a message

`$1`, `$2`, and so on stand for values the add-on fills in, such as a rule name or a number. The `description` of each entry says what each one is.

Keep every `$N` of the English message in your translation. You can move them, so the word order of your language works. The test fails if a translation drops or adds a `$N`.

In some labels, a `$N` stands for a form control, such as a number box or a list. For example, `options_runEvery` is "Run every $1 minutes", and `$1` is the number box. The following keys hold a control:

- `options_runEvery`
- `adv_newMailDelay`
- `adv_catchUp`, which holds two
- `adv_overlap`
- `adv_authServer`
- `adv_authPrefer`
- `adv_authTrusted`

## Plural forms

A message that depends on a number has one key for each plural form. The base name gets a suffix: `_zero`, `_one`, `_two`, `_few`, `_many`, or `_other`. These are the [CLDR plural categories](https://cldr.unicode.org/index/cldr-spec/plural-rules).

English defines `_one` and `_other`. In your file, define every category that your language uses, and always define `_other`. The add-on picks the category with `Intl.PluralRules` for the Thunderbird language.

The following examples show which keys to write:

- Japanese, Korean, and Chinese use only `_other`. Leave out `_one`.
- German, Spanish, and Italian use `_one` and `_other`.
- Polish uses `_one`, `_few`, `_many`, and `_other`.

If your language uses a category and your file doesn't define it, the add-on shows `_other` from your file. The exception is `_one`: if your file leaves it out, Thunderbird shows the English `_one` text.

The count isn't always `$1`. The `description` of each plural key says which `$N` holds it.

## Messages with markup

Some messages contain `<b>`, `<code>`, or `<a>`. Keep each tag, and keep the same number of each. The test checks this.

The following rules apply to these messages:

- Translate the text inside `<b>` and `<a>`. The text inside `<b>` often names a button or a section, so use the same words as that message. The description names the key.
- Keep the text inside `<code>` as it is. It is a header name or an address.
- Don't nest tags, and don't add other tags or attributes. The add-on shows any other `<…>` text as plain text.

The add-on builds the page from these parts itself. It never inserts a message as HTML.

## Names from Thunderbird

Some messages name parts of Thunderbird, such as the folder **Properties** dialog in `help_otherFolderFix` or the priority names. Use the words that Thunderbird shows in your language.

## The cron description

The rule schedule uses cron expressions. The add-on describes an expression in words, such as "At 09:00 on Monday through Friday". It builds the sentence from the `cron_` messages:

- `cron_withDays` joins the time part and the days part, and `cron_withMonths` adds the months part. Swap `$1` and `$2` if your language puts that part first.
- The browser supplies the weekday names, the month names, and the way a list is joined ("a, b, and c"), in the Thunderbird language. Don't translate them.
- The expression itself stays in cron syntax, with English names such as `mon` and `jan`.

## Quotation marks

The English text puts rule names in curly quotation marks: “Spam”. Use the quotation marks of your language. The `common_quoted` message holds them for lists of names.

## Text that stays English

The following text stays English, and it has no key:

- The diagnostics log and the diagnostics report. People paste them into GitHub issues.
- The error details that some messages show as `$1`, such as in `status_runFailed`. They come from Thunderbird or the add-on's own checks.
- The code words in import problems, such as operator ids or `spf`, `dkim`, and `dmarc`.
- The name of the spam rule that Add spam domains creates, `Spam domains`. The add-on finds that rule by its name.

## The right-click menu

Don't use `&` in the menu titles `common_addSpamDomains`, `common_runAllRulesNow`, and `menu_runARule`. A menu reads `&` as the mark of an access key.
