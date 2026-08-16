import { describe, it, expect } from "vitest";
import { EKHO_ORIGIN_STAMP } from "../src/autoreply";
import { buildSendMetadata, resolveOriginSessionId } from "../src/origin";

describe("outbound origin stamping (#17)", () => {
  describe("buildSendMetadata", () => {
    it("always carries the agent origin stamp", () => {
      expect(buildSendMetadata("sess_1").ekho_origin).toBe(EKHO_ORIGIN_STAMP);
      expect(buildSendMetadata().ekho_origin).toBe(EKHO_ORIGIN_STAMP);
    });

    it("adds origin_session_id when the host supplied a session identity", () => {
      expect(buildSendMetadata("sess_1")).toEqual({
        ekho_origin: EKHO_ORIGIN_STAMP,
        origin_session_id: "sess_1"
      });
    });

    it("omits the field entirely when there is no session to name", () => {
      // A missing stamp is honest ("this host exposes no session"); a minted one
      // would claim a different session sent every message.
      expect(buildSendMetadata()).toEqual({ ekho_origin: EKHO_ORIGIN_STAMP });
      expect(buildSendMetadata(undefined)).toEqual({ ekho_origin: EKHO_ORIGIN_STAMP });
      expect(buildSendMetadata("")).toEqual({ ekho_origin: EKHO_ORIGIN_STAMP });
      expect(buildSendMetadata("   ")).toEqual({ ekho_origin: EKHO_ORIGIN_STAMP });
      expect("origin_session_id" in buildSendMetadata("")).toBe(false);
    });

    it("trims a padded session id rather than stamping the padding", () => {
      expect(buildSendMetadata("  sess_1  ").origin_session_id).toBe("sess_1");
    });
  });

  describe("resolveOriginSessionId", () => {
    it("prefers sessionKey — the stable conversation identity", () => {
      // sessionId is regenerated on /new and /reset, so stamping it would make
      // one continuous session look like several.
      expect(resolveOriginSessionId({ sessionKey: "sk_stable", sessionId: "uuid_ephemeral" })).toBe("sk_stable");
    });

    it("falls back to sessionId when only that is exposed", () => {
      expect(resolveOriginSessionId({ sessionId: "uuid_ephemeral" })).toBe("uuid_ephemeral");
    });

    it("returns undefined — never throws — when the host exposes no session", () => {
      expect(resolveOriginSessionId({})).toBeUndefined();
      expect(resolveOriginSessionId(undefined)).toBeUndefined();
      expect(resolveOriginSessionId(null)).toBeUndefined();
      expect(resolveOriginSessionId({ sessionKey: "", sessionId: "   " })).toBeUndefined();
      // Non-string junk from an unknown host version is ignored, not stringified.
      expect(resolveOriginSessionId({ sessionKey: 42, sessionId: { a: 1 } } as never)).toBeUndefined();
    });

    it("skips an empty sessionKey in favour of a real sessionId", () => {
      expect(resolveOriginSessionId({ sessionKey: "  ", sessionId: "uuid_1" })).toBe("uuid_1");
    });
  });
});
