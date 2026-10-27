# Ledger: how the app works

Ledger is a single-page iPhone home-screen web app (PWA) over the owner's Personal Finances Google Sheet. It is local-first: the phone keeps the full Transactions log, computes every balance itself, and only uses the sheet to download new rows, write new rows, and read a few Dashboard values it cannot derive from the log. This file is the reference for anyone changing the app, so that the logic below does not have to be rediscovered from chat history.

This repository is public and served by GitHub Pages. Keep balances, account numbers, people's names, the spreadsheet ID and the connection key out of this file and out of the code.

## Files and deployment

| File | Role |
| --- | --- |
| `index.html` | The whole app: markup, CSS and one `<script>`. Version is the `VERSION` constant near the top of the script. |
| `sw.js` | Service worker. Caches the app shell so it opens instantly and works offline. Never caches sheet data. |
| `manifest.webmanifest`, `icons/` | Home-screen install metadata. |

The back end is a Google Apps Script web app (`Code.gs`) bound to the spreadsheet. Its source is **not** in this repo; it lives in the sheet's Apps Script project (Extensions → Apps Script). Changing it needs the owner's Google sign-in. Changes to this repo need only a push to `main`; GitHub Pages republishes in about a minute.

### Release checklist

1. Bump `VERSION` in `index.html`.
2. Bump `CACHE` in `sw.js` to the same version (`ledger-vX.Y.Z`). The browser only installs a new service worker when the bytes of `sw.js` change, so skipping this means phones keep the old app.
3. Never commit an empty or truncated `sw.js`. Version 1.3.1 shipped an empty `sw.js` by accident and offline launch was broken until 1.5.2 restored it.
4. Check the script parses, for example `node -e "const h=require('fs').readFileSync('index.html','utf8');new Function(h.slice(h.indexOf('<script>')+8,h.lastIndexOf('</script>')))"`.
5. Commit and push to `main`. Phones download the update in the background on next open and run it from the launch after that (the app shows a toast when an update is ready).

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

For every name in a Dashboard group (excluding Allocated and Receivables, which the app cannot derive), the app sums that name's Dashboard cells across groups and compares with its own synced balance. Differences over ₱1 show as an amber "accounts differ" card on Balances. A name appearing in both Wallets and Restricted Cash (an earmarked wallet) is summed across both, which gives back its full balance.

### Earmarks

The Dashboard's **Restricted Cash** group lists amounts held inside wallet accounts for a purpose. Its cells are formulas on the Transactions log, typically "the account's balance, capped at a set amount". The matching Wallets cell shows the balance minus that restricted amount. The app reads the restricted amounts from the Dashboard (`earmarkMap`); it does not know the caps, so between syncs the earmark stays at its last-synced value even if a queued entry changes the wallet's balance.

A Restricted Cash item that is not also in Wallets (an account held only as restricted cash) is excluded from Net liquidity and from the Liquid balance line; it appears only in the balance sheet under Restricted cash.

### Headline figures

| Figure | Where | Rule |
| --- | --- | --- |
| **Net liquidity** | Balances, Net liquidity tile | Σ Wallets after earmarks, each wallet floored to ₱0 if ₱1 or less after its earmark, + Σ Savings + Σ Credit cards. Uses live balances over all rows. Matches Dashboard `D4` (`=SUM(H3,H13)+J25`); flagged amber if the synced value differs by more than ₱1. |
| **Net cash available** | Balances headline | Net liquidity − total of the Dashboard's Allocated Cash group. Allocations come from the Dashboard only. Matches the Dashboard's Net Cash Available cell. |
| **Net assets** | Balances | Total assets − total liabilities from the pro forma balance sheet below. |
| **Liquid balance** | Reports, trend line | Σ Wallets + Σ Savings + Σ Credit cards **before earmarks and with no ₱1 floor**, accumulated day by day from rows dated up to today. |

Liquid balance and Net liquidity intentionally measure different things. The Reports card shows a bridge from one to the other (`liquidBridge`):

1. Add rows dated after today (in balances, not on the chart).
2. Less each wallet's earmarked portion (the full earmark, or the whole balance if the earmark exceeds it).
3. Less wallets at ₱1 or less, which Net liquidity shows as ₱0.
4. Any remainder is shown as "Unexplained difference" and means the rules have drifted apart, most likely an account listed in two of the Wallets, Savings and Credit cards groups (Net liquidity would count it twice, the trend line once).

The Net liquidity breakdown sheet on Balances also shows the before-earmarks figure.

### Balance sheet (Balances tab)

Assets: Wallets (after earmarks), Savings, Restricted cash (Dashboard values), Short-term investments, Long-term investments, Receivables, Ventures. Liabilities: Credit cards (shown as positive amounts owed), Accounts payable (taken from the Allocated Cash group's "Accounts Payable" line). Every line except Restricted cash and Accounts payable is valued from the log. A memo section lists the Allocated Cash lines and any account in the log that is on no Dashboard group.

### Receivables

Per-person receivables are tracked by **description**: for rows whose Source or Destination is `Lending Receivables` or `Other Receivables`, the Transaction text is the person's name, and the balance is money into those accounts minus money out. People on the Dashboard's Receivables list are compared with the Dashboard; people only in the log appear under "Also open in the log" and are excluded from the total.

### Reports

- **Cash flow**: monthly inflows and spending. Inflows exclude `Set-up` (opening balances), `Lending Receivables` and `Allowance for Bad Debts` (`INFLOW_EXCLUDE`). Spending is Outflows into non-accounts.
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
