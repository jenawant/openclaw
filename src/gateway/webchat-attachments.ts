import { estimateBase64DecodedBytes } from "../media/base64.js";
import { kindFromMime, normalizeMimeType } from "../media/mime.js";
import { sniffMimeFromBase64 } from "../media/sniff-mime-from-base64.js";
import { saveMediaBuffer } from "../media/store.js";
import type { ChatImageContent } from "./chat-attachments.js";
import type { RpcAttachmentInput } from "./server-methods/attachment-normalize.js";

const WEBCHAT_ATTACHMENT_MAX_BYTES = 5_000_000;

export type WebchatAttachmentResolution = {
  message: string;
  images: ChatImageContent[];
  mediaPaths: string[];
  mediaTypes: string[];
};

type NormalizedAttachment = {
  label: string;
  fileName?: string;
  mimeType?: string;
  content: string;
};

function isValidBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function extractAttachmentContent(content: string): { base64: string; mimeType?: string } {
  const trimmed = content.trim();
  const dataUrlMatch = /^data:([^;]+);base64,(.+)$/i.exec(trimmed);
  if (dataUrlMatch) {
    return {
      mimeType: normalizeMimeType(dataUrlMatch[1]),
      base64: dataUrlMatch[2]?.trim() ?? "",
    };
  }
  return { base64: trimmed };
}

function normalizeAttachment(att: RpcAttachmentInput, index: number): NormalizedAttachment {
  const fileName = typeof att.fileName === "string" ? att.fileName.trim() : undefined;
  const type = typeof att.type === "string" ? att.type.trim() : "";
  const label = fileName || type || `attachment-${index + 1}`;
  if (typeof att.content !== "string" || !att.content.trim()) {
    throw new Error(`attachment ${label}: content must be base64 string`);
  }
  const { base64, mimeType } = extractAttachmentContent(att.content);
  const explicitMime = typeof att.mimeType === "string" ? att.mimeType : undefined;
  return {
    label,
    fileName: fileName || undefined,
    mimeType: normalizeMimeType(mimeType ?? explicitMime),
    content: base64,
  };
}

export async function resolveWebchatAttachments(params: {
  message: string;
  attachments: RpcAttachmentInput[] | undefined;
  log?: { warn: (message: string) => void };
}): Promise<WebchatAttachmentResolution> {
  const normalized = params.attachments ?? [];
  if (normalized.length === 0) {
    return {
      message: params.message,
      images: [],
      mediaPaths: [],
      mediaTypes: [],
    };
  }

  const images: ChatImageContent[] = [];
  const mediaPaths: string[] = [];
  const mediaTypes: string[] = [];

  for (const [idx, rawAttachment] of normalized.entries()) {
    const attachment = normalizeAttachment(rawAttachment, idx);
    if (!isValidBase64(attachment.content)) {
      throw new Error(`attachment ${attachment.label}: invalid base64 content`);
    }
    const sizeBytes = estimateBase64DecodedBytes(attachment.content);
    if (sizeBytes <= 0 || sizeBytes > WEBCHAT_ATTACHMENT_MAX_BYTES) {
      throw new Error(
        `attachment ${attachment.label}: exceeds size limit (${sizeBytes} > ${WEBCHAT_ATTACHMENT_MAX_BYTES} bytes)`,
      );
    }

    const sniffedMime = normalizeMimeType(await sniffMimeFromBase64(attachment.content));
    const mimeType = sniffedMime ?? attachment.mimeType;
    if (!mimeType) {
      throw new Error(`attachment ${attachment.label}: unable to detect mime type`);
    }
    if (sniffedMime && attachment.mimeType && sniffedMime !== attachment.mimeType) {
      params.log?.warn(
        `attachment ${attachment.label}: mime mismatch (${attachment.mimeType} -> ${sniffedMime}), using sniffed`,
      );
    }

    const kind = kindFromMime(mimeType);
    if (kind === "image") {
      images.push({
        type: "image",
        data: attachment.content,
        mimeType,
      });
      continue;
    }
    if (kind !== "audio" && kind !== "document") {
      throw new Error(`attachment ${attachment.label}: unsupported mime type ${mimeType}`);
    }

    const buffer = Buffer.from(attachment.content, "base64");
    const saved = await saveMediaBuffer(
      buffer,
      mimeType,
      "inbound",
      WEBCHAT_ATTACHMENT_MAX_BYTES,
      attachment.fileName,
    );
    mediaPaths.push(saved.path);
    mediaTypes.push(saved.contentType ?? mimeType);
  }

  return {
    message: params.message,
    images,
    mediaPaths,
    mediaTypes,
  };
}
