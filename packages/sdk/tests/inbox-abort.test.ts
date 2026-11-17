import { describe, it, expect, vi, afterEach } from "vitest";
import { EkhoAgentClient } from "../src/index";

const client = () =>
  new EkhoAgentClient({ agentId: "agent_x", secret: "s", relayBaseUrl: "http://relay.invalid" });

const okResponse = () =>
  new Response(JSON.stringify({ messages: [] }), { status: 200, headers: { "content-type": "application/json" } });

describe("EkhoAgentClient.getInbox abort signal", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes no signal to fetch and keeps the default limit when called without arguments", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);
    await client().getInbox();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://relay.invalid/v1/inbox?limit=25");
    expect(init.signal).toBeUndefined();
  });

  it("passes the caller's signal through to fetch", async () => {
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    await client().getInbox(5, controller.signal);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://relay.invalid/v1/inbox?limit=5");
    expect(init.signal).toBe(controller.signal);
  });

  it("rejects when the signal is already aborted", async () => {
    vi.stubGlobal("fetch", (_u: string, init: RequestInit) =>
      init.signal?.aborted ? Promise.reject(init.signal.reason) : Promise.resolve(okResponse()));
    const controller = new AbortController();
    controller.abort();
    await expect(client().getInbox(25, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });

  it("rejects when aborted mid-flight", async () => {
    vi.stubGlobal("fetch", (_u: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      }));
    const controller = new AbortController();
    const pending = client().getInbox(25, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
