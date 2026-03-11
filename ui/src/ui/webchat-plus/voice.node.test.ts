import { describe, expect, it } from "vitest";
import { canUseVoiceRecording } from "./voice.ts";

describe("canUseVoiceRecording", () => {
  it("returns false when MediaRecorder is unavailable", () => {
    expect(canUseVoiceRecording()).toBe(false);
  });
});
