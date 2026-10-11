/**
 * Well-known mail folders, named by the distinguished ids that EWS and Graph
 * share. Other providers map these onto their own vocabulary (Gmail search
 * operators, IMAP special-use flags).
 */
export type WellKnownMailFolder =
  "inbox" | "archive" | "sentitems" | "drafts" | "deleteditems" | "junkemail" | "outbox";

/**
 * Callers (and models) tend to pass display names such as "Archive" or
 * "Gesendete Elemente" rather than ids. A Map rather than an object literal,
 * so a folder called "constructor" cannot resolve to an Object prototype member.
 */
const MAIL_FOLDER_ALIASES: ReadonlyMap<string, WellKnownMailFolder> = new Map([
  ["inbox", "inbox"],
  ["posteingang", "inbox"],
  ["archive", "archive"],
  ["archiv", "archive"],
  ["sentitems", "sentitems"],
  ["sent", "sentitems"],
  ["sentmessages", "sentitems"],
  ["sentmail", "sentitems"],
  ["gesendeteobjekte", "sentitems"],
  ["gesendetenachrichten", "sentitems"],
  ["gesendeteelemente", "sentitems"],
  ["gesendet", "sentitems"],
  ["drafts", "drafts"],
  ["draft", "drafts"],
  ["entwurfe", "drafts"],
  ["entwuerfe", "drafts"],
  ["deleteditems", "deleteditems"],
  ["deleted", "deleteditems"],
  ["trash", "deleteditems"],
  ["deletedmessages", "deleteditems"],
  ["bin", "deleteditems"],
  ["papierkorb", "deleteditems"],
  ["geloschteelemente", "deleteditems"],
  ["geloeschteelemente", "deleteditems"],
  ["junkemail", "junkemail"],
  ["junk", "junkemail"],
  ["spam", "junkemail"],
  ["junkemails", "junkemail"],
  ["junkmail", "junkemail"],
  ["outbox", "outbox"],
  ["postausgang", "outbox"],
]);

/** The well-known folder a name refers to, or undefined for a custom folder. */
export function wellKnownMailFolder(folder: string): WellKnownMailFolder | undefined {
  const key = folder
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[\s_-]+/g, "");
  return MAIL_FOLDER_ALIASES.get(key);
}

/**
 * Folder name as EWS and Graph expect it: well-known names become their
 * distinguished id (EWS ids are case-sensitive lowercase tokens). Unknown
 * names pass through unchanged so the provider still reports them.
 */
export function normalizeMailFolder(folder: string): string {
  return wellKnownMailFolder(folder) ?? folder;
}

/** True when a caller actually named a folder, as opposed to omitting it. */
export function hasFolder(folder: string | undefined): folder is string {
  return folder !== undefined && folder.trim() !== "";
}

/**
 * True for an opaque Exchange folder id (Graph and EWS ids are long base64
 * tokens such as "AAMkAG…"), as opposed to a display name a caller typed.
 */
export function looksLikeFolderId(folder: string): boolean {
  return /^[A-Za-z0-9+/_=-]{40,}$/.test(folder.trim());
}
