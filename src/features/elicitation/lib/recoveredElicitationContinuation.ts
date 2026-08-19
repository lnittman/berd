import type { CreateElicitationResponse } from "@agentclientprotocol/sdk";
import { sendPromptInBackground } from "@/features/chat/lib/backgroundSend";
import { gooseServeSelectionFromExecutionTarget } from "@/features/chat/lib/gooseServeExecutionTarget";
import { useChatSessionStore } from "@/features/chat/stores/chatSessionStore";
import {
  type FormElicitationRequest,
  getOtherCompanionParent,
  isOtherCompanionField,
  isSecretElicitationProperty,
} from "@/features/elicitation/stores/elicitationStore";

function fieldLabel(request: FormElicitationRequest, name: string): string {
  const properties = request.requestedSchema.properties ?? {};
  let displayName = name;
  if (isOtherCompanionField(properties, name)) {
    displayName =
      getOtherCompanionParent(properties[name]) ??
      ["__other", "_custom"].reduce(
        (candidate, suffix) =>
          candidate.endsWith(suffix)
            ? candidate.slice(0, -suffix.length)
            : candidate,
        name,
      );
  }
  const schema = properties[displayName] as Record<string, unknown> | undefined;
  return typeof schema?.title === "string" && schema.title.trim()
    ? schema.title.trim()
    : displayName;
}

function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

export function recoveredElicitationPrompt(
  request: FormElicitationRequest,
  response: CreateElicitationResponse,
): string | null {
  if (response.action === "cancel") return null;
  if (response.action === "decline") {
    return [
      "Berd recovered an interactive question after the previous agent connection restarted.",
      `I declined to answer: ${request.message}`,
      "Continue the prior task without that answer, or ask a different question in plain prose if it is essential.",
    ].join("\n\n");
  }
  if (response.action !== "accept") return null;

  const properties = request.requestedSchema.properties ?? {};
  const answers = Object.entries(response.content ?? {}).map(([name, value]) =>
    properties[name] && isSecretElicitationProperty(properties[name])
      ? `- ${fieldLabel(request, name)}: [redacted]`
      : `- ${fieldLabel(request, name)}: ${formatValue(value)}`,
  );
  return [
    "Berd recovered an interactive question after the previous agent connection restarted.",
    `Original question: ${request.message}`,
    answers.length > 0
      ? `My answers:\n${answers.join("\n")}`
      : "I submitted the form without additional fields.",
    "Continue the prior task from these answers.",
  ].join("\n\n");
}

export async function continueRecoveredElicitation(
  request: FormElicitationRequest,
  response: CreateElicitationResponse,
): Promise<void> {
  const prompt = recoveredElicitationPrompt(request, response);
  if (!prompt) return;

  const session = useChatSessionStore.getState().getSession(request.sessionId);
  const providerId = gooseServeSelectionFromExecutionTarget(
    session?.executionTarget,
  ).providerId;
  await sendPromptInBackground(
    request.sessionId,
    prompt,
    providerId ?? "goose",
  );
}
