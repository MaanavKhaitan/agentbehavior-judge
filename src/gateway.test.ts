import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { completeWithBraintrustGateway, type GatewayMessage } from "./gateway.js";

const messages: GatewayMessage[] = [{ role: "user", content: "hi" }];

function okResponse(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("completeWithBraintrustGateway", () => {
  it("omits temperature from the request unless explicitly configured", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(init?.body as string) as Record<string, unknown>);
        return Promise.resolve(okResponse());
      }),
    );

    await completeWithBraintrustGateway(messages, { apiKey: "key" });
    await completeWithBraintrustGateway(messages, { apiKey: "key", temperature: 0 });

    expect("temperature" in bodies[0]!).toBe(false);
    expect(bodies[1]!.temperature).toBe(0);
  });
});
