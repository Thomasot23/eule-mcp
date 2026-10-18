import { describe, it, expect } from "vitest";
import { stripBccHeader } from "../src/utils/mail-headers.js";

const text = (b: Buffer): string => b.toString("latin1");

describe("stripBccHeader", () => {
  it("removes the Bcc header and keeps every other header", () => {
    const raw = Buffer.from(
      "From: a@x.de\r\nTo: b@x.de\r\nBcc: hidden@x.de\r\nSubject: Hi\r\n\r\nBody\r\n",
      "latin1",
    );
    expect(text(stripBccHeader(raw))).toBe(
      "From: a@x.de\r\nTo: b@x.de\r\nSubject: Hi\r\n\r\nBody\r\n",
    );
  });

  it("removes a folded Bcc header together with its continuation lines", () => {
    const raw = Buffer.from(
      "To: b@x.de\r\nBcc: one@x.de,\r\n two@x.de,\r\n\tthree@x.de\r\nSubject: Hi\r\n\r\nBody",
      "latin1",
    );
    expect(text(stripBccHeader(raw))).toBe("To: b@x.de\r\nSubject: Hi\r\n\r\nBody");
  });

  it("matches the header name without regard to case", () => {
    const raw = Buffer.from("TO: b@x.de\nBCC: hidden@x.de\nSubject: Hi\n\nBody", "latin1");
    expect(text(stripBccHeader(raw))).toBe("TO: b@x.de\nSubject: Hi\n\nBody");
  });

  it("keeps a folded line that belongs to another header", () => {
    const raw = Buffer.from(
      "Subject: A long\r\n subject line\r\nBcc: hidden@x.de\r\n\r\nBody",
      "latin1",
    );
    expect(text(stripBccHeader(raw))).toBe("Subject: A long\r\n subject line\r\n\r\nBody");
  });

  it("does not touch a header that only starts with the letters Bcc", () => {
    const raw = Buffer.from("To: b@x.de\r\nBcc-Note: keep\r\n\r\nBody", "latin1");
    expect(text(stripBccHeader(raw))).toBe("To: b@x.de\r\nBcc-Note: keep\r\n\r\nBody");
  });

  it("leaves the body alone, even when it contains a line that looks like Bcc", () => {
    const raw = Buffer.from("To: b@x.de\r\n\r\nBcc: this is body text\r\n", "latin1");
    expect(text(stripBccHeader(raw))).toBe("To: b@x.de\r\n\r\nBcc: this is body text\r\n");
  });

  it("passes the body through byte for byte", () => {
    const body = Buffer.from([0x00, 0xff, 0xfe, 0x80, 0x0d, 0x0a, 0x41]);
    const raw = Buffer.concat([Buffer.from("To: b@x.de\r\nBcc: h@x.de\r\n\r\n", "latin1"), body]);
    const out = stripBccHeader(raw);
    expect(out.subarray(out.length - body.length).equals(body)).toBe(true);
  });

  it("returns a message without a Bcc header unchanged", () => {
    const raw = Buffer.from("To: b@x.de\r\nSubject: Hi\r\n\r\nBody", "latin1");
    expect(stripBccHeader(raw).equals(raw)).toBe(true);
  });

  it("handles a message that has headers only", () => {
    const raw = Buffer.from("To: b@x.de\r\nBcc: h@x.de", "latin1");
    expect(text(stripBccHeader(raw))).toBe("To: b@x.de");
  });
});
