import { describe, it, expect, afterEach } from "bun:test";
import { refreshOAuthToken, refreshWithCandidates } from "./claude";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// Map of client_id -> canned OAuth server response, used to fake console.anthropic.com.
function mockOAuthServer(responses: Record<string, { status: number; body: unknown }>) {
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const params = new URLSearchParams(init?.body as string);
    const clientId = params.get("client_id") ?? "";
    const r = responses[clientId] ?? { status: 400, body: { error: "invalid_grant" } };
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
}

const SUCCESS_BODY = { access_token: "sk-ant-new", refresh_token: "rt-new", expires_in: 3600 };

describe("refreshOAuthToken", () => {
  it("ut-1: returns success with rotated tokens on HTTP 200", async () => {
    mockOAuthServer({ good: { status: 200, body: SUCCESS_BODY } });
    const out = await refreshOAuthToken("rt", "good");
    expect(out).toEqual({ kind: "success", accessToken: "sk-ant-new", refreshToken: "rt-new", expiresIn: 3600 });
  });

  it("ut-2: maps invalid_grant", async () => {
    mockOAuthServer({ x: { status: 400, body: { error: "invalid_grant" } } });
    expect(await refreshOAuthToken("rt", "x")).toEqual({ kind: "invalid_grant" });
  });

  it("ut-3: maps invalid_request_error to client_not_found", async () => {
    mockOAuthServer({ x: { status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "Client with id x not found" } } } });
    expect(await refreshOAuthToken("rt", "x")).toEqual({ kind: "client_not_found" });
  });

  it("ut-4: surfaces other failures as error with detail", async () => {
    mockOAuthServer({ x: { status: 403, body: { error: "blocked" } } });
    const out = await refreshOAuthToken("rt", "x");
    expect(out.kind).toBe("error");
    if (out.kind === "error") expect(out.detail).toContain("HTTP 403");
  });
});

describe("refreshWithCandidates", () => {
  it("ut-5: tries candidates in order and returns the first that succeeds", async () => {
    mockOAuthServer({
      "client-a": { status: 400, body: { error: "invalid_grant" } },
      "client-b": { status: 400, body: { type: "error", error: { type: "invalid_request_error" } } },
      "client-c": { status: 200, body: SUCCESS_BODY },
    });
    const res = await refreshWithCandidates("rt", ["client-a", "client-b", "client-c"]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.clientId).toBe("client-c");
      expect(res.tokens.accessToken).toBe("sk-ant-new");
    }
  });

  it("ut-6: stops at the first success and does not try later candidates", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      const cid = new URLSearchParams(init?.body as string).get("client_id") ?? "";
      seen.push(cid);
      const body = cid === "first" ? SUCCESS_BODY : { error: "invalid_grant" };
      return new Response(JSON.stringify(body), { status: cid === "first" ? 200 : 400 });
    }) as unknown as typeof fetch;
    const res = await refreshWithCandidates("rt", ["first", "second", "third"]);
    expect(res.ok).toBe(true);
    expect(seen).toEqual(["first"]);
  });

  it("ut-7: returns ok:false with all attempts when every candidate fails", async () => {
    mockOAuthServer({
      "client-a": { status: 400, body: { error: "invalid_grant" } },
      "client-b": { status: 400, body: { type: "error", error: { type: "invalid_request_error" } } },
    });
    const res = await refreshWithCandidates("rt", ["client-a", "client-b"]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.attempts).toEqual([
        { clientId: "client-a", reason: "invalid_grant" },
        { clientId: "client-b", reason: "client_not_found" },
      ]);
    }
  });

  it("ut-8: regression — wrong client first (invalid_grant), correct client later succeeds", async () => {
    // Mirrors the real bug: extracted client id is rejected, a later binary id works.
    mockOAuthServer({
      "59637612-477b-4836-a601-b0589eda7704": { status: 400, body: { error: "invalid_grant" } },
      "22422756-60c9-4084-8eb7-27705fd5cf9a": { status: 400, body: { type: "error", error: { type: "invalid_request_error" } } },
      "9d1c250a-e61b-44d9-88ed-5944d1962f5e": { status: 200, body: SUCCESS_BODY },
    });
    const res = await refreshWithCandidates("rt", [
      "59637612-477b-4836-a601-b0589eda7704",
      "22422756-60c9-4084-8eb7-27705fd5cf9a",
      "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.clientId).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  });
});
