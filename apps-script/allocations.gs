/**
 * Allocations for the Ledger app. Paste into the sheet's Apps Script project next to Code.gs and route two
 * actions from doPost:  getAllocs → getAllocs_()   setAllocs → setAllocs_(body.slots)
 *
 * The allocation range (the Config tab's allocation range, in the tab named by its sheet tab 3 row) is two columns:
 * a name column and an amount column, one row per slot, under the payable row of the summary tab. Each slot holds
 *   name cell:   "Allocation A, Allocation B, Allocation C"
 *   amount cell: =1000+2000+3000        (an excluded amount is written (4000*0))
 * The payable row above the slots and every formula that totals the block keep working unchanged.
 */

/** The allocation range from the Config tab. A missing or malformed row refuses the read or write; no default range is ever used. */
function allocRange_() {
  const tab = configValue_('sheet tab 3'), a1 = configValue_('allocation range');
  if (!tab || !/^[A-Z]{1,3}[0-9]+:[A-Z]{1,3}[0-9]+$/i.test(a1)) throw new Error('The Config tab needs its sheet tab 3 and allocation range rows; nothing was changed');
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tab);
  if (!sh) throw new Error(tab + ' tab not found');
  const r = sh.getRange(a1);
  if (r.getNumColumns() !== 2) throw new Error('The allocation range must be two columns wide; nothing was changed');
  return r;
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
