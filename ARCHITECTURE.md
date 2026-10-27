# Ledger: how the app works

Ledger is a single-page iPhone home-screen web app (PWA) over the owner's Personal Finances Google Sheet. It is local-first: the phone keeps the full Transactions log, computes every balance itself, and only uses the sheet to download new rows, write new rows, and read a few Dashboard values it cannot derive from the log. This file is the reference for anyone changing the app, so that the logic below does not have to be rediscovered from chat history.

This repository is public and served by GitHub Pages. Keep balances, account numbers, people's names, the spreadsheet ID and the connection key out of this file and out of the code.

## Files and deployment

| File | Role |
| --- | --- |
| `index.html` | The whole app: markup, CSS and one `<script>`. Version is the `VERSION` constant near the top of the script. |
| `sw.js` | Service worker. The page is network-first (3-second budget, then the cached copy), so any launch with signal runs the newest version; icons and the manifest are cache-first. Never caches sheet data. |
| `manifest.webmanifest`, `icons/` | Home-screen install metadata. |

The back end is a Google Apps Script web app (`Code.gs`) bound to the spreadsheet. Apart from `apps-script/allocations.gs`, its source is **not** in this repo; it lives in the sheet's Apps Script project (Extensions → Apps Script). Changing it needs the owner's Google sign-in. Changes to this repo need only a push to `main`; GitHub Pages republishes in about a minute.

### Release checklist

1. Bump `VERSION` in `index.html`.
2. Bump `CACHE` in `sw.js` to the same version (`ledger-vX.Y.Z`). The browser only installs a new service worker when the bytes of `sw.js` change, so skipping this means phones keep the old app.
3. Never commit an empty or truncated `sw.js`. Version 1.3.1 shipped an empty `sw.js` by accident and offline launch was broken until 1.5.2 restored it.
4. Check the script parses, for example `node -e "const h=require('fs').readFileSync('index.html','utf8');new Function(h.slice(h.indexOf('<script>')+8,h.lastIndexOf('</script>')))"`.
5. Commit and push to `main`. From v1.7.1, the next launch or resume with signal runs the new version. Earlier versions were cache-first and needed two launches.

## The sheet

The app reads and writes three parts of the spreadsheet through `Code.gs`.

**Transactions tab** is the single source of truth. Columns: Date (`MM/DD/YY`), Transaction (description), Type, Source, Destination, Amount. Amount is always positive; direction comes from Source and Destination. Type is one of `Outflows`, `Inflow`, `Transfer` (note the plural `Outflows`, which is how the sheet spells it). The tab has a block of placeholder rows at the bottom; new rows are written into the blank rows above them, and the app warns when fewer than 40 blank rows remain (`bufferRows`).

**Data tab** holds the allowed Source → Destination pairs per Type. The app's pickers and bulk-import validation come only from this (`snap.options.map[type][source] = [destinations]`). `Reimbursement` is still listed there but is retired: the app hides it and rejects it in bulk import (`RETIRED`). Do not reintroduce it.

**Dashboard tab** is parsed by `Code.gs` into `snap.dashboard`:

```
dashboard = {
  summary: [{ label, value, pct, sub }],        // OVERVIEW block: Gross Assets, Net Liquidity, Net Assets, ...
  groups:  [{ label, items: [{ name, value, rate, updated }], total }]
}
```

Group labels the app matches by regex: `/wallet/i`, `/saving/i`, `/credit/i`, `/restricted/i` (earmarks), `/short term/i`, `/long term/i`, `/receivable/i`, `/venture/i`, `/allocated/i`. Renaming a Dashboard section header changes what the app sees.

## Sync protocol

All calls are `POST` to the Apps Script `/exec` URL with a `text/plain` JSON body `{ key, action, ...payload }` (plain text avoids a CORS preflight). Responses are `{ ok, data }` or `{ ok: false, error, auth }`.

| Action | Payload | Returns |
| --- | --- | --- |
| `ping` | none | used by Settings to test the URL and key |
| `sync` | `have`: `{ blockStartRow: hash }` from the last sync | `{ rows, blocks, lastRow, options, dashboard, bufferRows, syncedAt }` |
| `add` | `entries`: queued entries with client `id`s, plus `have` | `{ results: [{ id, ok, error }], sync: <same as sync> }` |
| `getAllocs` | none | the four allocation slots, `[{ name, formula, value }]` |
| `setAllocs` | `slots`: four arrays of `{ name, amount, on }` | the slots as written, same shape as `getAllocs` |

The log is sent in fixed blocks of rows, each with a hash. The phone sends the hashes it holds; the server returns only rows in blocks whose hash changed, and `applySync` replaces those blocks locally and drops rows past `lastRow`. "Re-download the full log" in Settings clears the hashes to force a full pull.

The connection code the owner pastes is `<exec URL>#<key>`; Settings splits it. `showKey()` in the script editor prints the current key.

## Local state (`localStorage`)

| Key | Contents |
| --- | --- |
| `ledger.cfg` | `{ url, key }` |
| `ledger.rows` | Full Transactions log, ascending by sheet row: `{ row, date (YYYY-MM-DD), desc, type, source, dest, amount }` |
| `ledger.blocks` | Block hashes from the last sync |
| `ledger.snap` | `{ options, dashboard, bufferRows, syncedAt, lastRow }` |
| `ledger.queue` | Entries logged on the phone and not yet confirmed by the sheet; `status` is `pending` or `failed` |
| `ledger.prefs` | Last-used pickers, current tab, which cards are open or closed |

Entries are written to the queue first and flushed when online (`flush`). Rejected entries stay in the queue with the server's error and can be edited, retried or deleted. Bulk import parses pasted tab-separated rows (the output of the personal-finance-logger skill), validates them against the Data tab, flags likely duplicates (same source and amount within 7 days) and future dates, and pushes the selected rows into the same queue. The app is the only writer to the Transactions tab.

## Ledger math

All balances come from one rule, the same one the Dashboard's `SUMIF` cells use: **an account's balance is the sum of Amount where it is the Destination, minus the sum of Amount where it is the Source, over every row.** `derived()` computes this twice, as `synced` (sheet rows only) and `live` (sheet rows plus pending queue entries). `bal(name)` returns the live figure. `derived()` is memoised and reset by `dirty()` whenever rows or the queue change.

Consequences worth remembering:

- Credit card accounts carry negative balances when money is owed, so adding them reduces liquidity.
- A row dated in the future still counts in every balance, because the Dashboard's `SUMIF`s ignore dates.
- Accounts are every Source of an Outflow, every Source or Destination of a Transfer, and every Destination of an Inflow (`derived().accounts`). An Outflow into a non-account is spending in that category.

### Reconciliation against the Dashboard

For every name in a Dashboard group (excluding Allocated and Receivables, which the app cannot derive), the app sums that name's Dashboard cells across groups and compares with its own synced balance. Differences over ₱1 show as an amber "accounts differ" card on Balances. A name appearing in both Wallets and Restricted Cash (an account with a maintaining balance) is summed across both, which gives back its full balance.

### Maintaining balances (earmarks)

The Dashboard's **Restricted Cash** group lists maintaining balances held inside bank accounts. There are two kinds:

- **Active account with a cap.** The restricted cell is the account's balance capped at a fixed amount (the cap is written into the Dashboard formula). Only the excess over the cap counts as a wallet balance.
- **Unused account.** The restricted cell is the account's whole balance, uncapped, because nothing in it is meant to be spent. Such an account may or may not also be listed in Wallets; either way it contributes nothing to Net liquidity.

The app reads the restricted amounts from the Dashboard (`earmarkMap`) and never hardcodes a cap. Between syncs an earmark stays at its last-synced value even if a queued entry changes that account's balance.

### The liquidity cascade

These definitions are the owner's and must not drift. `cascade(dash)` computes all of them for Balances; `netLiqSeries` applies the same rule day by day for Reports.

| Figure | Rule |
| --- | --- |
| Wallets, net | Each Wallets account's balance less its maintaining balance; a result of ₱1 or less (including negatives) shows as ₱0. |
| **Liquid assets** | Wallets, net + Restricted cash + Savings + Short-term investments. Long-term investments, receivables and ventures are not liquid. |
| **Net liquidity** | Liquid assets − Restricted cash − Accounts payable − Credit cards owed. |
| **Net cash available** | Net liquidity − cash allocations. Allocations are the app's included allocation lines (see Cash allocations), which never include Accounts Payable since it is already deducted in Net liquidity. This is the Balances headline. |
| **Net assets** | Total assets − total liabilities from the balance sheet below. |

Sources: Restricted cash comes from the Dashboard; allocations come from the app's own list, synced with the Dashboard's allocation slots. Accounts payable is the log's `Accounts Payable` account, which is credit-normal (money owed makes its Destination − Source balance negative); the app negates it, and falls back to the Dashboard line only if the log never touches the account. Everything else is the app's own log math.

The Dashboard's own Net Liquidity and Net Cash Available cells still use an older definition (no short-term investments, AP inside allocations), so the app no longer compares against them. Per-account reconciliation still runs.

### Net liquidity trend (Reports)

`netLiqSeries(days)` rebuilds Net liquidity for each day from rows dated up to today. For history it needs the maintaining-balance rule per day: a wallet whose earmark equals its whole balance today is treated as an unused account and fully restricted on every day; any other earmark is treated as a cap, so the wallet contributes `walletNet(raw, min(raw, cap))`. Accounts payable, savings, short-term investments and credit cards are summed directly. The card under the chart shows today's cascade and notes any entries dated after today (counted in Balances, left off the line), which are the only reason the line's last point can differ from the Balances figure.

### Cash allocations

The app owns the list of cash allocations (`ledger.allocs`): one line per allocation with a name, a whole-peso amount and an include toggle, edited from the Cash allocations card on Balances. Only included lines count in Net cash available.

The sheet has four slots for them, Dashboard `K21:L24`, directly under the Accounts Payable row (`K20:L20`, a log `SUMIF` the app never writes). `packAllocs` spreads the list across the slots in order, as evenly as possible with the larger groups first (nine lines become 3 + 2 + 2 + 2). Each slot's name cell joins its names with ", " and its amount cell is a formula joining the amounts with "+"; an excluded amount is written `(N*0)` so it stays visible but adds nothing. Example: `Emergency Fund, House Balance` / `=360000+(523013*0)`. The Dashboard's `=SUM(L20:L24)` total keeps working, and the app never shows the per-slot sums.

`apps-script/allocations.gs` holds the server side: `setAllocs_` builds the formulas itself from validated items (no client-supplied formula text reaches the sheet), and `getAllocs_` returns each slot's name, formula and value. `parseAllocSlot` reads a slot back into lines. It accepts `N`, `(N*0)`, `N*0` and `(N)*0` terms, treats a slot whose name count doesn't match its terms as one line, and treats a typed number as one included line, so slots edited by hand in the sheet still read in. Names therefore cannot contain a comma or a plus sign.

Edits are saved on the phone first (`allocs.pending`) and sent as the whole list on the next sync, so the phone's list wins over hand edits made in the sheet since the last sync. If the script ever stops answering these actions, `getAllocs` fails, the card falls back to the Dashboard's values read-only, and editing turns off until a sync succeeds again.

**Deployment (done Oct 27, 2026):** `allocations.gs` sits beside `Code.gs` in the sheet's Apps Script project, and `doPost`'s switch routes `case 'getAllocs': return json_({ ok: true, data: getAllocs_() });` and `case 'setAllocs': return json_({ ok: true, data: setAllocs_(body.slots) });` inside the same key check as the other actions. Any later change to the script must be redeployed through Deploy → Manage deployments → edit → New version, which keeps the `/exec` URL; a new deployment would change it.

### Balance sheet (Balances tab)

Assets: Wallets (after earmarks), Savings, Restricted cash (Dashboard values), Short-term investments, Long-term investments, Receivables, Ventures. Liabilities: Credit cards (shown as positive amounts owed), Accounts payable (from the log). Every line except Restricted cash is valued from the log. A memo section lists the cash allocations (excluding Accounts Payable) and any account in the log that is on no Dashboard group.

### Receivables

Per-person receivables are tracked by **description**: for rows whose Source or Destination is `Lending Receivables` or `Other Receivables`, the Transaction text is the person's name, and the balance is money into those accounts minus money out. Names match case-insensitively and ignore repeated spaces, the same way the Dashboard's `SUMIF` treats them, and the most recent spelling is the one displayed. People on the Dashboard's Receivables list are compared with the Dashboard; people only in the log appear under "Also open in the log" and are excluded from the total.

### Reports

- **Cash flow**: monthly inflows and spending. Inflows exclude `Set-up` (opening balances), `Lending Receivables` and `Allowance for Bad Debts` (`INFLOW_EXCLUDE`). Spending is Outflows into non-accounts, and never includes Outflows into `Allowance for Bad Debts`.
- **Netted accruals**: interest on a loan that is fully provided for is logged as a pair on the same date with the same description and amount: an Inflow `Lending Income` → `Lending Receivables` and an Outflow `Lending Receivables` → `Allowance for Bad Debts`. No cash moves, so `reportData` drops the `Lending Income` half of every such pair from inflows and from Inflows by source. When those debts are recovered, the owner replaces the paired rows with ordinary `Lending Income` rows on the cadence the money actually arrives; those have no matching provision and count as inflows. Balances are unaffected, because each pair nets to zero in `Lending Receivables`.
- **Net liquidity**: daily trend line, described above.
- **Spending by category**: monthly averages over the last 3, 6 or 12 complete months.
- **Inflows by source**: totals over the selected window, including the current month.
- **Asset mix**: straight from the Dashboard summary rows marked as sub-items.

## Conventions

- Money displays in finance style: negatives in parentheses, `(₱1,200.00)`, via `peso()`.
- `TOL = 1`: differences of ₱1 or less are treated as zero, matching the Dashboard.
- Tab order is Reports, Balances, Activity, Add.
- Dates are stored as ISO `YYYY-MM-DD` on the phone and written to the sheet as `MM/DD/YY`.

## Version history

| Version | Change |
| --- | --- |
| 1.1.0 | Local-first rebuild: full log on the phone, client-side balances, offline queue |
| 1.2.0 | Live Net liquidity with breakdown and Dashboard check |
| 1.3.0 | Net cash available as the Balances headline |
| 1.3.1 | Parenthesised negatives (also emptied `sw.js` by accident) |
| 1.4.0 | Bulk import |
| 1.5.0 | Balances as a pro forma balance sheet; Reports tab replaces Owed |
| 1.5.1 | Tab order: Reports first, Add last |
| 1.5.2 | Liquid balance → Net liquidity bridge on Reports; `sw.js` restored; this document |
| 1.6.0 | Liquidity cascade redefined (short-term investments liquid, AP out of allocations); Reports trend line is Net liquidity; Dashboard summary-cell comparison dropped |
| 1.7.0 | Cash allocations editor with include toggle, packed into the Dashboard's four allocation slots |
| 1.7.1 | Network-first page loading and an update check on resume, so new versions arrive on the next open |
| 1.7.2 | Reports leave out netted accruals (Lending Income paired with an equal Allowance for Bad Debts provision) |
| 1.7.3 | Per-person receivables match names case-insensitively, like the Dashboard |
