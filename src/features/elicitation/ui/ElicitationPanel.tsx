import { useEffect, useId, useRef } from "react";
import type {
  ElicitationContentValue,
  ElicitationPropertySchema,
} from "@agentclientprotocol/sdk";
import { Check, CircleHelp } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  findOtherCompanion,
  isOtherCompanionField,
  useElicitationStore,
} from "@/features/elicitation/stores/elicitationStore";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { RadioGroup, RadioGroupItem } from "@/shared/ui/radio-group";

export function useHasPendingElicitation(sessionId: string): boolean {
  return useElicitationStore(
    (state) => (state.pendingBySessionId[sessionId]?.length ?? 0) > 0,
  );
}

type Option = { value: string; label: string; description?: string };

function isOtherOption(option: Option): boolean {
  return (
    option.value.trim().toLowerCase() === "other" ||
    option.label.trim().toLowerCase() === "other"
  );
}

function optionsFrom(
  source: Record<string, unknown> | null,
  oneOfKey: "oneOf" | "anyOf",
): Option[] {
  if (!source) return [];
  const oneOf = source[oneOfKey];
  if (Array.isArray(oneOf)) {
    return oneOf.map((option) => {
      const item = option as Record<string, unknown>;
      return {
        value: String(item.const ?? ""),
        label: String(item.title ?? item.const ?? ""),
        description:
          typeof item.description === "string" ? item.description : undefined,
      };
    });
  }
  if (Array.isArray(source.enum)) {
    const names = Array.isArray(source.enumNames) ? source.enumNames : [];
    return source.enum.map((value, index) => ({
      value: String(value),
      label: String(names[index] ?? value),
    }));
  }
  return [];
}

function singleSelectOptions(schema: ElicitationPropertySchema): Option[] {
  return optionsFrom(schema as Record<string, unknown>, "oneOf");
}

function multiSelectOptions(schema: ElicitationPropertySchema): Option[] {
  const raw = schema as Record<string, unknown>;
  const items =
    raw.items != null && typeof raw.items === "object"
      ? (raw.items as Record<string, unknown>)
      : null;
  return optionsFrom(items, "anyOf");
}

function Field({
  name,
  schema,
  properties,
  content,
  controlScope,
  required,
  onChange,
}: {
  name: string;
  schema: ElicitationPropertySchema;
  properties: Record<string, ElicitationPropertySchema>;
  content: Record<string, ElicitationContentValue>;
  controlScope: string;
  required: boolean;
  onChange: (key: string, value: ElicitationContentValue | undefined) => void;
}) {
  const { t } = useTranslation("chat");
  const fieldId = useId();
  const raw = schema as Record<string, unknown>;
  const title = typeof raw.title === "string" ? raw.title : name;
  const description =
    typeof raw.description === "string" ? raw.description : null;
  const descriptionId = description ? `${fieldId}-description` : undefined;
  const controlName = `${controlScope}:${name}`;
  const value = content[name];
  const singleOptions = singleSelectOptions(schema);
  const companion = findOtherCompanion(properties, name);

  if (schema.type === "array") {
    const options = multiSelectOptions(schema);
    const selected = Array.isArray(value) ? value : [];
    const maxItems = typeof raw.maxItems === "number" ? raw.maxItems : null;
    const limitDescriptionId =
      maxItems != null ? `${fieldId}-limit-description` : undefined;
    const fieldDescriptionIds = [descriptionId, limitDescriptionId]
      .filter(Boolean)
      .join(" ");
    const companionName = companion?.[0];
    const companionSchema = companion?.[1] as
      | Record<string, unknown>
      | undefined;
    const explicitOtherOption = companionName
      ? options.find(isOtherOption)
      : undefined;
    const visibleOptions = explicitOtherOption
      ? options.filter((option) => option !== explicitOtherOption)
      : options;
    const otherValue = companionName ? content[companionName] : undefined;
    const explicitOtherSelected =
      explicitOtherOption != null &&
      selected.includes(explicitOtherOption.value);
    const customOtherSelected =
      companionName != null &&
      typeof otherValue === "string" &&
      value === undefined;
    const otherSelected = explicitOtherSelected || customOtherSelected;
    const visibleSelected = explicitOtherOption
      ? selected.filter((item) => item !== explicitOtherOption.value)
      : selected;
    return (
      <fieldset
        className="space-y-2"
        aria-describedby={fieldDescriptionIds || undefined}
      >
        <legend className="font-medium text-sm">{title}</legend>
        {description ? (
          <p id={descriptionId} className="text-muted-foreground text-xs">
            {description}
          </p>
        ) : null}
        {maxItems != null ? (
          <p id={limitDescriptionId} className="text-muted-foreground text-xs">
            {t("elicitation.chooseUpTo", { count: maxItems })}
          </p>
        ) : null}
        <div className="grid gap-2">
          {visibleOptions.map((option, index) => {
            const checked = visibleSelected.includes(option.value);
            const atLimit =
              maxItems != null && visibleSelected.length >= maxItems;
            const optionId = `${fieldId}-option-${index}`;
            const optionDescriptionId = option.description
              ? `${optionId}-description`
              : undefined;
            return (
              <Label
                key={option.value}
                htmlFor={optionId}
                data-state={checked ? "checked" : "unchecked"}
                className="cursor-pointer items-start rounded-md border border-border p-3 data-[state=checked]:border-primary data-[state=checked]:bg-primary/5"
              >
                <Checkbox
                  id={optionId}
                  name={`${controlName}:${index}`}
                  value={option.value}
                  checked={checked}
                  disabled={!checked && atLimit}
                  aria-describedby={optionDescriptionId}
                  onCheckedChange={() => {
                    if (companionName) onChange(companionName, undefined);
                    onChange(
                      name,
                      checked
                        ? visibleSelected.filter(
                            (item) => item !== option.value,
                          )
                        : [...visibleSelected, option.value],
                    );
                  }}
                  className="mt-0.5"
                />
                <span className="min-w-0 text-sm leading-normal">
                  <span className="block font-medium">{option.label}</span>
                  {option.description ? (
                    <span
                      id={optionDescriptionId}
                      className="block text-muted-foreground text-xs"
                    >
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </Label>
            );
          })}
          {companionName ? (
            <div
              data-state={otherSelected ? "checked" : "unchecked"}
              className="rounded-md border border-border p-3 data-[state=checked]:border-primary data-[state=checked]:bg-primary/5"
            >
              <Label
                htmlFor={`${fieldId}-other`}
                className="cursor-pointer items-start"
              >
                <Checkbox
                  id={`${fieldId}-other`}
                  name={`${controlName}:other`}
                  checked={otherSelected}
                  onCheckedChange={() => {
                    if (otherSelected) {
                      if (explicitOtherSelected) {
                        onChange(
                          name,
                          selected.filter(
                            (item) => item !== explicitOtherOption.value,
                          ),
                        );
                      }
                      onChange(companionName, undefined);
                      return;
                    }
                    onChange(name, undefined);
                    onChange(companionName, "");
                  }}
                  className="mt-0.5"
                />
                <span className="min-w-0 text-sm leading-normal">
                  <span className="block font-medium">
                    {explicitOtherOption?.label ??
                      (typeof companionSchema?.title === "string"
                        ? companionSchema.title
                        : t("elicitation.other"))}
                  </span>
                  {explicitOtherOption?.description ||
                  typeof companionSchema?.description === "string" ? (
                    <span className="block text-muted-foreground text-xs">
                      {explicitOtherOption?.description ??
                        String(companionSchema?.description)}
                    </span>
                  ) : null}
                </span>
              </Label>
              {otherSelected ? (
                <Input
                  type="text"
                  name={`${controlScope}:${companionName}`}
                  autoComplete="off"
                  autoFocus
                  aria-label={t("elicitation.otherAnswerLabel", { title })}
                  value={typeof otherValue === "string" ? otherValue : ""}
                  placeholder={t("elicitation.answerPlaceholder")}
                  onChange={(event) => {
                    if (explicitOtherSelected) onChange(name, undefined);
                    onChange(companionName, event.target.value);
                  }}
                  className="mt-3"
                />
              ) : null}
            </div>
          ) : null}
        </div>
      </fieldset>
    );
  }

  if (singleOptions.length > 0) {
    const companionName = companion?.[0];
    const companionSchema = companion?.[1] as
      | Record<string, unknown>
      | undefined;
    const otherValue = companionName ? content[companionName] : undefined;
    const explicitOtherOption = companionName
      ? singleOptions.find(isOtherOption)
      : undefined;
    const visibleOptions = explicitOtherOption
      ? singleOptions.filter((option) => option !== explicitOtherOption)
      : singleOptions;
    const explicitOtherSelected =
      explicitOtherOption != null && value === explicitOtherOption.value;
    const customOtherSelected =
      companionName != null &&
      typeof otherValue === "string" &&
      value === undefined;
    const otherSelected = explicitOtherSelected || customOtherSelected;
    const otherOptionValue = `${controlScope}:${name}:other`;
    const selectedValue = otherSelected
      ? otherOptionValue
      : typeof value === "string"
        ? value
        : "";
    return (
      <fieldset className="space-y-2" aria-describedby={descriptionId}>
        <legend id={`${fieldId}-title`} className="font-medium text-sm">
          {title}
        </legend>
        {description ? (
          <p id={descriptionId} className="text-muted-foreground text-xs">
            {description}
          </p>
        ) : null}
        <RadioGroup
          name={controlName}
          value={selectedValue}
          required={required}
          aria-labelledby={`${fieldId}-title`}
          onValueChange={(nextValue) => {
            if (nextValue === otherOptionValue && companionName) {
              onChange(name, undefined);
              onChange(companionName, "");
              return;
            }
            onChange(name, nextValue);
            if (companionName) onChange(companionName, undefined);
          }}
          className="gap-2"
        >
          {visibleOptions.map((option, index) => {
            const checked = value === option.value;
            const optionId = `${fieldId}-option-${index}`;
            const optionDescriptionId = option.description
              ? `${optionId}-description`
              : undefined;
            return (
              <Label
                key={option.value}
                htmlFor={optionId}
                data-state={checked ? "checked" : "unchecked"}
                className="cursor-pointer items-start rounded-md border border-border p-3 data-[state=checked]:border-primary data-[state=checked]:bg-primary/5"
              >
                <RadioGroupItem
                  id={optionId}
                  value={option.value}
                  aria-describedby={optionDescriptionId}
                  className="mt-0.5"
                />
                <span className="min-w-0 text-sm leading-normal">
                  <span className="block font-medium">{option.label}</span>
                  {option.description ? (
                    <span
                      id={optionDescriptionId}
                      className="block text-muted-foreground text-xs"
                    >
                      {option.description}
                    </span>
                  ) : null}
                </span>
              </Label>
            );
          })}
          {companionName ? (
            <div
              data-state={otherSelected ? "checked" : "unchecked"}
              className="rounded-md border border-border p-3 data-[state=checked]:border-primary data-[state=checked]:bg-primary/5"
            >
              <Label
                htmlFor={`${fieldId}-other`}
                className="cursor-pointer items-start"
              >
                <RadioGroupItem
                  id={`${fieldId}-other`}
                  value={otherOptionValue}
                  className="mt-0.5"
                />
                <span className="font-medium text-sm leading-normal">
                  {explicitOtherOption?.label ??
                    (typeof companionSchema?.title === "string"
                      ? companionSchema.title
                      : t("elicitation.other"))}
                </span>
              </Label>
              {explicitOtherOption?.description ? (
                <p className="ml-6 text-muted-foreground text-xs">
                  {explicitOtherOption.description}
                </p>
              ) : null}
              {otherSelected ? (
                <Input
                  type="text"
                  name={`${controlScope}:${companionName}`}
                  autoComplete="off"
                  autoFocus
                  aria-label={t("elicitation.otherAnswerLabel", { title })}
                  value={typeof otherValue === "string" ? otherValue : ""}
                  placeholder={t("elicitation.answerPlaceholder")}
                  onChange={(event) => {
                    if (explicitOtherSelected) onChange(name, undefined);
                    onChange(companionName, event.target.value);
                  }}
                  className="mt-3"
                />
              ) : null}
            </div>
          ) : null}
        </RadioGroup>
      </fieldset>
    );
  }

  if (schema.type === "boolean") {
    return (
      <fieldset className="space-y-2" aria-describedby={descriptionId}>
        <legend id={`${fieldId}-title`} className="font-medium text-sm">
          {title}
        </legend>
        {description ? (
          <p id={descriptionId} className="text-muted-foreground text-xs">
            {description}
          </p>
        ) : null}
        <RadioGroup
          name={controlName}
          value={typeof value === "boolean" ? String(value) : ""}
          required={required}
          aria-labelledby={`${fieldId}-title`}
          onValueChange={(nextValue) => onChange(name, nextValue === "true")}
          className="gap-2"
        >
          {[
            { value: "true", label: t("elicitation.yes") },
            { value: "false", label: t("elicitation.no") },
          ].map((option, index) => {
            const checked = value === (option.value === "true");
            const optionId = `${fieldId}-option-${index}`;
            return (
              <Label
                key={option.value}
                htmlFor={optionId}
                data-state={checked ? "checked" : "unchecked"}
                className="cursor-pointer items-center rounded-md border border-border p-3 data-[state=checked]:border-primary data-[state=checked]:bg-primary/5"
              >
                <RadioGroupItem id={optionId} value={option.value} />
                <span className="text-sm leading-normal">{option.label}</span>
              </Label>
            );
          })}
        </RadioGroup>
      </fieldset>
    );
  }

  const numeric = schema.type === "number" || schema.type === "integer";
  return (
    <div className="space-y-2 text-sm">
      <Label htmlFor={fieldId} className="font-medium">
        {title}
      </Label>
      {description ? (
        <p id={descriptionId} className="text-muted-foreground text-xs">
          {description}
        </p>
      ) : null}
      <Input
        id={fieldId}
        name={controlName}
        type={numeric ? "number" : "text"}
        autoComplete="off"
        aria-describedby={descriptionId}
        required={required}
        min={typeof raw.minimum === "number" ? raw.minimum : undefined}
        max={typeof raw.maximum === "number" ? raw.maximum : undefined}
        step={schema.type === "integer" ? 1 : numeric ? "any" : undefined}
        minLength={
          typeof raw.minLength === "number" ? raw.minLength : undefined
        }
        maxLength={
          typeof raw.maxLength === "number" ? raw.maxLength : undefined
        }
        pattern={typeof raw.pattern === "string" ? raw.pattern : undefined}
        value={
          typeof value === "string" || typeof value === "number" ? value : ""
        }
        onChange={(event) => {
          if (event.target.value === "") {
            onChange(name, undefined);
            return;
          }
          onChange(
            name,
            numeric ? Number(event.target.value) : event.target.value,
          );
        }}
      />
    </div>
  );
}

function fieldIncomplete(
  name: string,
  schema: ElicitationPropertySchema,
  properties: Record<string, ElicitationPropertySchema>,
  required: boolean,
  content: Record<string, ElicitationContentValue>,
): boolean {
  const raw = schema as Record<string, unknown>;
  const value = content[name];
  const companion = findOtherCompanion(properties, name);
  const otherValue = companion ? content[companion[0]] : undefined;
  if (typeof otherValue === "string" && value === undefined) {
    const length = otherValue.trim().length;
    const minimum =
      typeof (companion?.[1] as Record<string, unknown>)?.minLength === "number"
        ? ((companion?.[1] as Record<string, unknown>).minLength as number)
        : 1;
    return length < minimum;
  }
  if (value === undefined || value === "") return required;
  if (Array.isArray(value)) {
    const minimum =
      typeof raw.minItems === "number" ? raw.minItems : required ? 1 : 0;
    const maximum =
      typeof raw.maxItems === "number"
        ? raw.maxItems
        : Number.POSITIVE_INFINITY;
    return value.length < minimum || value.length > maximum;
  }
  if (typeof value === "string") {
    const length = value.trim().length;
    if (required && length === 0) return true;
    if (typeof raw.minLength === "number" && length < raw.minLength)
      return true;
    if (typeof raw.maxLength === "number" && length > raw.maxLength)
      return true;
    if (typeof raw.pattern === "string") {
      try {
        if (!new RegExp(raw.pattern).test(value)) return true;
      } catch {
        // Ignore an invalid provider pattern rather than making the form
        // impossible to submit. Valid schemas still use Berd's own gate.
      }
    }
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return true;
    if (schema.type === "integer" && !Number.isInteger(value)) return true;
    if (typeof raw.minimum === "number" && value < raw.minimum) return true;
    if (typeof raw.maximum === "number" && value > raw.maximum) return true;
  }
  return false;
}

function fieldHasAnswer(
  name: string,
  properties: Record<string, ElicitationPropertySchema>,
  content: Record<string, ElicitationContentValue>,
): boolean {
  const value = content[name];
  const companion = findOtherCompanion(properties, name);
  const otherValue = companion ? content[companion[0]] : undefined;
  if (typeof otherValue === "string" && value === undefined) {
    return otherValue.trim().length > 0;
  }
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined;
}

export function ElicitationPanel({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("chat");
  const titleId = useId();
  const statusId = useId();
  const panelRef = useRef<HTMLFormElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const previousPendingIdRef = useRef<string | null>(null);
  const pending = useElicitationStore(
    (state) => state.pendingBySessionId[sessionId]?.[0] ?? null,
  );
  const setValue = useElicitationStore((state) => state.setValue);
  const setStep = useElicitationStore((state) => state.setStep);
  const accept = useElicitationStore((state) => state.accept);
  const decline = useElicitationStore((state) => state.decline);
  const cancel = useElicitationStore((state) => state.cancel);
  const pendingId = pending?.id ?? null;

  if (
    pending &&
    previousPendingIdRef.current === null &&
    restoreFocusRef.current === null
  ) {
    const activeElement = document.activeElement;
    restoreFocusRef.current =
      activeElement instanceof HTMLElement && activeElement !== document.body
        ? activeElement
        : null;
  }
  previousPendingIdRef.current = pendingId;

  useEffect(() => {
    if (!pendingId) return;

    panelRef.current?.focus({ preventScroll: true });
    const restoreFocus = restoreFocusRef.current;
    return () => {
      window.requestAnimationFrame(() => {
        const stillPending =
          (useElicitationStore.getState().pendingBySessionId[sessionId]
            ?.length ?? 0) > 0;
        if (!stillPending) {
          if (restoreFocus?.isConnected) {
            restoreFocus.focus({ preventScroll: true });
          }
          restoreFocusRef.current = null;
        }
      });
    };
  }, [pendingId, sessionId]);

  if (!pending) return null;
  const properties = pending.request.requestedSchema.properties ?? {};
  const fields = Object.entries(properties).filter(
    ([name]) => !isOtherCompanionField(properties, name),
  );
  const step = Math.min(pending.step, Math.max(0, fields.length - 1));
  const [name, schema] = fields[step] ?? [];
  const required = name
    ? (pending.request.requestedSchema.required?.includes(name) ?? false)
    : false;
  const incomplete =
    name && schema
      ? fieldIncomplete(name, schema, properties, required, pending.content)
      : false;
  const hasIncompleteRequiredField = fields.some(([fieldName, fieldSchema]) =>
    fieldIncomplete(
      fieldName,
      fieldSchema,
      properties,
      pending.request.requestedSchema.required?.includes(fieldName) ?? false,
      pending.content,
    ),
  );
  const last = step === fields.length - 1;
  const attached = pending.resolve !== null;
  const controlScope = `elicitation:${pending.id}`;

  const submitCurrentStep = () => {
    if (!attached || incomplete) return;
    if (last || fields.length === 0) {
      if (!hasIncompleteRequiredField) accept(sessionId);
      return;
    }
    setStep(sessionId, step + 1);
  };

  return (
    <form
      ref={panelRef}
      tabIndex={-1}
      autoComplete="off"
      noValidate
      aria-labelledby={titleId}
      aria-describedby={statusId}
      data-elicitation-id={pending.id}
      onSubmit={(event) => {
        event.preventDefault();
        submitCurrentStep();
      }}
      className="max-h-[min(65vh,36rem)] overflow-y-auto rounded-lg border border-border bg-card p-4 shadow-[var(--shadow-chat)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          {pending.recovered ? (
            <p className="mb-1 flex items-center gap-1.5 font-medium text-xs uppercase tracking-wide text-warning">
              <CircleHelp className="size-3.5" aria-hidden="true" />
              {t("elicitation.recoveredQuestion")}
            </p>
          ) : null}
          <h2 id={titleId} className="font-display font-semibold text-base">
            {pending.request.message}
          </h2>
          <p
            id={statusId}
            className="mt-1 text-muted-foreground text-xs"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {fields.length > 1
              ? t("elicitation.questionProgress", {
                  current: step + 1,
                  total: fields.length,
                })
              : fields.length === 0
                ? t("elicitation.reviewAndSubmit")
                : null}
            {pending.recovered
              ? pending.continuation === "prompt"
                ? `${fields.length > 1 ? " · " : ""}${t("elicitation.continuesAfterRestart")}`
                : `${fields.length > 1 ? " · " : ""}${t("elicitation.reconnected")}`
              : ""}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          flush
          onClick={() => cancel(sessionId)}
          className="shrink-0"
        >
          {t("elicitation.cancel")}
        </Button>
      </div>

      {fields.length > 1 ? (
        <nav
          aria-label={t("elicitation.questionNavigation")}
          className="mb-4 flex flex-wrap gap-2"
        >
          {fields.map(([fieldName], index) => {
            const answered = fieldHasAnswer(
              fieldName,
              properties,
              pending.content,
            );
            return (
              <Button
                key={fieldName}
                type="button"
                size="icon-xxs"
                variant={
                  index === step ? "primary" : answered ? "subtle" : "outline"
                }
                aria-current={index === step ? "step" : undefined}
                aria-label={t(
                  answered
                    ? "elicitation.answeredQuestionLabel"
                    : "elicitation.questionLabel",
                  { question: index + 1 },
                )}
                disabled={!attached}
                onClick={() => setStep(sessionId, index)}
              >
                {answered && index !== step ? (
                  <Check aria-hidden="true" />
                ) : (
                  index + 1
                )}
              </Button>
            );
          })}
        </nav>
      ) : null}

      {name && schema ? (
        <Field
          key={`${pending.id}:${name}`}
          name={name}
          schema={schema}
          properties={properties}
          content={pending.content}
          controlScope={controlScope}
          required={required}
          onChange={(key, next) => setValue(sessionId, key, next)}
        />
      ) : null}

      {!attached ? (
        <p
          className="mt-4 text-muted-foreground text-xs"
          role="status"
          aria-live="polite"
        >
          {t("elicitation.reconnectingDescription")}
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-border border-t pt-3">
        <div className="flex min-h-9 items-center gap-4">
          {step > 0 ? (
            <Button
              type="button"
              variant="ghost"
              flush
              disabled={!attached}
              onClick={() => setStep(sessionId, step - 1)}
            >
              {t("elicitation.back")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            flush
            disabled={!attached}
            onClick={() => decline(sessionId)}
          >
            {t("elicitation.decline")}
          </Button>
        </div>
        <Button
          type="submit"
          disabled={
            Boolean(incomplete) ||
            !attached ||
            ((last || fields.length === 0) && hasIncompleteRequiredField)
          }
        >
          {!attached
            ? t("elicitation.reconnecting")
            : last || fields.length === 0
              ? t("elicitation.submit")
              : t("elicitation.next")}
        </Button>
      </div>
    </form>
  );
}
