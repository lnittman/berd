import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { CreateElicitationResponse } from "@agentclientprotocol/sdk";
import {
  type FormElicitationRequest,
  useElicitationStore,
} from "../stores/elicitationStore";
import { ElicitationPanel } from "./ElicitationPanel";

function enqueue(
  request: FormElicitationRequest,
): Promise<CreateElicitationResponse> {
  return new Promise((resolve) => {
    useElicitationStore.getState().enqueue({ request, resolve });
  });
}

describe("ElicitationPanel", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useElicitationStore.setState({ pendingBySessionId: {} });
  });

  it("renders adapter Other, multi-select, and free-text fields as one form", async () => {
    const user = userEvent.setup();
    const response = enqueue({
      mode: "form",
      sessionId: "session-1",
      message: "Shape the plan",
      requestedSchema: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            title: "Direction",
            oneOf: [
              { const: "local", title: "Local" },
              { const: "upstream", title: "Upstream" },
            ],
          },
          direction__other: {
            type: "string",
            title: "Other",
            _meta: { codex: { isOtherAnswer: true } },
          },
          surfaces: {
            type: "array",
            title: "Surfaces",
            items: {
              anyOf: [
                { const: "desktop", title: "Desktop" },
                { const: "cli", title: "CLI" },
              ],
            },
          },
          notes: { type: "string", title: "Notes" },
        },
        required: ["direction", "surfaces", "notes"],
      },
      _meta: { goose: { elicitationId: "question-1" } },
    });
    render(<ElicitationPanel sessionId="session-1" />);

    await user.click(screen.getByRole("radio", { name: "Other" }));
    await user.type(
      screen.getByRole("textbox", { name: "Direction other answer" }),
      "Hybrid",
    );
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("checkbox", { name: "Desktop" }));
    await user.click(screen.getByRole("checkbox", { name: "CLI" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.type(screen.getByRole("textbox", { name: "Notes" }), "Ship it");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await expect(response).resolves.toEqual({
      action: "accept",
      content: {
        direction__other: "Hybrid",
        surfaces: ["desktop", "cli"],
        notes: "Ship it",
      },
    });
  });

  it("does not coerce a cleared required number to zero", async () => {
    const user = userEvent.setup();
    void enqueue({
      mode: "form",
      sessionId: "session-1",
      message: "Choose a count",
      requestedSchema: {
        type: "object",
        properties: {
          count: { type: "number", title: "Count" },
        },
        required: ["count"],
      },
    });
    render(<ElicitationPanel sessionId="session-1" />);

    const input = screen.getByRole("spinbutton", { name: "Count" });
    await user.type(input, "12");
    await user.clear(input);

    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    expect(
      useElicitationStore.getState().pendingBySessionId["session-1"][0].content,
    ).not.toHaveProperty("count");
    expect(screen.queryByText("Question 1 of 1")).not.toBeInTheDocument();
  });

  it("accepts decimal numbers without native step validation", async () => {
    const user = userEvent.setup();
    const response = enqueue({
      mode: "form",
      sessionId: "session-1",
      message: "Choose a ratio",
      requestedSchema: {
        type: "object",
        properties: {
          ratio: { type: "number", title: "Ratio" },
        },
        required: ["ratio"],
      },
    });
    render(<ElicitationPanel sessionId="session-1" />);

    const form = screen.getByRole("form", { name: "Choose a ratio" });
    expect(form).toHaveAttribute("novalidate");
    const input = screen.getByRole("spinbutton", { name: "Ratio" });
    expect(input).toHaveAttribute("step", "any");
    await user.type(input, "2.5");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await expect(response).resolves.toEqual({
      action: "accept",
      content: { ratio: 2.5 },
    });
  });

  it("uses schema patterns in Berd's submit gate", async () => {
    const user = userEvent.setup();
    const response = enqueue({
      mode: "form",
      sessionId: "session-1",
      message: "Enter a code",
      requestedSchema: {
        type: "object",
        properties: {
          code: { type: "string", title: "Code", pattern: "[A-Z]{2}" },
        },
        required: ["code"],
      },
    });
    render(<ElicitationPanel sessionId="session-1" />);

    const input = screen.getByRole("textbox", { name: "Code" });
    await user.type(input, "aa");
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    await user.clear(input);
    await user.type(input, "OK");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await expect(response).resolves.toEqual({
      action: "accept",
      content: { code: "OK" },
    });
  });

  it("uses request-scoped form controls and confirms Other with Enter", async () => {
    const user = userEvent.setup();
    const response = enqueue({
      mode: "form",
      sessionId: "session-1",
      message: "Choose a direction",
      requestedSchema: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            title: "Direction",
            oneOf: [{ const: "local", title: "Local" }],
          },
          direction__other: {
            type: "string",
            title: "Other",
            _meta: { codex: { isOtherAnswer: true } },
          },
        },
        required: ["direction"],
      },
      _meta: { goose: { elicitationId: "request-42" } },
    });
    render(<ElicitationPanel sessionId="session-1" />);

    const form = screen.getByRole("form", { name: "Choose a direction" });
    expect(form).toHaveAttribute("autocomplete", "off");
    await user.click(screen.getByRole("radio", { name: "Other" }));
    const other = screen.getByRole("textbox", {
      name: "Direction other answer",
    });
    expect(other).toHaveAttribute(
      "name",
      "elicitation:request-42:direction__other",
    );
    expect(other).toHaveAttribute("autocomplete", "off");

    await user.type(other, "A third way{Enter}");

    await expect(response).resolves.toEqual({
      action: "accept",
      content: { direction__other: "A third way" },
    });
  });

  it("merges an agent-provided Other option with its companion input", async () => {
    const user = userEvent.setup();
    void enqueue({
      mode: "form",
      sessionId: "session-1",
      message: "Choose a direction",
      requestedSchema: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            title: "Direction",
            oneOf: [
              { const: "local", title: "Local" },
              {
                const: "Other",
                title: "Other",
                description: "Describe a different direction.",
              },
            ],
          },
          direction_custom: {
            type: "string",
            title: "Other",
          },
        },
        required: ["direction"],
      },
    });
    render(<ElicitationPanel sessionId="session-1" />);

    expect(screen.getAllByRole("radio", { name: "Other" })).toHaveLength(1);
    expect(screen.getByText("Describe a different direction.")).toBeVisible();
    await user.click(screen.getByRole("radio", { name: "Other" }));
    expect(
      screen.getByRole("textbox", { name: "Direction other answer" }),
    ).toBeVisible();
  });

  it("keeps an agent-provided Other default visible and editable", async () => {
    const user = userEvent.setup();
    const response = enqueue({
      mode: "form",
      sessionId: "session-1",
      message: "Choose a direction",
      requestedSchema: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            title: "Direction",
            default: "Other",
            oneOf: [
              { const: "local", title: "Local" },
              { const: "Other", title: "Other" },
            ],
          },
          direction_custom: { type: "string", title: "Other" },
        },
        required: ["direction"],
      },
    });
    render(<ElicitationPanel sessionId="session-1" />);

    expect(screen.getByRole("radio", { name: "Other" })).toBeChecked();
    await user.type(
      screen.getByRole("textbox", { name: "Direction other answer" }),
      "Hybrid",
    );
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await expect(response).resolves.toEqual({
      action: "accept",
      content: { direction_custom: "Hybrid" },
    });
  });

  it("offers a mutually exclusive custom answer for multi-select fields", async () => {
    const user = userEvent.setup();
    const response = enqueue({
      mode: "form",
      sessionId: "session-1",
      message: "Choose surfaces",
      requestedSchema: {
        type: "object",
        properties: {
          surfaces: {
            type: "array",
            title: "Surfaces",
            items: {
              anyOf: [
                { const: "desktop", title: "Desktop" },
                { const: "cli", title: "CLI" },
              ],
            },
          },
          surfaces_custom: {
            type: "string",
            title: "Other",
          },
        },
      },
    });
    render(<ElicitationPanel sessionId="session-1" />);

    await user.click(screen.getByRole("checkbox", { name: "Desktop" }));
    await user.click(screen.getByRole("checkbox", { name: /Other/ }));
    await user.type(
      screen.getByRole("textbox", { name: "Surfaces other answer" }),
      "API",
    );
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await expect(response).resolves.toEqual({
      action: "accept",
      content: { surfaces_custom: "API" },
    });
  });

  it("merges an agent-provided multi-select Other option with its companion input", async () => {
    const user = userEvent.setup();
    const response = enqueue({
      mode: "form",
      sessionId: "session-1",
      message: "Choose surfaces",
      requestedSchema: {
        type: "object",
        properties: {
          surfaces: {
            type: "array",
            title: "Surfaces",
            items: {
              anyOf: [
                { const: "desktop", title: "Desktop" },
                {
                  const: "Other",
                  title: "Other",
                  description: "Name another surface.",
                },
              ],
            },
          },
          surfaces_custom: {
            type: "string",
            title: "Other",
            _meta: {
              _askUserQuestionCustomAnswer: {
                questionId: "surfaces",
                isCustomAnswer: true,
              },
            },
          },
        },
      },
    });
    render(<ElicitationPanel sessionId="session-1" />);

    expect(screen.getAllByRole("checkbox", { name: /Other/ })).toHaveLength(1);
    expect(screen.getByText("Name another surface.")).toBeVisible();

    await user.click(screen.getByRole("checkbox", { name: /Other/ }));
    await user.type(
      screen.getByRole("textbox", { name: "Surfaces other answer" }),
      "Web",
    );
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await expect(response).resolves.toEqual({
      action: "accept",
      content: { surfaces_custom: "Web" },
    });
  });

  it("keeps an agent-provided multi-select Other default visible and editable", async () => {
    const user = userEvent.setup();
    const response = enqueue({
      mode: "form",
      sessionId: "session-1",
      message: "Choose surfaces",
      requestedSchema: {
        type: "object",
        properties: {
          surfaces: {
            type: "array",
            title: "Surfaces",
            default: ["Other"],
            items: {
              anyOf: [
                { const: "desktop", title: "Desktop" },
                { const: "Other", title: "Other" },
              ],
            },
          },
          surfaces_custom: { type: "string", title: "Other" },
        },
      },
    });
    render(<ElicitationPanel sessionId="session-1" />);

    expect(screen.getByRole("checkbox", { name: /Other/ })).toBeChecked();
    await user.type(
      screen.getByRole("textbox", { name: "Surfaces other answer" }),
      "Web",
    );
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await expect(response).resolves.toEqual({
      action: "accept",
      content: { surfaces_custom: "Web" },
    });
  });

  it("supports direct question navigation without allowing partial submit", async () => {
    const user = userEvent.setup();
    const response = enqueue({
      mode: "form",
      sessionId: "session-1",
      message: "Shape the rollout",
      requestedSchema: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            title: "Direction",
            enum: ["local", "upstream"],
            enumNames: ["Local", "Upstream"],
          },
          note: { type: "string", title: "Note" },
        },
        required: ["direction", "note"],
      },
    });
    render(<ElicitationPanel sessionId="session-1" />);

    expect(screen.getByText("Question 1 of 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Question 2" }));
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "Note" }), "Ready");
    expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Question 1" }));
    await user.click(screen.getByRole("radio", { name: "Local" }));
    await user.click(
      screen.getByRole("button", { name: "Question 2, answered" }),
    );
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await expect(response).resolves.toEqual({
      action: "accept",
      content: { direction: "local", note: "Ready" },
    });
  });

  it("records an explicit false boolean answer", async () => {
    const user = userEvent.setup();
    const response = enqueue({
      mode: "form",
      sessionId: "session-1",
      message: "Confirm the setting",
      requestedSchema: {
        type: "object",
        properties: {
          enabled: { type: "boolean", title: "Enable previews?" },
        },
        required: ["enabled"],
      },
    });
    render(<ElicitationPanel sessionId="session-1" />);

    await user.click(screen.getByRole("radio", { name: "No" }));
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await expect(response).resolves.toEqual({
      action: "accept",
      content: { enabled: false },
    });
  });

  it("preserves a draft on Escape and requires explicit cancellation", async () => {
    const user = userEvent.setup();
    const response = enqueue({
      mode: "form",
      sessionId: "session-1",
      message: "One more thing",
      requestedSchema: {
        type: "object",
        properties: { note: { type: "string", title: "Note" } },
      },
    });
    render(<ElicitationPanel sessionId="session-1" />);

    await waitFor(() =>
      expect(
        screen.getByRole("form", { name: "One more thing" }),
      ).toHaveFocus(),
    );
    await user.type(screen.getByRole("textbox", { name: "Note" }), "Draft");
    await user.keyboard("{Escape}");

    expect(screen.getByRole("textbox", { name: "Note" })).toHaveValue("Draft");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await expect(response).resolves.toEqual({ action: "cancel" });
  });

  it("returns focus to the composer after the final answer", async () => {
    const user = userEvent.setup();
    render(
      <>
        <textarea aria-label="Message" />
        <ElicitationPanel sessionId="session-1" />
      </>,
    );
    const composer = screen.getByRole("textbox", { name: "Message" });
    composer.focus();

    act(() => {
      void enqueue({
        mode: "form",
        sessionId: "session-1",
        message: "Name the release",
        requestedSchema: {
          type: "object",
          properties: { name: { type: "string", title: "Name" } },
          required: ["name"],
        },
      });
    });

    await waitFor(() =>
      expect(
        screen.getByRole("form", { name: "Name the release" }),
      ).toHaveFocus(),
    );
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Perch");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(composer).toHaveFocus());
  });
});
