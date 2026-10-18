/**
 * Removes the Bcc header from a finished MIME message.
 *
 * A draft read back from a mailbox can carry the Bcc recipients in its header
 * block. A message submitted with that header would show them to everyone.
 * Only the header block is touched (up to the first blank line), folded Bcc
 * lines go with it, and the body is passed on byte for byte.
 */
export function stripBccHeader(raw: Buffer): Buffer {
  const text = raw.toString("latin1");
  const match = /\r?\n\r?\n/.exec(text);
  const headerEnd = match ? match.index : text.length;
  const header = text.slice(0, headerEnd);
  const rest = text.slice(headerEnd);

  const kept: string[] = [];
  let dropping = false;
  for (const line of header.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      // A folded continuation belongs to the header line before it.
      if (!dropping) kept.push(line);
      continue;
    }
    dropping = /^bcc[ \t]*:/i.test(line);
    if (!dropping) kept.push(line);
  }

  // The line ending of the original is kept; it is not changed by the removal.
  const eol = header.includes("\r\n") ? "\r\n" : "\n";
  return Buffer.from(kept.join(eol) + rest, "latin1");
}
