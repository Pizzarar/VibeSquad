// Small RFC-4180 CSV parser: quoted fields, "" escapes, CRLF/LF, and newlines inside quotes. Strips a leading UTF-8 BOM.
// Returns rows as arrays; parseCsvObjects() maps them onto the header row and records each row's 1-based start line.

export function parseCsv(text) {
  const src = String(text ?? "").replace(/^﻿/, "");
  const rows = [];
  const starts = [];
  let row = [];
  let field = "";
  let inQ = false;
  let line = 1;
  let rowStart = 1;
  let any = false; // anything seen on the current row (distinguishes an empty trailing row from a row of one empty field)
  const endField = () => { row.push(field); field = ""; };
  const endRow = () => { endField(); rows.push(row); starts.push(rowStart); row = []; any = false; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (!any) { rowStart = line; }
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else { field += c; if (c === "\n") line++; }
      continue;
    }
    if (c === '"' && field === "") { inQ = true; any = true; }
    else if (c === ",") { endField(); any = true; }
    else if (c === "\r") { /* swallowed; the \n (or lone \r) ends the row */ if (src[i + 1] !== "\n") { endRow(); line++; } }
    else if (c === "\n") { endRow(); line++; }
    else { field += c; any = true; }
  }
  if (any || field !== "" || row.length) endRow();
  return { rows, starts };
}

/** Header row -> objects. Blank lines are skipped. `line` is the row's starting line in the file. */
export function parseCsvObjects(text) {
  const { rows, starts } = parseCsv(text);
  if (!rows.length) return { header: [], records: [] };
  const header = rows[0];
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0] === "") continue;
    const obj = {};
    header.forEach((h, i) => { obj[h] = cells[i] ?? ""; });
    records.push({ row: obj, line: starts[r] });
  }
  return { header, records };
}
