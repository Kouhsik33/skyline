import { describe, expect, it } from 'vitest';
import { buildMembershipQrPayload, buildTicketQrPayload, parseMembershipQrPayload, parseTicketQrPayload, renderQrSvg } from '../../src/shared/qr.js';
import { randomToken } from '../../src/shared/tokens.js';

// Merged QR helpers (Group 1 names): opaque SOMS1 payloads, separate ticket and membership workflows.
describe('qr helpers', () => {
  const token = randomToken();

  it('builds and parses SOMS1 payloads for both kinds; a membership QR is not a ticket', () => {
    const t = buildTicketQrPayload(token);
    const m = buildMembershipQrPayload(token);
    expect(t).toBe(`SOMS1:T:${token}`);
    expect(m).toBe(`SOMS1:M:${token}`);
    expect(parseTicketQrPayload(t)).toBeTruthy();
    expect(parseMembershipQrPayload(m)).toBeTruthy();
    expect(parseTicketQrPayload(m) ?? null).toBeNull();
    expect(parseMembershipQrPayload(t) ?? null).toBeNull();
  });

  it('rejects malformed payloads', () => {
    for (const bad of ['', 'SOMS2:T:abc', 'hello']) expect(parseTicketQrPayload(bad) ?? null).toBeNull();
  });

  it('renders SVG server-side', async () => {
    expect(await renderQrSvg(buildTicketQrPayload(token))).toMatch(/<svg[\s\S]*<\/svg>/);
  });
});
