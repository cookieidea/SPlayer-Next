import { describe, expect, it, vi } from "vitest";
import listenTogetherMultiAck from "./listen_together_multi_ack";

/**
 * checkToken（易盾风控令牌）必须随 payload 上报。
 *
 * 实测：缺它服务端一律返回 400，且同一枚令牌不能复用（返回 491）。
 * 放进请求头（X-antiCheatToken）同样无效——必须是 payload 字段
 */
describe("多人房加入确认", () => {
  it("checkToken 放进 payload", async () => {
    const request = vi.fn(() => Promise.resolve({ status: 200, body: { code: 200 } }));

    await listenTogetherMultiAck(
      { roomId: "R1", inviterUid: "77", deviceId: "dev", agree: true, checkToken: "TK" },
      request as never,
    );

    const [path, payload] = request.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(path).toBe("/api/listen/together/multi/match/ack");
    expect(payload.checkToken).toBe("TK");
    expect(payload.roomId).toBe("R1");
    expect(payload.inviterUid).toBe("77");
    expect(payload.agree).toBe(true);
  });

  it("未传 agree 时不带该字段（按链接加入的旧流程）", async () => {
    const request = vi.fn(() => Promise.resolve({ status: 200, body: { code: 200 } }));

    await listenTogetherMultiAck({ roomId: "R1", checkToken: "TK" }, request as never);

    const [, payload] = request.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect("agree" in payload).toBe(false);
    expect(payload.checkToken).toBe("TK");
  });
});
