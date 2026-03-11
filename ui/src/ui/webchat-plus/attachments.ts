import type { ChatAttachment } from "../ui-types.ts";

const WEBCHAT_ATTACHMENT_MAX_BYTES = 5_000_000;

function generateAttachmentId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function encodeBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  if (typeof btoa !== "function") {
    throw new Error("base64 encoding is unavailable in this runtime");
  }
  return btoa(binary);
}

async function fileToDataUrl(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  return `data:${file.type};base64,${encodeBase64(buffer)}`;
}

function attachmentKindFromMime(mimeType: string): "image" | "audio" | "file" {
  if (mimeType.startsWith("image/")) {
    return "image";
  }
  if (mimeType.startsWith("audio/")) {
    return "audio";
  }
  return "file";
}

function isSupportedDocumentMime(mimeType: string): boolean {
  if (mimeType.startsWith("text/")) {
    return true;
  }
  return [
    "application/pdf",
    "application/json",
    "application/zip",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ].includes(mimeType);
}

function validateFile(file: File): string | null {
  if (!file.type) {
    return `Unsupported file ${file.name}: missing MIME type`;
  }
  const isImage = file.type.startsWith("image/");
  const isAudio = file.type.startsWith("audio/");
  const isDocument = isSupportedDocumentMime(file.type);
  if (!isImage && !isAudio && !isDocument) {
    return `Unsupported file ${file.name}: ${file.type}`;
  }
  if (file.size > WEBCHAT_ATTACHMENT_MAX_BYTES) {
    return `File ${file.name} exceeds 5MB limit`;
  }
  return null;
}

export async function filesToChatAttachments(files: readonly File[]): Promise<{
  attachments: ChatAttachment[];
  errors: string[];
}> {
  const attachments: ChatAttachment[] = [];
  const errors: string[] = [];

  for (const file of files) {
    const validationError = validateFile(file);
    if (validationError) {
      errors.push(validationError);
      continue;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      attachments.push({
        id: generateAttachmentId(),
        dataUrl,
        mimeType: file.type,
        fileName: file.name,
        kind: attachmentKindFromMime(file.type),
        sizeBytes: file.size,
      });
    } catch {
      errors.push(`Failed to read file ${file.name}`);
    }
  }

  return { attachments, errors };
}

export async function clipboardItemsToChatAttachments(
  items: DataTransferItemList | undefined,
): Promise<ChatAttachment[]> {
  if (!items) {
    return [];
  }
  const files: File[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || !item.type.startsWith("image/")) {
      continue;
    }
    const file = item.getAsFile();
    if (file) {
      files.push(file);
    }
  }
  if (files.length === 0) {
    return [];
  }
  const { attachments } = await filesToChatAttachments(files);
  return attachments;
}
