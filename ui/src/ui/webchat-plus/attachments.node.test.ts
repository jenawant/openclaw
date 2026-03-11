import { describe, expect, it } from "vitest";
import { filesToChatAttachments } from "./attachments.ts";

describe("filesToChatAttachments", () => {
  it("maps image files into chat attachments", async () => {
    const file = new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });
    const result = await filesToChatAttachments([file]);

    expect(result.errors).toEqual([]);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0]).toMatchObject({
      mimeType: "image/png",
      fileName: "image.png",
      kind: "image",
    });
    expect(result.attachments[0]?.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("rejects unsupported mime types", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "archive.bin", {
      type: "application/x-msdownload",
    });
    const result = await filesToChatAttachments([file]);
    expect(result.attachments).toEqual([]);
    expect(result.errors[0]).toContain("Unsupported file");
  });
});
