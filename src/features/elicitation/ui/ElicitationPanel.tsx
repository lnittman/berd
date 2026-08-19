import { useEffect, useId, useRef } from "react";
import type {
  ElicitationContentValue,
  ElicitationPropertySchema,
} from "@agentclientprotocol/sdk";
import { Button } from "@/shared/ui/button";
import { useElicitationStore } from "@/features/elicitation/stores/elicitationStore";

export function useHasPendingElicitation(sessionId: string): boolean {
  return useElicitationStore(
    (state) => (state.pendingBySessionId[sessionId]?.length ?? 0) > 0,
  );
}

type Option = { value: string; label: string; description?: string };

function optionsFor(schema: ElicitationPropertySchema): Option[] {
  const raw = schema as Record<string, unknown>;
  if (Array.isArray(raw.oneOf)) {
    return raw.oneOf.map((option) => {
      const item = option as Record<string, unknown>;
      return {
        value: String(item.const ?? ""),
        label: String(item.title ?? item.const ?? ""),
        description:
          typeof item.description === "string" ? item.description : undefined,
      };
    });
  }
  if (Array.isArray(raw.enum)) {
    const names = Array.isArray(raw.enumNames) ? raw.enumNames : [];
    return raw.enum.map((value, index) => ({
      value: String(value),
      label: String(names[index] ?? value),
    }));
  }
  return [];
}

function Field({
  name,
  schema,
  value,
  onChange,
}: {
  name: string;
  schema: ElicitationPropertySchema;
  value: ElicitationContentValue | undefined;
  onChange: (value: ElicitationContentValue) => void;
}) {
  const raw = schema as Record<string, unknown>;
  const title = typeof raw.title === "string" ? raw.title : name;
  const description =
    typeof raw.description === "string" ? raw.description : null;
  const options = optionsFor(schema);

  if (options.length > 0) {
    return (
      <fieldset className="space-y-2">
        <legend className="font-medium text-sm">{title}</legend>
        {description ? (
          <p className="text-muted-foreground text-xs">{description}</p>
        ) : null}
        {options.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer gap-3 rounded-md border border-border p-3 has-[:checked]:border-primary has-[:checked]:bg-primary/5"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="mt-0.5"
            />
            <span className="min-w-0 text-sm">
              <span className="block font-medium">{option.label}</span>
              {option.description ? (
                <span className="block text-muted-foreground text-xs">
                  {option.description}
                </span>
              ) : null}
            </span>
          </label>
        ))}
      </fieldset>
    );
  }

  if (schema.type === "boolean") {
    return (
      <label className="flex items-center gap-3 text-sm">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{title}</span>
      </label>
    );
  }

  return (
    <label className="block space-y-2 text-sm">
      <span className="font-medium">{title}</span>
      {description ? (
        <span className="block text-muted-foreground text-xs">
          {description}
        </span>
      ) : null}
      <input
        type={
          schema.type === "number" || schema.type === "integer"
            ? "number"
            : "text"
        }
        value={
          typeof value === "string" || typeof value === "number" ? value : ""
        }
        onChange={(event) =>
          onChange(
            schema.type === "number" || schema.type === "integer"
              ? Number(event.target.value)
              : event.target.value,
          )
        }
        className="w-full rounded-md border border-input bg-background px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </label>
  );
}

export function ElicitationPanel({ sessionId }: { sessionId: string }) {
  const titleId = useId();
  const panelRef = useRef<HTMLElement>(null);
  const pending = useElicitationStore(
    (state) => state.pendingBySessionId[sessionId]?.[0] ?? null,
  );
  const setValue = useElicitationStore((state) => state.setValue);
  const setStep = useElicitationStore((state) => state.setStep);
  const accept = useElicitationStore((state) => state.accept);
  const cancel = useElicitationStore((state) => state.cancel);

  useEffect(() => {
    if (pending) panelRef.current?.focus({ preventScroll: true });
  }, [pending]);

  if (!pending) return null;
  const fields = Object.entries(
    pending.request.requestedSchema.properties ?? {},
  );
  const step = Math.min(pending.step, Math.max(0, fields.length - 1));
  const [name, schema] = fields[step] ?? [];
  const required =
    pending.request.requestedSchema.required?.includes(name) ?? false;
  const value = pending.content[name];
  const incomplete =
    required &&
    (value === undefined ||
      value === "" ||
      (Array.isArray(value) && value.length === 0));
  const last = step === fields.length - 1;

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      aria-labelledby={titleId}
      className="rounded-lg border border-border bg-card p-4 shadow-[var(--shadow-chat)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 id={titleId} className="font-display font-semibold text-base">
            {pending.request.message}
          </h2>
          <p className="mt-1 text-muted-foreground text-xs">
            Question {step + 1} of {fields.length}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => cancel(sessionId)}
        >
          Cancel
        </Button>
      </div>
      {name && schema ? (
        <Field
          name={name}
          schema={schema}
          value={value}
          onChange={(next) => setValue(sessionId, name, next)}
        />
      ) : null}
      <div className="mt-4 flex justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={step === 0}
          onClick={() => setStep(sessionId, step - 1)}
        >
          Back
        </Button>
        <Button
          type="button"
          disabled={incomplete}
          onClick={() =>
            last ? accept(sessionId) : setStep(sessionId, step + 1)
          }
        >
          {last ? "Submit" : "Next"}
        </Button>
      </div>
    </section>
  );
}
