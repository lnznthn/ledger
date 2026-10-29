/**
 * Editing an existing Transactions row from the Ledger app. Paste into the sheet's Apps Script project next to
 * Code.gs and route one action from doPost, inside the same key check as the other actions:
 *
 *   case 'editRow': return json_({ ok: true, data: editRow_(body.row, body.expect, body.entry) });
 *
 * Then Deploy → Manage deployments → edit → New version, which keeps the /exec URL.
 *
 * The app sends the row number, the row as it last saw it (expect) and the new values (entry). The row is only
 * overwritten if the sheet still holds exactly what the app saw, so an edit can never land on a row that moved or
 * changed since the last sync. New Source/Destination pairs must be in the Data tab (readOptions_ in Code.gs).
 */
const EDIT_SHEET_ = 'Transactions';
const EDIT_TYPES_ = ['Outflows', 'Inflow', 'Transfer'];

function editNorm_(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); }

/** A Date cell or an MM/DD/YY text cell, as YYYY-MM-DD in the spreadsheet's time zone. */
function editIso_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(editNorm_(v));
  if (!m) return editNorm_(v);
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return y + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2);
}

function editEntry_(e) {
  e = e || {};
  const out = {
    date: String(e.date || ''), desc: editNorm_(e.desc), type: String(e.type || ''),
    source: String(e.source || ''), dest: String(e.dest || ''), amount: Math.round(Number(e.amount) * 100) / 100,
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(out.date)) throw new Error('Date must be YYYY-MM-DD');
  if (!out.desc || out.desc.length > 200) throw new Error('Description is empty or too long');
  if (EDIT_TYPES_.indexOf(out.type) < 0) throw new Error('Type must be Outflows, Inflow or Transfer');
  if (!editNorm_(out.source) || !editNorm_(out.dest)) throw new Error('Source and Destination are required');
  if (!(out.amount > 0) || out.amount > 1e12) throw new Error('Amount must be a positive number');
  return out;
}

function editRow_(row, expect, entry) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(EDIT_SHEET_);
  if (!sh) throw new Error('Transactions tab not found');
  row = Number(row);
  if (!Number.isInteger(row) || row < 2 || row > sh.getLastRow()) throw new Error('Row ' + row + ' is outside the Transactions tab');
  const e = editEntry_(entry), x = expect || {}, tz = ss.getSpreadsheetTimeZone();

  const lock = LockService.getDocumentLock(); lock.waitLock(20000);
  try {
    const r = sh.getRange(row, 1, 1, 6);
    if (r.getFormulas()[0].some(function (f) { return f; })) throw new Error('Row ' + row + ' contains a formula. Edit it in the sheet.');
    const cur = r.getValues()[0];
    const same = editIso_(cur[0], tz) === String(x.date)
      && editNorm_(cur[1]) === editNorm_(x.desc) && editNorm_(cur[2]) === editNorm_(x.type)
      && editNorm_(cur[3]) === editNorm_(x.source) && editNorm_(cur[4]) === editNorm_(x.dest)
      && Math.abs(Number(cur[5]) - Number(x.amount)) < 0.005;
    if (!same) throw new Error('Row ' + row + ' changed in the sheet since your last sync. Sync, then edit it again.');

    // same Data tab rule as new rows, except that a row may keep the pair it already had
    const keepsPair = e.type === editNorm_(cur[2]) && editNorm_(e.source) === editNorm_(cur[3]) && editNorm_(e.dest) === editNorm_(cur[4]);
    const map = readOptions_().map;
    if (!keepsPair && !(map[e.type] && map[e.type][e.source] && map[e.type][e.source].indexOf(e.dest) !== -1))
      throw new Error(e.source + ' → ' + e.dest + ' is not a valid pair in the Data tab');

    // keep the cell's kind: a real date stays a date, text stays MM/DD/YY text
    const p = e.date.split('-');
    const dateVal = cur[0] instanceof Date ? Utilities.parseDate(e.date, tz, 'yyyy-MM-dd') : p[1] + '/' + p[2] + '/' + p[0].slice(2);
    r.setValues([[dateVal, e.desc, e.type, e.source, e.dest, e.amount]]);
    SpreadsheetApp.flush();
  } finally { lock.releaseLock(); }
  return { row: row };
}
