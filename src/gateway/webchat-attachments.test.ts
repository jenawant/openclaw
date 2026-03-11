import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveWebchatAttachments } from "./webchat-attachments.js";

const { saveMediaBufferMock } = vi.hoisted(() => ({
  saveMediaBufferMock: vi.fn(async () => ({
    id: "saved-1",
    path: "/tmp/inbound/saved-1.ogg",
    size: 32,
    contentType: "audio/ogg",
  })),
}));

vi.mock("../media/store.js", () => ({
  saveMediaBuffer: saveMediaBufferMock,
}));

describe("resolveWebchatAttachments", () => {
  beforeEach(() => {
    saveMediaBufferMock.mockClear();
  });

  it("keeps image attachments as image blocks", async () => {
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO5gq0oAAAAASUVORK5CYII=";
    const resolved = await resolveWebchatAttachments({
      message: "hello",
      attachments: [
        {
          type: "image",
          mimeType: "image/png",
          fileName: "pixel.png",
          content: pngBase64,
        },
      ],
    });

    expect(resolved.message).toBe("hello");
    expect(resolved.images).toHaveLength(1);
    expect(resolved.images[0]).toMatchObject({
      type: "image",
      mimeType: "image/png",
      data: pngBase64,
    });
    expect(resolved.mediaPaths).toEqual([]);
    expect(resolved.mediaTypes).toEqual([]);
    expect(saveMediaBufferMock).not.toHaveBeenCalled();
  });

  it("stores audio attachments and returns media refs", async () => {
    const audioBase64 = Buffer.from("fake audio").toString("base64");
    const resolved = await resolveWebchatAttachments({
      message: "",
      attachments: [
        {
          type: "audio",
          mimeType: "audio/ogg",
          fileName: "voice.ogg",
          content: audioBase64,
        },
      ],
    });

    expect(resolved.images).toEqual([]);
    expect(resolved.mediaPaths).toEqual(["/tmp/inbound/saved-1.ogg"]);
    expect(resolved.mediaTypes).toEqual(["audio/ogg"]);
    expect(saveMediaBufferMock).toHaveBeenCalledOnce();
  });

  it("rejects unsupported attachment mime", async () => {
    await expect(
      resolveWebchatAttachments({
        message: "",
        attachments: [
          {
            type: "video",
            mimeType: "video/mp4",
            fileName: "clip.mp4",
            content: Buffer.from("video").toString("base64"),
          },
        ],
      }),
    ).rejects.toThrow("unsupported mime type");
  });
});
