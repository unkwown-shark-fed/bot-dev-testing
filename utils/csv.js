/**
 * Shared CSV/export helpers.
 *
 * These were previously copy-pasted (with small inconsistencies) across
 * export.js, exportinvites.js, exportforumposts.js, exportmessages.js,
 * and quote.js. Centralizing them here means a fix or hardening change
 * (e.g. CSV/formula-injection handling) only needs to happen once.
 */

/**
 * Collapse newlines/control chars and trim a value to a max length so it's
 * safe to drop into a single CSV cell.
 * @param {*} value
 * @param {number} maxLen
 * @returns {string}
 */
function sanitizeText(value, maxLen = 10000) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  s = s.replace(/\r\n/g, ' ').replace(/[\r\n]/g, ' ');
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  s = s.replace(/\s+/g, ' ');
  s = s.trim();
  if (s.length > maxLen) s = `${s.slice(0, maxLen)}...`;
  return s;
}

/**
 * Sanitize + wrap a value as a quoted CSV field. Use this when building CSV
 * rows manually (i.e. NOT going through the `csv-stringify` package, which
 * already handles quoting/escaping itself).
 * @param {*} value
 * @param {number} maxLen
 * @returns {string}
 */
function escapeCsv(value, maxLen = 10000) {
  const s = sanitizeText(value, maxLen);
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Force Excel/Sheets to treat a value (typically a large Discord snowflake
 * ID) as text instead of converting it to scientific notation.
 * Returns the RAW `="value"` formula string — use this when your rows are
 * passed to `csv-stringify`, which will apply its own quoting on top.
 * @param {string|number} id
 * @returns {string}
 */
function excelSafeId(id) {
  if (!id) return '';
  return `="${id}"`;
}

/**
 * Same Excel-safe-ID trick as `excelSafeId`, but pre-quoted as a CSV field.
 * Use this when building CSV rows manually instead of via `csv-stringify`.
 * @param {string|number} id
 * @returns {string}
 */
function csvSafeId(id) {
  return escapeCsv(excelSafeId(id));
}

/**
 * Wrap a value as a quoted CSV field WITHOUT collapsing newlines/whitespace
 * (unlike `escapeCsv`). Use this only when a field is meant to preserve
 * multi-line readability inside the CSV cell (e.g. quoted message content).
 * @param {*} value
 * @returns {string}
 */
function escapeCsvPreserveNewlines(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

/**
 * Same Excel-safe-ID trick as `csvSafeId`, but for callers using
 * `escapeCsvPreserveNewlines` instead of `escapeCsv`.
 * @param {string|number} id
 * @returns {string}
 */
function csvSafeIdPreserveNewlines(id) {
  return escapeCsvPreserveNewlines(excelSafeId(id));
}

module.exports = {
  sanitizeText,
  escapeCsv,
  excelSafeId,
  csvSafeId,
  escapeCsvPreserveNewlines,
  csvSafeIdPreserveNewlines,
};
