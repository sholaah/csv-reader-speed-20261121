// A fast drop-in for make.fun's csv-reader 1.0.0.
//
// run(input) returns exactly what csv-reader 1.0.0 returns for {text, header}:
// {columns, rows, errors}. The text is read once, left to right. A U+FEFF at the
// very start is dropped. A record ends at LF or CRLF; a line with no characters
// is no record. Outside quotes a CR not followed by LF is dropped (stray_cr).
// A field that opens with a quote runs to the next quote that is not doubled:
// "" inside it is one quote, and each CRLF or lone CR inside it is read as LF.
// What follows its closing quote, up to the next comma or line break, is
// appended as it stands (quote_junk, when the field ends). A quote that never
// closes is a literal character and the text after it is read again as
// unquoted (unterminated_quote). A quote inside an unquoted field is literal.
// Fields stay strings, never trimmed or converted. columns is the first record
// when header is true, else null; rows holds the records after it, each padded
// with "" (short_row, with fields: its field count) or cut (long_row, with
// extra: the cut fields) to the first record's width. Each error is
// {code, line, row}, in the order met; line is the 1-based line its record
// starts on, counting every LF, CRLF and lone CR inside quotes, and row is its
// record's index in rows (null for the header).
//
// Speed strategy: most records are plain lines with no quotes and no stray
// CRs, so a whole record is taken in one slice + split. Anything else is read
// field by field: quoted fields jump from quote to quote with indexOf (a span
// holding a line break falls back to a character walk that normalises CRs),
// and unquoted fields walk a tight character loop that only slices at
// delimiters. No work is shared between cases: every call starts from scratch.
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;
  let recordLine = 1;
  let recordRow = null;

  let fields = null;
  let fieldEnded = END;
  let fieldQuoted = false;

  // Reads an unquoted field starting at i, appending what it keeps onto
  // `prefix`. Sets fieldEnded and advances i/line. Returns the field's value.
  function readUnquoted(prefix) {
    let value = prefix;
    let seg = i;
    while (i < n) {
      const cc = text.charCodeAt(i);
      if (cc === 44) {
        value += text.slice(seg, i);
        i += 1;
        fieldEnded = COMMA;
        return value;
      }
      if (cc === 10) {
        value += text.slice(seg, i);
        i += 1;
        line += 1;
        fieldEnded = LINE_BREAK;
        return value;
      }
      if (cc === 13) {
        if (text.charCodeAt(i + 1) === 10) {
          value += text.slice(seg, i);
          i += 2;
          line += 1;
          fieldEnded = LINE_BREAK;
          return value;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        value += text.slice(seg, i);
        i += 1;
        seg = i;
        continue;
      }
      i += 1;
    }
    value += text.slice(seg, i);
    fieldEnded = END;
    return value;
  }

  // Reads a quoted field whose opening quote is at i. Sets fieldEnded and
  // advances i/line. Returns the field's value.
  function readQuoted() {
    const open = i;
    const openLine = line;
    let value = '';
    let p = i + 1;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) {
        i = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      const seg = text.slice(p, q);
      if (seg.indexOf('\r') === -1 && seg.indexOf('\n') === -1) {
        if (text.charCodeAt(q + 1) === 34) {
          value += seg;
          value += '"';
          p = q + 2;
          continue;
        }
        value += seg;
        i = q + 1;
        break;
      }
      // Dirty span (a line break inside the quotes): walk it a character
      // at a time from p until the closing quote.
      let s2 = p;
      i = p;
      let closed = false;
      while (i < n) {
        const cc = text.charCodeAt(i);
        if (cc === 34) {
          if (text.charCodeAt(i + 1) === 34) {
            value += text.slice(s2, i + 1);
            i += 2;
            s2 = i;
            continue;
          }
          value += text.slice(s2, i);
          i += 1;
          closed = true;
          break;
        }
        if (cc === 13) {
          value += text.slice(s2, i);
          value += '\n';
          line += 1;
          i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
          s2 = i;
          continue;
        }
        if (cc === 10) line += 1;
        i += 1;
      }
      if (!closed) {
        i = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      break;
    }
    if (i >= n) {
      fieldEnded = END;
      return value;
    }
    const cc = text.charCodeAt(i);
    if (cc === 44) {
      i += 1;
      fieldEnded = COMMA;
      return value;
    }
    if (cc === 10) {
      i += 1;
      line += 1;
      fieldEnded = LINE_BREAK;
      return value;
    }
    if (cc === 13 && text.charCodeAt(i + 1) === 10) {
      i += 2;
      line += 1;
      fieldEnded = LINE_BREAK;
      return value;
    }
    const junk = readUnquoted(value);
    if (junk.length > value.length) {
      errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    }
    return junk;
  }

  function finishRecord() {
    if (fields.length === 1 && fields[0] === '' && !fieldQuoted) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    while (i < n) {
      const cc = text.charCodeAt(i);
      if (cc === 10) {
        i += 1;
        line += 1;
      } else if (cc === 13 && text.charCodeAt(i + 1) === 10) {
        i += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (i >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    const nl = text.indexOf('\n', i);
    const end = nl === -1 ? n : nl;
    const q = text.indexOf('"', i);
    const r = text.indexOf('\r', i);
    if ((q === -1 || q >= end) && (r === -1 || (r === end - 1 && nl !== -1))) {
      fields = text.slice(i, r === end - 1 ? end - 1 : end).split(',');
      fieldQuoted = false;
      i = nl === -1 ? n : end + 1;
      if (nl !== -1) line += 1;
      finishRecord();
      continue;
    }

    fields = [];
    do {
      if (text.charCodeAt(i) === 34) {
        fieldQuoted = true;
        fields.push(readQuoted());
      } else {
        fieldQuoted = false;
        fields.push(readUnquoted(''));
      }
    } while (fieldEnded === COMMA);
    finishRecord();
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
