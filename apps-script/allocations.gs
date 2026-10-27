/**
 * Cash allocations for the Ledger app. Paste into the sheet's Apps Script project next to Code.gs and route two
 * actions from doPost:  getAllocs → getAllocs_()   setAllocs → setAllocs_(body.slots)
 *
 * The Dashboard's Allocated Cash block keeps Accounts Payable in K20:L20 (a SUMIF on the log, never touched here)
 * and uses the rows below it as slots. The app spreads its allocations across the slots; each slot holds
 *   name cell:   "Emergency Fund, Cam, CFA"
 *   amount cell: =360000+70000+160000        (an excluded amount is written (523013*0))
 * K19's =SUM(L20:L24) and every formula that reads it keep working unchanged.
 */
const ALLOC_SHEET_ = 'Dashboard';
const ALLOC_RANGE_ = 'K21:L24';   // name column K, amount column L, one row per slot

function allocRange_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ALLOC_SHEET_);
  if (!sh) throw new Error('Dashboard tab not found');
  return sh.getRange(ALLOC_RANGE_);
}

/** Each slot as the app reads it back: the name text, the amount formula (empty for a typed number) and its value. */
function getAllocs_() {
  const r = allocRange_();
  const shown = r.getDisplayValues(), formulas = r.getFormulas(), values = r.getValues();
  return shown.map((row, i) => ({ name: String(row[0] || ''), formula: String(formulas[i][1] || ''), value: values[i][1] === '' ? '' : Number(values[i][1]) || 0 }));
}

/** slots: one array per sheet row, each [{ name, amount, on }]. The formula is built here, never taken from the client. */
function setAllocs_(slots) {
  const r = allocRange_(); const n = r.getNumRows();
  if (!Array.isArray(slots) || slots.length !== n) throw new Error('Expected ' + n + ' allocation slots');
  const names = [], amounts = [];
  slots.forEach((items, i) => {
    if (!Array.isArray(items)) throw new Error('Slot ' + (i + 1) + ' is not a list');
    const parts = items.map(it => {
      const name = String(it && it.name || '').replace(/\s+/g, ' ').trim(), amt = Number(it && it.amount);
      if (!name || name.length > 60 || /[,+]/.test(name)) throw new Error('Invalid allocation name: ' + name);
      if (!Number.isInteger(amt) || amt < 0 || amt > 1e12) throw new Error('Invalid amount for ' + name);
      return { name: name, term: it.on === false ? '(' + amt + '*0)' : String(amt) };
    });
    names.push([parts.map(p => p.name).join(', ')]);
    amounts.push([parts.length ? '=' + parts.map(p => p.term).join('+') : '']);
  });
  const lock = LockService.getDocumentLock(); lock.waitLock(20000);
  try {
    r.offset(0, 0, n, 1).setValues(names);
    r.offset(0, 1, n, 1).setFormulas(amounts);
    SpreadsheetApp.flush();
  } finally { lock.releaseLock(); }
  return getAllocs_();
}
