import { useEffect, useId, useRef } from "react";
import { Check, CircleHelp } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  fieldHasAnswer,
  fieldIncomplete,
} from "@/features/elicitation/lib/elicitationFieldValidation";
import {
  isOtherCompanionField,
  useElicitationStore,
} from "@/features/elicitation/stores/elicitationStore";
import { ElicitationField } from "@/features/elicitation/ui/ElicitationField";
import { Button } from "@/shared/ui/button";

export function useHasPendingElicitation(sessionId: string): boolean {
  return useElicitationStore(
    (state) => (state.pendingBySessionId[sessionId]?.length ?? 0) > 0,
  );
}

export function ElicitationPanel({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("chat");
  const titleId = useId();
  const statusId = useId();
  const panelRef = useRef<HTMLFormElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const pending = useElicitationStore(
    (state) => state.pendingBySessionId[sessionId]?.[0] ?? null,
  );
  const setValue = useElicitationStore((state) => state.setValue);
  const setStep = useElicitationStore((state) => state.setStep);
  const accept = useElicitationStore((state) => state.accept);
  const decline = useElicitationStore((state) => state.decline);
  const cancel = useElicitationStore((state) => state.cancel);
  const pendingId = pending?.id ?? null;

  useEffect(() => {
    const rememberIdleFocus = (event: FocusEvent) => {
      const hasPending =
        (useElicitationStore.getState().pendingBySessionId[sessionId]?.length ??
          0) > 0;
      if (hasPending) return;
      const target = event.target;
      if (target instanceof HTMLElement && target !== document.body) {
        restoreFocusRef.current = target;
      }
    };

    document.addEventListener("focusin", rememberIdleFocus);
    return () => document.removeEventListener("focusin", rememberIdleFocus);
  }, [sessionId]);

  useEffect(() => {
    if (!pendingId) return;

    if (restoreFocusRef.current === null) {
      const activeElement = document.activeElement;
      restoreFocusRef.current =
        activeElement instanceof HTMLElement && activeElement !== document.body
          ? activeElement
          : null;
    }
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
  const requiredFields = new Set(
    pending.request.requestedSchema.required ?? [],
  );
  const step = Math.min(pending.step, Math.max(0, fields.length - 1));
  const [name, schema] = fields[step] ?? [];
  const required = name ? requiredFields.has(name) : false;
  const incomplete =
    name && schema
      ? fieldIncomplete(name, schema, properties, required, pending.content)
      : false;
  const hasIncompleteRequiredField = fields.some(([fieldName, fieldSchema]) =>
    fieldIncomplete(
      fieldName,
      fieldSchema,
      properties,
      requiredFields.has(fieldName),
      pending.content,
    ),
  );
  const last = step === fields.length - 1;
  const attached = pending.resolve !== null;
  const controlScope = `elicitation:${pending.id}`;

  const submitCurrentStep = () => {
    if (incomplete) return;
    if (!last && fields.length > 0) {
      setStep(sessionId, step + 1);
      return;
    }
    if (attached && !hasIncompleteRequiredField) accept(sessionId);
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
        <ElicitationField
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
            ((last || fields.length === 0) &&
              (!attached || hasIncompleteRequiredField))
          }
        >
          {last || fields.length === 0
            ? attached
              ? t("elicitation.submit")
              : t("elicitation.reconnecting")
            : t("elicitation.next")}
        </Button>
      </div>
    </form>
  );
}
