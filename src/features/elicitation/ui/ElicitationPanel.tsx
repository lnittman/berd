import { useEffect, useId, useRef, useState } from "react";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { PreCommitSendRejectedError } from "@/features/chat/lib/preCommitSendRejection";
import {
  fieldHasAnswer,
  fieldIncomplete,
} from "@/features/elicitation/lib/elicitationFieldValidation";
import {
  acceptedElicitationResponse,
  isOtherCompanionField,
  presentedElicitation,
  useElicitationStore,
} from "@/features/elicitation/stores/elicitationStore";
import { continueRecoveredElicitation } from "@/features/elicitation/lib/recoveredElicitationContinuation";
import { ElicitationField } from "@/features/elicitation/ui/ElicitationField";
import { cn } from "@/shared/lib/cn";
import { Button } from "@/shared/ui/button";

const BRIDGE_BOILERPLATE_MESSAGES = new Set([
  "Input requested",
  "Please answer the following questions.",
]);

class DetachedDeliveryOwnershipLostError extends PreCommitSendRejectedError {}

/** True while an agent is blocked on an answer anywhere in this session's
 * queue. A recovered draft alone must not take the composer from an idle
 * session, but a live request behind one still has to. */
export function useHasAttachedElicitation(sessionId: string): boolean {
  return useElicitationStore((state) =>
    (state.pendingBySessionId[sessionId] ?? []).some(
      (pending) => pending.resolve !== null,
    ),
  );
}

export function ElicitationPanel({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation("chat");
  const titleId = useId();
  const statusId = useId();
  const panelRef = useRef<HTMLFormElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const previousPendingIdRef = useRef<string | null>(null);
  const [detachedSubmission, setDetachedSubmission] = useState<
    "idle" | "sending" | "retryable-error" | "indeterminate"
  >("idle");
  const pending = useElicitationStore((state) =>
    presentedElicitation(state.pendingBySessionId[sessionId]),
  );
  const displayedSubmission =
    pending?.deliveryClaim?.phase === "indeterminate"
      ? "indeterminate"
      : detachedSubmission;
  const setValue = useElicitationStore((state) => state.setValue);
  const setStep = useElicitationStore((state) => state.setStep);
  const accept = useElicitationStore((state) => state.accept);
  const decline = useElicitationStore((state) => state.decline);
  const cancel = useElicitationStore((state) => state.cancel);
  const pendingId = pending?.id ?? null;
  const attached = pending?.resolve != null;
  const pendingResponderKey =
    pendingId === null
      ? null
      : `${pendingId}:${attached ? "attached" : "detached"}`;

  useEffect(() => {
    const current = pendingId
      ? useElicitationStore
          .getState()
          .pendingBySessionId[sessionId]?.find(
            (candidate) => candidate.id === pendingId,
          )
      : null;
    if (pendingResponderKey !== null && !current?.deliveryClaim) {
      setDetachedSubmission("idle");
    }
  }, [pendingId, pendingResponderKey, sessionId]);

  // Capture where focus was when a question first appears, rather than keeping
  // a document-wide listener alive for every mounted chat view.
  if (
    pendingId !== null &&
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
  const multipleQuestions = fields.length > 1;
  const bridgeBoilerplate =
    multipleQuestions &&
    BRIDGE_BOILERPLATE_MESSAGES.has(pending.request.message.trim());
  const controlScope = `elicitation:${pending.id}`;

  const sendDetachedAnswers = async () => {
    if (attached || hasIncompleteRequiredField) return;
    const store = useElicitationStore.getState();
    const latestPending = store.pendingBySessionId[sessionId]?.find(
      (candidate) => candidate.id === pending.id,
    );
    if (!latestPending) return;
    // Take the claim before any network work. Without it a responder can
    // reattach, or the user can discard, while the message is in flight, and
    // the question ends up answered twice or not at all.
    const token = store.claimDetachedDelivery(sessionId, latestPending.id);
    if (!token) return;
    setDetachedSubmission("sending");
    try {
      await continueRecoveredElicitation(
        latestPending.request,
        acceptedElicitationResponse(latestPending),
        {
          beforePromptDispatch: () => {
            const ownsDelivery = useElicitationStore
              .getState()
              .beginDetachedDelivery(sessionId, latestPending.id, token);
            if (!ownsDelivery) throw new DetachedDeliveryOwnershipLostError();
          },
        },
      );
      useElicitationStore
        .getState()
        .completeDetachedDelivery(sessionId, latestPending.id, token);
    } catch (error) {
      if (error instanceof DetachedDeliveryOwnershipLostError) return;
      console.error("Failed to send detached elicitation answers:", error);
      const disposition = useElicitationStore
        .getState()
        .failDetachedDelivery(sessionId, latestPending.id, token);
      setDetachedSubmission(
        disposition === "indeterminate" ? "indeterminate" : "retryable-error",
      );
    }
  };

  const submitCurrentStep = () => {
    if (incomplete) return;
    if (!last && fields.length > 0) {
      setStep(sessionId, pending.id, step + 1);
      return;
    }
    if (hasIncompleteRequiredField) return;
    if (attached) accept(sessionId, pending.id);
    else void sendDetachedAnswers();
  };

  return (
    <form
      ref={panelRef}
      tabIndex={-1}
      autoComplete="off"
      noValidate
      aria-labelledby={titleId}
      aria-describedby={statusId}
      data-testid="elicitation-panel"
      data-elicitation-id={pending.id}
      onSubmit={(event) => {
        event.preventDefault();
        submitCurrentStep();
      }}
      className="max-h-[min(65vh,36rem)] overflow-y-auto rounded-lg border border-border bg-card p-4 shadow-[var(--shadow-chat)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          {multipleQuestions ? (
            <p
              id={bridgeBoilerplate ? titleId : undefined}
              className="font-medium text-muted-foreground text-xs uppercase tracking-wide"
            >
              {t("elicitation.questionProgress", {
                current: step + 1,
                total: fields.length,
              })}
            </p>
          ) : null}
          {bridgeBoilerplate ? null : (
            // The question keeps a heading in both modes; in multi-question
            // mode it is a preamble above the step, so it is styled down
            // rather than demoted out of the heading structure.
            <h2
              id={titleId}
              className={cn(
                multipleQuestions
                  ? "mt-1 font-normal text-muted-foreground text-sm"
                  : "font-display font-semibold text-base",
              )}
            >
              {pending.request.message}
            </h2>
          )}
          <div
            id={statusId}
            className="mt-1 space-y-1 text-muted-foreground text-xs"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {fields.length === 0 ? (
              <p>{t("elicitation.reviewAndSubmit")}</p>
            ) : null}
            {pending.recovered ? (
              <p>
                {pending.continuation === "prompt"
                  ? t("elicitation.continuesAfterRestart")
                  : t("elicitation.reconnected")}
              </p>
            ) : null}
            {multipleQuestions && name ? (
              <p className="sr-only">
                {t("elicitation.questionProgress", {
                  current: step + 1,
                  total: fields.length,
                })}
                {schema?.title ? `. ${schema.title}` : null}
              </p>
            ) : null}
            {!attached ? <p>{t("elicitation.detachedDescription")}</p> : null}
          </div>
          {displayedSubmission === "retryable-error" ||
          displayedSubmission === "indeterminate" ? (
            <p className="mt-1 text-destructive text-xs" role="alert">
              {t(
                displayedSubmission === "indeterminate"
                  ? "elicitation.sendAsMessageIndeterminate"
                  : "elicitation.sendAsMessageError",
              )}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          flush
          onClick={() => cancel(sessionId, pending.id)}
          disabled={
            displayedSubmission === "sending" ||
            displayedSubmission === "indeterminate"
          }
          className="shrink-0"
        >
          {t(attached ? "elicitation.cancel" : "elicitation.discard")}
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
                onClick={() => setStep(sessionId, pending.id, index)}
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
          promoteDescription={multipleQuestions}
          onChange={(key, next) => setValue(sessionId, pending.id, key, next)}
        />
      ) : null}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-border border-t pt-3">
        <div className="flex min-h-9 items-center gap-4">
          {step > 0 ? (
            <Button
              type="button"
              variant="ghost"
              flush
              onClick={() => setStep(sessionId, pending.id, step - 1)}
            >
              {t("elicitation.back")}
            </Button>
          ) : null}
          {attached ? (
            <Button
              type="button"
              variant="ghost"
              flush
              onClick={() => decline(sessionId, pending.id)}
            >
              {t("elicitation.decline")}
            </Button>
          ) : null}
        </div>
        <Button
          type="submit"
          disabled={
            Boolean(incomplete) ||
            displayedSubmission === "sending" ||
            displayedSubmission === "indeterminate" ||
            ((last || fields.length === 0) && hasIncompleteRequiredField)
          }
        >
          {last || fields.length === 0
            ? attached
              ? t("elicitation.submit")
              : displayedSubmission === "sending"
                ? t("elicitation.sendingAsMessage")
                : t("elicitation.sendAsMessage")
            : t("elicitation.next")}
        </Button>
      </div>
    </form>
  );
}
