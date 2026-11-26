# Ledger: how the app works

Ledger is a single-page web app (PWA) over a finance Google Sheet, installed on a phone's home screen and also opened in a desktop browser, where it shows a dashboard layout (see Layouts). It is local-first: the device keeps the full log, computes every balance itself, and uses the sheet only to download new rows, write new rows, and read a few summary values it cannot derive from the log. This file is the reference for anyone changing the app.

This repository is public and served by GitHub Pages. Keep balances, account numbers, people's names, the spreadsheet ID and the connection key out of this file and out of the code. The owner's names (types, tab labels, the sheet's tab names, figure and line names), thresholds, currency, examples and finance definitions live in the sheet (the Config and Definitions tabs, see The sheet), never here.

## Files and deployment

| File | Role |
| --- | --- |
| `index.html` | The whole app: markup, CSS and one `<script>`. Version is the `VERSION` constant near the top of the script. |
| `sw.js` | Service worker. The page is network-first (3-second budget, then the cached copy), so any launch with signal runs the newest version; icons and the manifest are cache-first. Never caches sheet data. |
| `manifest.webmanifest`, `icons/` | Home-screen install metadata. |
| `apps-script/edits.gs`, `apps-script/allocations.gs` | Two files of the sheet's script: editing a logged row, and the allocation slots. |

The back end is a Google Apps Script web app (`Code.gs`) bound to the spreadsheet. Apart from the two files above, its source is **not** in this repo; it lives in the sheet's Apps Script project (Extensions → Apps Script), and changing it needs the owner's Google sign-in. Any change to the script is redeployed through Deploy → Manage deployments → edit → New version, which keeps the `/exec` URL; a new deployment would change it.

### Release checklist

1. Bump `VERSION` in `index.html`.
2. Bump `CACHE` in `sw.js` to the same version (`ledger-vX.Y.Z`). The browser only installs a new service worker when the bytes of `sw.js` change, so skipping this means phones keep the old app.
3. Never commit an empty or truncated `sw.js`. Versions 1.3.1 and 1.8.0 each shipped an empty `sw.js` by accident, breaking offline launch until 1.5.2 and 1.8.1 restored it. Check `test -s sw.js && node --check sw.js` before every commit.
4. Check the script parses, for example `node -e "const h=require('fs').readFileSync('index.html','utf8');new Function(h.slice(h.indexOf('<script>')+8,h.lastIndexOf('</script>')))"`.
5. Commit and push to `main`. The next launch or resume with signal runs the new version.

## Layouts

The same `index.html` has two layouts, and `applyLayout()` picks one when the page loads.

- **Phone:** four tabs with a bottom tab bar, in the order `rep`, `bal`, `act`, `add`. Their labels come from the Config tab.
- **Desktop dashboard:** the `pc` class on `<html>`. The `bal`, `rep` and `act` views sit side by side in three columns that scroll independently, and the tab bar is hidden. The add form becomes a centred modal opened from the header button or the N key, and every other sheet (settings, bulk import, row details, allocations) becomes a centred dialog. The queue of entries waiting to reach the sheet moves to the top of the `act` column.

Auto mode chooses the dashboard when the media query `(hover: hover) and (pointer: fine) and (min-width: 1000px)` matches, and re-checks whenever that query changes. Settings → Layout can force either one (`prefs.layout`: `auto`, `phone` or `pc`).

On the dashboard, `renderView()` renders all three columns, and `switchTab(t)` opens the modal for `add` and otherwise re-renders and briefly highlights that column. Keyboard: N opens the add form, / focuses the search, Enter saves in the modal (Enter on the description takes the top suggestion), Shift+Enter saves and keeps the modal open, Esc closes the top layer.

Each browser keeps its own `localStorage`, so a computer is connected separately in Settings with the same connection code, and its first sync downloads the full log.

## The sheet

The app reads and writes three tabs of the spreadsheet through `Code.gs`, known here by role. The Config rows `sheet tab 1`, `sheet tab 2` and `sheet tab 3` hold their names, for the app's texts and for `edits.gs` and `allocations.gs`.

**The log** (sheet tab 1) is the single source of truth. Columns: Date (`MM/DD/YY`), Transaction (description), Type, Source, Destination, Amount. Amount is always positive; direction comes from Source and Destination. The tab has a block of placeholder rows at the bottom; new rows are written into the blank rows above them, and the app warns when fewer than 40 blank rows remain (`bufferRows`).

**The pairs tab** (sheet tab 2) holds the allowed Source → Destination pairs per Type. The app's pickers and bulk-import validation come only from this (`snap.options.map[type][source] = [destinations]`). The Config rows `outflow type`, `inflow type` and `transfer type` say which of its types plays which role: each row gives the type's value in the log, its label, its plural label, and any further words bulk import accepts for it. The roles drive the math (see Ledger math), the labels drive the buttons and chips. Without those rows the app offers the pairs tab's own types with no roles, so nothing counts as spending or income until the first sync brings the Config. A source listed in the `retired` row stays in the pairs tab, but the app hides it and rejects it in bulk import.

**The summary tab** (sheet tab 3) is parsed by `Code.gs` into `snap.dashboard`:

```
dashboard = {
  summary: [{ label, value, pct, sub }],        // the overview block
  groups:  [{ label, items: [{ name, value, rate, updated }], total }]
}
```

The app finds the summary tab's sections by matching their headers against ten patterns, the Config rows `line 1` to `line 10` (pattern, label; matched without case). Each line has a fixed role in the code:

| Line | Role in the code | Valued |
| --- | --- | --- |
| 1 | spendable accounts, net of their earmark (`walletNet`); in figure 1 and the pool | log |
| 2 | in figure 1 and the pool | log |
| 3 | earmarks (maintaining balances, `earmarkMap`); in figure 1 and taken out again in figure 2 | summary tab |
| 4 | in figure 1 and the pool | log |
| 5 | an asset outside the pool | log |
| 6 | per-person receivables; outside the pool; not derived, so not reconciled | log, compared with the summary tab |
| 7 | an asset outside the pool | log |
| 8 | cards: a liability shown as the amount owed; in figure 2 and the pool | log |
| 9 | allocations: its items other than the payable are the allocations' fallback; not derived, so not reconciled | summary tab |
| 10 | the payable: its pattern finds the payable item in line 9, its third cell names the payable account in the log | log (credit-normal) |

Renaming a section header in the sheet, or changing a line's pattern, changes what the app sees.

**The Config tab** holds every value of the owner's that the app or the two script files need. Row 1 is a header; from row 2, column A is a key and the cells after it are its values, all plain text. Keys are matched without case and the first row of a key wins, except the group rows, which are all read in order. `Code.gs` sends the rows with every sync as `config`; the app keeps the last copy in `ledger.conf` and applies it in `applyConf`.

| Key | Values | Used for | Without the row |
| --- | --- | --- | --- |
| `currency` | the sign | shown before every amount, stripped from typed and pasted amounts | no sign |
| `number locale` | a locale tag | digit grouping | `en-US` |
| `tolerance` | a number | `TOL`: differences at or under it count as zero | 0.005 |
| `outlier` | a number | `CF_BIG`: single rows above it are outliers in the cash flow chart | no outliers |
| `receivable accounts` | account names | per-person receivables; outside the pool | none |
| `allowance account`, `provisioned account`, `accrued income` | one name each | netted accruals (see Report cards) | none netted |
| `not income` | source names | left out of income by source | none |
| `retired` | source names | hidden in pickers, rejected in bulk import | none |
| `group` (several), `reserve group`, `other group` | name, pattern, then category names | the cash flow groups, in stack order | every disbursement in the last group |
| `description example`, `paste example`, `paste hint` | text | placeholders and the hint under the paste button | generic text |
| `outflow type`, `inflow type`, `transfer type` | value, label, plural, further words | the types' roles and labels | the pairs tab's own types, no roles |
| `tab 1` to `tab 4` | a label | the tabs `rep`, `bal`, `act`, `add` | "Tab 1" to "Tab 4" |
| `sheet tab 1` to `sheet tab 3` | a tab name | texts; the tab `edits.gs` writes, the tab `allocations.gs` writes | "Sheet 1" to "Sheet 3" in texts; the scripts refuse to write |
| `figure 1` to `figure 4` | a name; figure 3 also a short form; figure 4 also its summary row | the cascade's names | "Figure 1" to "Figure 4"; no check of figure 4 |
| `line 1` to `line 10` | pattern, label; line 10 also the payable account | the summary tab's sections | the line matches nothing and shows "Line N" |
| `asset mix suffix` | text | stripped from the asset mix legend | nothing stripped |
| `allocation range` | an A1 range, two columns wide | read only by `allocations.gs` | the script refuses to read or write |

A missing name shows a numbered stand-in, so a device that has never synced shows "Tab 1" and no currency sign until its first sync. Names are written in sentence case: where a name falls inside a sentence the app lowers its first letter (`lc()`), unless the second letter is a capital, so an acronym keeps its capitals. Every name is escaped wherever it enters HTML.

**The Definitions tab** holds the owner's finance definitions in his own words: the liquidity cascade, the pool and the Cash flow classes, the groups and outliers, and how particular accounts are treated. Neither the app nor the script reads it. It is the authority for every rule under "Ledger math"; read it, read only, before changing one, and ask the owner before changing a definition.

## Sync protocol

All calls are `POST` to the Apps Script `/exec` URL with a `text/plain` JSON body `{ key, action, ...payload }` (plain text avoids a CORS preflight). Responses are `{ ok, data }` or `{ ok: false, error, auth }`.

| Action | Payload | Returns |
| --- | --- | --- |
| `ping` | none | used by Settings to test the URL and key |
| `sync` | `have`: `{ blockStartRow: hash }` from the last sync | `{ rows, blocks, lastRow, options, dashboard, bufferRows, syncedAt, config }`; `config` is the Config tab or `null`, and a back end that leaves it out still works |
| `add` | `entries`: queued entries with client `id`s, plus `have` | `{ results: [{ id, ok, error }], sync: <same as sync> }` |
| `getAllocs` | none | the four allocation slots, `[{ name, formula, value }]` |
| `setAllocs` | `slots`: four arrays of `{ name, amount, on }` | the slots as written, same shape as `getAllocs` |
| `editRow` | `row`, `expect` (the row as last synced), `entry` (new values) | `{ row }`; the app then syncs to re-pull that row's block |

The log is sent in fixed blocks of rows, each with a hash. The device sends the hashes it holds; the server returns only rows in blocks whose hash changed, and `applySync` replaces those blocks locally and drops rows past `lastRow`. "Re-download the full log" in Settings clears the hashes to force a full pull.

`Code.gs` writes each entry id once: an entry resent after a lost reply is answered as done and not written again. An edit made to a queued entry whose first send had already reached the sheet is therefore not applied; after the next sync the list shows the sheet's values, and the row is corrected there.

The connection code the owner pastes is `<exec URL>#<key>`; Settings splits it. `showKey()` in the script editor prints the current key.

## Local state (`localStorage`)

| Key | Contents |
| --- | --- |
| `ledger.cfg` | `{ url, key }` |
| `ledger.rows` | The full log, ascending by sheet row: `{ row, date (YYYY-MM-DD), desc, type, source, dest, amount }` |
| `ledger.blocks` | Block hashes from the last sync |
| `ledger.snap` | `{ options, dashboard, bufferRows, syncedAt, lastRow }` |
| `ledger.queue` | Entries logged on the device and not yet confirmed by the sheet; `status` is `pending` or `failed` |
| `ledger.prefs` | Last-used pickers, current tab, which cards are open or closed |
| `ledger.allocs` | The allocation lines and whether a change is waiting to be sent |
| `ledger.conf` | The Config tab's rows from the last sync that carried them |

Entries are written to the queue first and flushed when online (`flush`). Rejected entries stay in the queue with the server's error and can be edited, retried or deleted. Bulk import parses pasted tab-separated rows (for example rows copied from the sheet), validates them against the pairs tab, flags likely duplicates (same source and amount within 7 days) and future dates, and pushes the selected rows into the same queue. The app is the only writer to the log.

### Editing a logged row

Opening a row and choosing Edit shows an editor with the same type, source and destination pickers as the add form, limited to the pairs tab's pairs. A value the pairs tab no longer lists stays selectable on its own row, marked as not in that tab, so opening the editor never changes it silently. The editor shows each balance the change moves, computed by reversing the old row and applying the new one.

- **Queued entry:** the entry is changed in the queue and sent on the next flush. It cannot be edited while a flush is in flight.
- **Sheet row:** needs a connection. The app sends `editRow` with the row as it last synced it. `editRow_` in `apps-script/edits.gs` overwrites columns A to F of that row only if the sheet still holds exactly those values (whitespace-insensitive, amount within 0.005) and the row has no formulas; otherwise it refuses with "changed in the sheet since your last sync" and the app syncs. A date cell keeps its kind: a real date stays a date, text stays `MM/DD/YY`. The app patches its local copy at once, and the next sync re-pulls the block because its hash changed.

Deleting rows is not supported, because removing a row shifts every row number below it.

`edits.gs` sits beside `Code.gs`, and `doPost` routes `editRow` to `editRow_(body.row, body.expect, body.entry)` inside the same key check as the other actions. It reads the log's tab name from the Config tab (`configValue_('sheet tab 1')` in `Code.gs`) and refuses to write without it; the type must be a type of the pairs tab, and a new pair must be one of its pairs (`readOptions_()`).

## Ledger math

All balances come from one rule, the same one the summary tab's cells use: **an account's balance is the sum of Amount where it is the Destination, minus the sum of Amount where it is the Source, over every row.** `derived()` computes this twice, as `synced` (sheet rows only) and `live` (sheet rows plus pending queue entries). `bal(name)` returns the live figure. `derived()` is memoised and reset by `dirty()` whenever rows, the queue or the Config change.

- Card accounts carry negative balances when money is owed, so adding them reduces liquidity.
- A row dated in the future still counts in every balance.
- Accounts are every source of an outflow-type row, every source or destination of a transfer-type row, and every destination of an inflow-type row (`derived().accounts`). An outflow-type row into a non-account is spending in that category.

### Reconciliation against the summary tab

For every name in a summary section (excluding lines 6 and 9, which the app cannot derive: `sheetOnly`), the app sums that name's summary cells across sections and compares with its own synced balance. Differences over the tolerance (`TOL`) show as an amber card on the `bal` view. A name appearing in both line 1 and line 3 (an account with a maintaining balance) is summed across both, which gives back its full balance.

### Maintaining balances (earmarks)

Line 3 lists maintaining balances held inside accounts. The app reads those amounts from the summary tab (`earmarkMap`) and never hardcodes a cap. An earmark smaller than the account's balance is a cap: only the excess counts as a line 1 balance (`walletNet`), and an excess at or under the tolerance shows as 0. An earmark equal to the whole balance leaves nothing. Between syncs an earmark stays at its last-synced value even if a queued entry changes that account's balance.

### The cascade

`cascade(dash)` computes these for the `bal` view; `liqLedger` applies the same maintaining-balance rule day by day for the `rep` view. The owner's wording and reasons are in the Definitions tab.

| Figure | Formula |
| --- | --- |
| Line 1, net | each line 1 account's balance less its earmark; at or under the tolerance (including negatives) it is 0 |
| Figure 1 | line 1, net + line 3 + line 2 + line 4 |
| Figure 2 | figure 1 − line 3 − the payable − line 8 owed |
| Figure 3 | figure 2 − the included allocation lines (see Allocations), which never include the payable |
| Figure 4 | total assets − total liabilities of the balance sheet below; compared with the summary row named in the `figure 4` row |

Line 3 comes from the summary tab; allocations come from the app's own list, synced with the sheet's allocation slots. The payable is the log's payable account (the third cell of `line 10`), which is credit-normal: the app negates its balance, and falls back to the summary tab's payable item only if the log never touches the account. Without a payable account the payable line is left out and counts as 0. Everything else is the app's own log math.

### Cash flow and the figure 2 line

The cash flow bars show what moves figure 2, and the line beside them is figure 2. Both come from `liqLedger(start)`, one pass over the log, so the bars add up exactly to the line's movement over any window.

- **The pool** is every account money can be spent from: the pairs tab's outflow-type sources and the accounts of lines 1, 2, 4 and 8, plus the payable account. The accounts of lines 5, 6 and 7, the receivable accounts and the allowance account are outside it.
- **Values:** each account counts at its exact log balance, with no flooring. An account whose earmark equals its whole balance today is fully restricted on every day; any other earmark is a cap, and only the excess counts.
- **Effect of a row:** the pool's value after the row less its value before. A positive effect is a collection and a negative one a disbursement.
- **Classes:** income into the pool is a collection. Spending from an account, a card or the payable is a disbursement when made. Money sent to an account outside the pool, and money moved into a maintaining balance, are disbursements, and the reverse moves are collections; a maintaining-balance move is labelled "<account> balance". Accruals and transfers between pool accounts count as zero.
- **Rows dated after today** are left out of both charts, and their effect is shown separately.
- **Today's value** can differ from the `bal` view's figure 2 only where that view floors a small or negative balance, or leaves out an account that is in no summary section. The card states the difference.
- **Quarters and spans:** the line card heads with the average monthly net effect for each calendar quarter in the window. Spans are 3, 6, 12 or 18 months; both cards always share the span. "Hide details" leaves only the chart on either card.
- **Views** (`prefs.cfView`): one pairs the collections bar with the disbursements bar; the other drops collections and widens the disbursement bars. Both use the same disbursements.
- **Groups:** each disbursement is placed in one of `CF_GROUPS` by `cfGroupOf(label, kind)`: a maintaining-balance move goes to the reserve group; otherwise an exact category name wins; otherwise money sent to an account outside the pool goes to the reserve group; otherwise the first group whose pattern matches; otherwise the last group. Without a reserve group those moves go to the last group. The stack order is the order of the group rows, bottom to top. Colours go by position (`--g1` to `--g7`, with `--g8` for the last group) and were checked as adjacent pairs for colour-blind separation in both themes, so a reorder of the rows needs that check redone.
- **Outliers:** any single row whose disbursement effect is more than the `outlier` value is kept apart (`f.big`, `f.gb`). The overlay mode (`prefs.cfAdj = 'overlay'`) draws those rows on top of the stack, hatched in their group's colour; the adjusted mode leaves them out and rescales the chart. The card's average line gives both averages.
- **Hover:** a mouse or pen hovering a month shows a card with collections, disbursements, the adjusted figure, each group's amount and every outlier row; pointing at one colour lists that group's categories. On touch the same card opens on a long-press (420 ms), follows the finger while held, stays up after lifting and swallows that tap. `wireCF` holds this logic.

Spending by category and income by source use `reportData` and are not liquidity measures.

### Allocations

The app owns the list of allocations (`ledger.allocs`): one line per allocation with a name, a whole-number amount and an include toggle, edited from the allocations card on the `bal` view. Only included lines count in figure 3.

The sheet has four slots for them, the Config tab's `allocation range`, directly under the payable row of the summary tab, which the app never writes. `packAllocs` spreads the list across the slots in order, as evenly as possible with the larger groups first (nine lines become 3 + 2 + 2 + 2). Each slot's name cell joins its names with ", " and its amount cell is a formula joining the amounts with "+"; an excluded amount is written `(N*0)` so it stays visible but adds nothing. Example: `Allocation A, Allocation B` / `=1000+(2000*0)`. A formula that totals the block keeps working.

`apps-script/allocations.gs` holds the server side: `setAllocs_` builds the formulas itself from validated items (no client-supplied formula text reaches the sheet), and `getAllocs_` returns each slot's name, formula and value. Both read the tab and the range from the Config tab and refuse to act when either row is missing or malformed. `parseAllocSlot` reads a slot back into lines. It accepts `N`, `(N*0)`, `N*0` and `(N)*0` terms, treats a slot whose name count doesn't match its terms as one line, and treats a typed number as one included line, so slots edited by hand in the sheet still read in. Names therefore cannot contain a comma or a plus sign.

Edits are saved on the device first (`allocs.pending`) and sent as the whole list on the next sync, so the device's list wins over hand edits made in the sheet since the last sync. If the script stops answering these actions, the card falls back to the summary tab's values read-only, and editing turns off until a sync succeeds again.

### Balance sheet

Assets are lines 1 (after earmarks), 2, 3, 4, 5, 6 and 7; liabilities are line 8 (shown as positive amounts owed) and the payable. Every line except line 3 is valued from the log. A memo section lists any account in the log that is in no summary section. Line 7's group key is `l7`.

### Per-person receivables

Per-person receivables are tracked by description: for rows whose source or destination is one of the `receivable accounts`, the description is the person's name, and the balance is money into those accounts minus money out. Names match case-insensitively and ignore repeated spaces, and the most recent spelling is the one displayed. People on the summary tab's line 6 are compared with it; people only in the log appear under a note and are excluded from the total.

### Report cards

- **Cash flow:** monthly collections and disbursements, described above.
- **Spending by category and income by source** (`reportData`): income leaves out the sources in the `not income` row; spending is outflow-type rows into non-accounts, and never includes rows into the allowance account.
- **Netted accruals:** an inflow-type row from the `accrued income` source is dropped from income by source when an outflow-type row from the `provisioned account` to the `allowance account` has the same date, description and amount, because no cash moved. The cash flow chart never counts accruals at all. Account balances are unaffected.
- **The figure 2 line:** daily, described above.
- **Spending by category:** monthly averages over the last 3, 6, 12 or 18 complete months.
- **Income by source:** totals over the selected window, including the current month.
- **Asset mix:** straight from the summary rows marked as sub-items, with the Config tab's suffix stripped from their labels.

## Conventions

- Money displays in finance style: negatives in parentheses, `(1,200.00)` with the Config tab's currency sign in front, via `money()`.
- `TOL` comes from the Config tab's `tolerance` row: differences at or under it are treated as zero.
- Tab order is `rep`, `bal`, `act`, `add`. On the desktop dashboard the column order is `bal`, `rep`, `act`.
- Dates are stored as ISO `YYYY-MM-DD` on the device and written to the sheet as `MM/DD/YY`.

## Version history

| Version | Change |
| --- | --- |
| 1.1.0 | Local-first rebuild: full log on the phone, client-side balances, offline queue |
| 1.2.0 | Live figure 2 with breakdown and a summary-tab check |
| 1.3.0 | Figure 3 as the `bal` headline |
| 1.3.1 | Parenthesised negatives (also emptied `sw.js` by accident) |
| 1.4.0 | Bulk import |
| 1.5.0 | `bal` as a pro forma balance sheet; a reports tab replaces an older one |
| 1.5.1 | Tab order: `rep` first, `add` last |
| 1.5.2 | Figure 1 → figure 2 bridge in the reports; `sw.js` restored; this document |
| 1.6.0 | Cascade redefined (line 4 counts in figure 1, the payable out of allocations); the reports line is figure 2; the summary-cell comparison dropped |
| 1.7.0 | Allocations editor with include toggle, packed into the summary tab's four allocation slots |
| 1.7.1 | Network-first page loading and an update check on resume, so new versions arrive on the next open |
| 1.7.2 | The reports leave out netted accruals |
| 1.7.3 | Per-person receivables match names case-insensitively, like the summary tab |
| 1.8.0 | Cash flow becomes collections and disbursements of liquidity; the line reconciles with the bars; quarterly average monthly net effect |
| 1.8.1 | 18-month span; span chips on the line card; Hide/Show details on both cards; month highlight no longer covers the chart's top label; restores `sw.js`, which 1.8.0 shipped empty |
| 1.8.2 | Hide details leaves only the chart on both report cards |
| 1.9.0 | The reports line is figure 2; the pool covers every spendable account and the payable at exact balances (no flooring), so own-account transfers no longer show as flows; earmark top-ups count as disbursements |
| 1.10.0 | Desktop dashboard layout, detected on load: three columns, the add form as a modal, centred dialogs, keyboard shortcuts; Settings → Layout override |
| 1.11.0 | Edit any logged row from `act`: queued entries in place, sheet rows through the new `editRow` action (`apps-script/edits.gs`), with a balance-effect preview |
| 1.12.0 | Cash flow: outflow-type view, disbursements stacked by spending group, outlier rows hatched (overlay) or left out (adjusted), hover card with groups, categories and outliers; long-press on touch |
| 1.12.0, republished | The owner's names, thresholds, currency and examples come from the sheet's Config tab (`config` in the sync reply, kept in `ledger.conf`); `edits.gs` and `allocations.gs` read their tab names and range from it; `Code.gs` writes each entry id once. |
