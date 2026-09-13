import { randomBytes, timingSafeEqual } from "node:crypto";

const PAIRING_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 16;
const PAIRING_FAILURE_WINDOW_MS = 60 * 1000;
const MAX_PAIRING_FAILURES_PER_WINDOW = 20;

type ExpiringValue = { value: string; expiresAt: number };

const secretMatches = (candidate: string | undefined, expected: string): boolean => {
  if (!candidate) return false;
  const actualBytes = Buffer.from(candidate);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
};

export const normalizePublicOrigin = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("SNOW_REMOTE_PUBLIC_ORIGIN 必须是无凭据的 HTTPS 地址");
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("SNOW_REMOTE_PUBLIC_ORIGIN 不能包含路径、查询或 fragment");
  }
  return url.origin;
};

export class RemoteWanAuth {
  readonly origin: string;
  private pairing: ExpiringValue | null = null;
  private readonly sessions = new Map<string, number>();
  private failedPairingAttempts: number[] = [];

  constructor(origin: string) {
    this.origin = normalizePublicOrigin(origin);
  }

  get expectedHost(): string {
    return new URL(this.origin).host;
  }

  issuePairing(now = Date.now()): { code: string; expiresAt: number; url: string } {
    const code = randomBytes(24).toString("base64url");
    const expiresAt = now + PAIRING_TTL_MS;
    this.pairing = { value: code, expiresAt };
    return { code, expiresAt, url: `${this.origin}/#pair=${code}` };
  }

  currentPairing(now = Date.now()): { expiresAt: number; url: string } | null {
    if (!this.pairing || this.pairing.expiresAt <= now) {
      this.pairing = null;
      return null;
    }
    return {
      expiresAt: this.pairing.expiresAt,
      url: `${this.origin}/#pair=${this.pairing.value}`,
    };
  }

  exchange(code: string, now = Date.now()): { token: string; expiresAt: number } | null {
    this.failedPairingAttempts = this.failedPairingAttempts.filter(
      (attemptedAt) => attemptedAt > now - PAIRING_FAILURE_WINDOW_MS,
    );
    if (this.failedPairingAttempts.length >= MAX_PAIRING_FAILURES_PER_WINDOW) {
      return null;
    }
    const pairing = this.pairing;
    if (!pairing || pairing.expiresAt <= now || !secretMatches(code, pairing.value)) {
      if (pairing?.expiresAt && pairing.expiresAt <= now) this.pairing = null;
      this.failedPairingAttempts.push(now);
      return null;
    }
    this.pairing = null;
    this.failedPairingAttempts = [];
    this.prune(now);
    const token = randomBytes(24).toString("base64url");
    const expiresAt = now + SESSION_TTL_MS;
    this.sessions.set(token, expiresAt);
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (typeof oldest !== "string") break;
      this.sessions.delete(oldest);
    }
    return { token, expiresAt };
  }

  authorize(token: string | undefined, now = Date.now()): boolean {
    if (!token) return false;
    this.prune(now);
    for (const [stored, expiresAt] of this.sessions) {
      if (expiresAt > now && secretMatches(token, stored)) return true;
    }
    return false;
  }

  revokeAll(): void {
    this.pairing = null;
    this.sessions.clear();
    this.failedPairingAttempts = [];
  }

  private prune(now: number): void {
    for (const [token, expiresAt] of this.sessions) {
      if (expiresAt <= now) this.sessions.delete(token);
    }
  }
}
