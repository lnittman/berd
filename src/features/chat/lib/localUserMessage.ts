import {
  buildAcpImages,
  buildMessageAttachments,
} from "@/features/chat/lib/attachments";
import type {
  ChatAttachmentDraft,
  Message,
  MessageChip,
  MessageMetadata,
} from "@/shared/types/messages";
import { createUserMessage } from "@/shared/types/messages";

export interface LocalUserMessageOptions {
  id?: string;
  created?: number;
  displayText?: string;
  attachments?: ChatAttachmentDraft[];
  chips?: MessageChip[];
  persona?: { id: string; name?: string };
  metadata?: Partial<MessageMetadata>;
}

/**
 * Builds the renderer-owned user turn shared by optimistic queue projection
 * and the durable transcript commit. Keeping one constructor prevents the
 * instant version from changing shape when ACP setup finishes.
 */
export function createLocalUserMessage(
  text: string,
  options: LocalUserMessageOptions = {},
): Message {
  const message = createUserMessage(
    options.displayText ?? text,
    buildMessageAttachments(options.attachments),
    options.chips,
  );
  const queueRecordId = options.metadata?.queueRecordId;
  if (options.id) message.id = options.id;
  else if (queueRecordId) message.id = `queued:${queueRecordId}`;
  if (options.created !== undefined) message.created = options.created;
  if (options.persona) {
    message.metadata = {
      ...message.metadata,
      targetPersonaId: options.persona.id,
      targetPersonaName: options.persona.name,
    };
  }
  if (options.metadata) {
    message.metadata = { ...message.metadata, ...options.metadata };
  }
  for (const image of buildAcpImages(options.attachments) ?? []) {
    message.content.push({
      type: "image",
      data: image.base64,
      mimeType: image.mimeType,
    });
  }
  return message;
}
