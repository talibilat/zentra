import { get } from "node:http";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { LoopbackGateway } from "../../src/gateway/loopback-gateway.js";

describe("LoopbackGateway", () => {
  it("models browser navigation semantics through one-time HTML bootstrap and clean history without cookies", async () => {
    let now = new Date("2026-07-19T12:00:00.000Z");
    const gateway = new LoopbackGateway({ now: () => now, tokenTtlMs: 60_000 });
    const session = await gateway.start();
    try {
      expect(session.address).toEqual({ host: "127.0.0.1", port: expect.any(Number) });
      expect(session.ipv6Address).toEqual({ host: "::1", port: expect.any(Number) });
      expect(new URL(session.url).searchParams.get("token")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect((await fetch(session.url, { redirect: "manual" })).status).toBe(503);

      gateway.setReadiness("ready");
      const launchedUrl = session.url;
      const bootstrap = await fetch(session.url, { redirect: "manual" });
      expect(bootstrap.status).toBe(200);
      expect(bootstrap.headers.get("set-cookie")).toBeNull();
      expect(bootstrap.headers.get("location")).toBeNull();
      const policy = bootstrap.headers.get("content-security-policy")!;
      expect(policy).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+'/);
      const html = await bootstrap.text();
      expect(html).toContain('history.replaceState(null,"","/")');
      const script = html.match(/<script>([^<]+)<\/script>/)![1]!;
      expect(policy).toContain(`'sha256-${createHash("sha256").update(script).digest("base64")}'`);

      expect((await fetch(session.url, { redirect: "manual" })).status).toBe(401);
      const browserCurrentUrl = new URL("/", launchedUrl).href;
      const browserHistoryEquivalent = [browserCurrentUrl];
      expect(browserHistoryEquivalent).toEqual([`${session.origin}/`]);
      expect(browserHistoryEquivalent.every((url) => !url.includes("token="))).toBe(true);
      expect(launchedUrl).toBe(session.url);
      expect((await fetch(browserCurrentUrl)).status).toBe(401);
      expect((await fetch(browserCurrentUrl, { headers: { cookie: "unrelated=must-not-authorize" } })).status).toBe(401);

      now = new Date("2026-07-19T12:01:00.000Z");
      expect((await fetch(session.origin)).status).toBe(401);
    } finally {
      await gateway.close();
    }
  });

  it("allows exactly one of concurrent bootstrap attempts to establish the session", async () => {
    const gateway = new LoopbackGateway();
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const responses = await Promise.all(Array.from({ length: 12 }, () =>
        fetch(session.url, { redirect: "manual" })));
      expect(responses.filter(({ status }) => status === 200)).toHaveLength(1);
      expect(responses.filter(({ status }) => status === 401)).toHaveLength(11);
      expect(responses.filter(({ headers }) => headers.has("set-cookie"))).toHaveLength(0);
    } finally {
      await gateway.close();
    }
  });

  it("binds separate OS-selected IPv4 and IPv6 loopback listeners with exact Host and Origin checks", async () => {
    const first = new LoopbackGateway();
    const second = new LoopbackGateway();
    const [one, two] = await Promise.all([first.start(), second.start()]);
    try {
      expect(one.address.port).not.toBe(two.address.port);
      expect(one.ipv6Address.port).not.toBe(two.ipv6Address.port);
      expect(one.address.port).toBeGreaterThan(0);
      expect(one.ipv6Address.port).toBeGreaterThan(0);
      expect(await fetch(`http://[::1]:${one.ipv6Address.port}/healthz`).then((value) => value.json()))
        .toEqual({ status: "starting" });
      expect(await statusWithHost("::1", one.ipv6Address.port, "/healthz", "127.0.0.1"))
        .toBe(421);
      expect((await fetch(`http://[::1]:${one.ipv6Address.port}/healthz`, {
        headers: { origin: `http://[::1]:${two.ipv6Address.port}` },
      })).status).toBe(403);
      expect(await statusWithHost("127.0.0.1", one.address.port, "/healthz", "attacker.invalid"))
        .toBe(421);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("keeps both health listeners available while readiness is degraded and closes every socket", async () => {
    const gateway = new LoopbackGateway();
    const session = await gateway.start();
    gateway.setReadiness("degraded");
    expect((await fetch(`${session.origin}/healthz`)).status).toBe(200);
    expect((await fetch(`http://[::1]:${session.ipv6Address.port}/healthz`)).status).toBe(200);
    expect((await fetch(`${session.origin}/readyz`)).status).toBe(503);

    await gateway.close();

    await expect(fetch(`${session.origin}/healthz`)).rejects.toThrow();
    await expect(fetch(`http://[::1]:${session.ipv6Address.port}/healthz`)).rejects.toThrow();
  });
});

function statusWithHost(host: "127.0.0.1" | "::1", port: number, requestPath: string, header: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = get({ host, port, path: requestPath, headers: { host: header } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.once("error", reject);
  });
}
