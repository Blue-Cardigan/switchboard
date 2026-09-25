// Just enough protobuf to read someone else's messages.
//
// Antigravity stores conversation steps as serialised protos with no schema
// anywhere on disk, so switchboard walks the wire format positionally: field
// numbers it has identified by hand, everything else skipped. Nothing here
// writes protos — switchboard never authors an Antigravity conversation file.

function varint(buf, at) {
  let result = 0n;
  let shift = 0n;
  let i = at;
  while (i < buf.length) {
    const byte = buf[i];
    i += 1;
    result |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [result, i];
    shift += 7n;
    if (shift > 70n) break;
  }
  return null;
}

/** Every top-level field of one message, in order. Stops at the first bad byte. */
export function* fieldsOf(buf) {
  let i = 0;
  while (i < buf.length) {
    const key = varint(buf, i);
    if (!key) return;
    const [tag, afterKey] = key;
    const field = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    i = afterKey;

    if (wire === 0) {
      const value = varint(buf, i);
      if (!value) return;
      yield { field, wire, number: value[0] };
      i = value[1];
    } else if (wire === 2) {
      const len = varint(buf, i);
      if (!len) return;
      const size = Number(len[0]);
      const start = len[1];
      if (start + size > buf.length) return;
      yield { field, wire, bytes: buf.subarray(start, start + size) };
      i = start + size;
    } else if (wire === 5) {
      yield { field, wire, bytes: buf.subarray(i, i + 4) };
      i += 4;
    } else if (wire === 1) {
      yield { field, wire, bytes: buf.subarray(i, i + 8) };
      i += 8;
    } else {
      return; // groups: long deprecated, and nothing here uses them
    }
  }
}

/** The bytes at a field path, e.g. pick(step, [5, 4, 2]) — null if absent. */
export function pick(buf, path) {
  let current = buf;
  for (const field of path) {
    let found = null;
    for (const entry of fieldsOf(current)) {
      if (entry.field === field && entry.bytes) { found = entry.bytes; break; }
    }
    if (!found) return null;
    current = found;
  }
  return current;
}

/** A varint field's value as a number — null if absent. */
export function pickNumber(buf, path) {
  const parent = path.length > 1 ? pick(buf, path.slice(0, -1)) : buf;
  if (!parent) return null;
  const last = path[path.length - 1];
  for (const entry of fieldsOf(parent)) {
    if (entry.field === last && entry.number !== undefined) return Number(entry.number);
  }
  return null;
}

/**
 * A field read as text. Proto strings are not tagged as such on the wire, so a
 * nested message read this way comes back as control-character soup; callers
 * get null for anything that does not look like text a person wrote.
 */
export function pickText(buf, path) {
  const bytes = pick(buf, path);
  if (!bytes || !bytes.length) return null;
  const text = Buffer.from(bytes).toString('utf8');
  if (text.includes('�')) return null;
  const printable = [...text].filter((ch) => ch >= ' ' || ch === '\n' || ch === '\t' || ch === '\r').length;
  return printable / text.length > 0.95 ? text : null;
}

/** The first of several candidate paths that yields text. */
export function firstText(buf, paths) {
  for (const path of paths) {
    const text = pickText(buf, path);
    if (text && text.trim()) return text.trim();
  }
  return null;
}
