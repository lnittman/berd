import { describe, expect, it } from "vitest";
import { createLocalUserMessage } from "./localUserMessage";

describe("createLocalUserMessage", () => {
  it("builds the same rich local turn for optimistic and committed rendering", () => {
    const message = createLocalUserMessage("wire text", {
      created: 123,
      displayText: "Visible text",
      attachments: [
        {
          id: "image-1",
          kind: "image",
          name: "diagram.png",
          mimeType: "image/png",
          base64: "aW1hZ2U=",
          previewUrl: "blob:diagram",
        },
      ],
      chips: [{ label: "ask-deep", type: "skill" }],
      persona: { id: "reviewer", name: "Reviewer" },
      metadata: { queueRecordId: "record-1" },
    });

    expect(message).toMatchObject({
      id: "queued:record-1",
      created: 123,
      role: "user",
      content: [
        { type: "text", text: "Visible text" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ],
      metadata: {
        userVisible: true,
        agentVisible: true,
        queueRecordId: "record-1",
        targetPersonaId: "reviewer",
        targetPersonaName: "Reviewer",
        attachments: [
          {
            type: "file",
            name: "diagram.png",
            mimeType: "image/png",
          },
        ],
        chips: [{ label: "ask-deep", type: "skill" }],
      },
    });
  });
});
