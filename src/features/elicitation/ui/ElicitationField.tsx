import { useId } from "react";
import type { ReactNode } from "react";
import type {
  ElicitationContentValue,
  ElicitationPropertySchema,
} from "@agentclientprotocol/sdk";
import { useTranslation } from "react-i18next";
import { findOtherCompanion } from "@/features/elicitation/stores/elicitationStore";
import { cn } from "@/shared/lib/cn";
import { Checkbox } from "@/shared/ui/checkbox";
import { Input } from "@/shared/ui/input";
import { Label } from "@/shared/ui/label";
import { RadioGroup, RadioGroupItem } from "@/shared/ui/radio-group";

type Option = { value: string; label: string; description?: string };

interface ElicitationFieldProps {
  name: string;
  schema: ElicitationPropertySchema;
  properties: Record<string, ElicitationPropertySchema>;
  content: Record<string, ElicitationContentValue>;
  controlScope: string;
  required: boolean;
  onChange: (key: string, value: ElicitationContentValue | undefined) => void;
}

interface ConcreteFieldProps extends ElicitationFieldProps {
  fieldId: string;
}

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

function OptionCard({
  checked,
  htmlFor,
  children,
  align = "start",
}: {
  checked: boolean;
  htmlFor: string;
  children: ReactNode;
  align?: "start" | "center";
}) {
  return (
    <Label
      htmlFor={htmlFor}
      data-state={checked ? "checked" : "unchecked"}
      className={cn(
        "cursor-pointer rounded-md border border-border p-3 data-[state=checked]:border-primary data-[state=checked]:bg-primary/5",
        align === "center" ? "items-center" : "items-start",
      )}
    >
      {children}
    </Label>
  );
}

function MultiSelectField({
  name,
  schema,
  properties,
  content,
  controlScope,
  onChange,
  fieldId,
}: ConcreteFieldProps) {
  const { t } = useTranslation("chat");
  const raw = schema as Record<string, unknown>;
  const title = typeof raw.title === "string" ? raw.title : name;
  const description =
    typeof raw.description === "string" ? raw.description : null;
  const descriptionId = description ? `${fieldId}-description` : undefined;
  const options = multiSelectOptions(schema);
  const value = content[name];
  const selected = Array.isArray(value) ? value : [];
  const selectedSet = new Set(selected);
  const maxItems = typeof raw.maxItems === "number" ? raw.maxItems : null;
  const limitDescriptionId =
    maxItems != null ? `${fieldId}-limit-description` : undefined;
  const fieldDescriptionIds = [descriptionId, limitDescriptionId]
    .filter(Boolean)
    .join(" ");
  const companion = findOtherCompanion(properties, name);
  const companionName = companion?.[0];
  const companionSchema = companion?.[1] as Record<string, unknown> | undefined;
  const explicitOtherOption = companionName
    ? options.find(isOtherOption)
    : undefined;
  const visibleOptions = explicitOtherOption
    ? options.filter((option) => option !== explicitOtherOption)
    : options;
  const otherValue = companionName ? content[companionName] : undefined;
  const otherDescription =
    explicitOtherOption?.description ??
    (typeof companionSchema?.description === "string"
      ? companionSchema.description
      : undefined);
  const otherDescriptionId = otherDescription
    ? `${fieldId}-other-description`
    : undefined;
  const explicitOtherSelected =
    explicitOtherOption != null && selectedSet.has(explicitOtherOption.value);
  const customOtherSelected =
    companionName != null &&
    typeof otherValue === "string" &&
    value === undefined;
  const otherSelected = explicitOtherSelected || customOtherSelected;
  const visibleSelected = explicitOtherOption
    ? selected.filter((item) => item !== explicitOtherOption.value)
    : selected;
  const visibleSelectedSet = new Set(visibleSelected);
  const controlName = `${controlScope}:${name}`;

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
          const checked = visibleSelectedSet.has(option.value);
          const atLimit =
            maxItems != null && visibleSelected.length >= maxItems;
          const optionId = `${fieldId}-option-${index}`;
          const optionDescriptionId = option.description
            ? `${optionId}-description`
            : undefined;
          return (
            <OptionCard key={option.value} htmlFor={optionId} checked={checked}>
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
                      ? visibleSelected.filter((item) => item !== option.value)
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
            </OptionCard>
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
                aria-describedby={otherDescriptionId}
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
                {otherDescription ? (
                  <span
                    id={otherDescriptionId}
                    className="block text-muted-foreground text-xs"
                  >
                    {otherDescription}
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
                aria-describedby={otherDescriptionId}
                minLength={
                  typeof companionSchema?.minLength === "number"
                    ? companionSchema.minLength
                    : undefined
                }
                maxLength={
                  typeof companionSchema?.maxLength === "number"
                    ? companionSchema.maxLength
                    : undefined
                }
                pattern={
                  typeof companionSchema?.pattern === "string"
                    ? companionSchema.pattern
                    : undefined
                }
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

function SingleSelectField({
  name,
  schema,
  properties,
  content,
  controlScope,
  required,
  onChange,
  fieldId,
}: ConcreteFieldProps) {
  const { t } = useTranslation("chat");
  const raw = schema as Record<string, unknown>;
  const title = typeof raw.title === "string" ? raw.title : name;
  const description =
    typeof raw.description === "string" ? raw.description : null;
  const descriptionId = description ? `${fieldId}-description` : undefined;
  const options = singleSelectOptions(schema);
  const value = content[name];
  const companion = findOtherCompanion(properties, name);
  const companionName = companion?.[0];
  const companionSchema = companion?.[1] as Record<string, unknown> | undefined;
  const otherValue = companionName ? content[companionName] : undefined;
  const explicitOtherOption = companionName
    ? options.find(isOtherOption)
    : undefined;
  const visibleOptions = explicitOtherOption
    ? options.filter((option) => option !== explicitOtherOption)
    : options;
  const otherDescription =
    explicitOtherOption?.description ??
    (typeof companionSchema?.description === "string"
      ? companionSchema.description
      : undefined);
  const otherDescriptionId = otherDescription
    ? `${fieldId}-other-description`
    : undefined;
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
        name={`${controlScope}:${name}`}
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
            <OptionCard key={option.value} htmlFor={optionId} checked={checked}>
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
            </OptionCard>
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
                aria-describedby={otherDescriptionId}
                className="mt-0.5"
              />
              <span className="font-medium text-sm leading-normal">
                {explicitOtherOption?.label ??
                  (typeof companionSchema?.title === "string"
                    ? companionSchema.title
                    : t("elicitation.other"))}
              </span>
            </Label>
            {otherDescription ? (
              <p
                id={otherDescriptionId}
                className="ml-6 text-muted-foreground text-xs"
              >
                {otherDescription}
              </p>
            ) : null}
            {otherSelected ? (
              <Input
                type="text"
                name={`${controlScope}:${companionName}`}
                autoComplete="off"
                autoFocus
                aria-label={t("elicitation.otherAnswerLabel", { title })}
                aria-describedby={otherDescriptionId}
                minLength={
                  typeof companionSchema?.minLength === "number"
                    ? companionSchema.minLength
                    : undefined
                }
                maxLength={
                  typeof companionSchema?.maxLength === "number"
                    ? companionSchema.maxLength
                    : undefined
                }
                pattern={
                  typeof companionSchema?.pattern === "string"
                    ? companionSchema.pattern
                    : undefined
                }
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

function BooleanField({
  name,
  schema,
  content,
  controlScope,
  required,
  onChange,
  fieldId,
}: ConcreteFieldProps) {
  const { t } = useTranslation("chat");
  const raw = schema as Record<string, unknown>;
  const title = typeof raw.title === "string" ? raw.title : name;
  const description =
    typeof raw.description === "string" ? raw.description : null;
  const descriptionId = description ? `${fieldId}-description` : undefined;
  const value = content[name];

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
        name={`${controlScope}:${name}`}
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
            <OptionCard
              key={option.value}
              htmlFor={optionId}
              checked={checked}
              align="center"
            >
              <RadioGroupItem id={optionId} value={option.value} />
              <span className="text-sm leading-normal">{option.label}</span>
            </OptionCard>
          );
        })}
      </RadioGroup>
    </fieldset>
  );
}

function ScalarField({
  name,
  schema,
  content,
  controlScope,
  required,
  onChange,
  fieldId,
}: ConcreteFieldProps) {
  const raw = schema as Record<string, unknown>;
  const title = typeof raw.title === "string" ? raw.title : name;
  const description =
    typeof raw.description === "string" ? raw.description : null;
  const descriptionId = description ? `${fieldId}-description` : undefined;
  const value = content[name];
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
        name={`${controlScope}:${name}`}
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

export function ElicitationField(props: ElicitationFieldProps) {
  const fieldId = useId();
  if (props.schema.type === "array") {
    return <MultiSelectField {...props} fieldId={fieldId} />;
  }
  if (singleSelectOptions(props.schema).length > 0) {
    return <SingleSelectField {...props} fieldId={fieldId} />;
  }
  if (props.schema.type === "boolean") {
    return <BooleanField {...props} fieldId={fieldId} />;
  }
  return <ScalarField {...props} fieldId={fieldId} />;
}
