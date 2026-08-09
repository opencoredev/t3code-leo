import type { ProviderUserInputAnswers, UserInputQuestion } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";

export type PiFormElicitationResult =
  | { readonly ok: true; readonly questions: ReadonlyArray<UserInputQuestion> }
  | { readonly ok: false; readonly detail: string };

function propertyOptions(
  property: EffectAcpSchema.ElicitationPropertySchema,
): { readonly labels: ReadonlyArray<string>; readonly multiSelect: boolean } | undefined {
  if (property.type === "boolean") {
    return { labels: ["true", "false"], multiSelect: false };
  }
  if (property.type === "string") {
    const labels =
      property.oneOf?.map((option) => option.title?.trim() || option.const) ?? property.enum;
    return labels && labels.length > 0 ? { labels, multiSelect: false } : undefined;
  }
  if (property.type === "array") {
    const labels =
      "anyOf" in property.items
        ? property.items.anyOf.map((option) => option.title?.trim() || option.const)
        : property.items.enum;
    return labels.length > 0 ? { labels, multiSelect: true } : undefined;
  }
  return undefined;
}

export function buildPiFormElicitationQuestions(
  request: EffectAcpSchema.ElicitationRequest,
): PiFormElicitationResult {
  if (request.mode === "url") {
    return {
      ok: false,
      detail: `Pi requested URL elicitation (${request.url}), which T3 Code does not support.`,
    };
  }

  const properties = Object.entries(request.requestedSchema.properties ?? {});
  if (properties.length === 0) {
    return { ok: false, detail: "Pi requested an empty elicitation form." };
  }

  const questions: Array<UserInputQuestion> = [];
  for (const [id, property] of properties) {
    const options = propertyOptions(property);
    if (!options) {
      return {
        ok: false,
        detail: `Pi requested unsupported arbitrary elicitation field '${id}' (${property.type}). T3 Code supports choice and boolean form fields only.`,
      };
    }
    const header = property.title?.trim() || request.requestedSchema.title?.trim() || id;
    const question = property.description?.trim() || request.message.trim() || header;
    questions.push({
      id,
      header,
      question,
      options: options.labels.map((label) => ({ label, description: label })),
      multiSelect: options.multiSelect,
    });
  }
  return { ok: true, questions };
}

export function buildPiFormElicitationContent(
  request: Extract<EffectAcpSchema.ElicitationRequest, { readonly mode: "form" }>,
  answers: ProviderUserInputAnswers,
): Record<string, EffectAcpSchema.ElicitationContentValue> {
  const content: Record<string, EffectAcpSchema.ElicitationContentValue> = {};
  for (const [id, property] of Object.entries(request.requestedSchema.properties ?? {})) {
    const answer = answers[id];
    if (answer === undefined || answer === null) continue;
    if (property.type === "boolean") {
      if (typeof answer === "boolean") content[id] = answer;
      else if (String(answer).toLowerCase() === "true") content[id] = true;
      else if (String(answer).toLowerCase() === "false") content[id] = false;
      continue;
    }
    if (property.type === "array") {
      const selected = Array.isArray(answer) ? answer.map(String) : [String(answer)];
      const items = property.items;
      content[id] =
        "anyOf" in items
          ? selected.map(
              (label) =>
                items.anyOf.find((option) => (option.title?.trim() || option.const) === label)
                  ?.const ?? label,
            )
          : selected;
      continue;
    }
    if (property.type === "string") {
      const selected = String(answer);
      content[id] =
        property.oneOf?.find((option) => (option.title?.trim() || option.const) === selected)
          ?.const ?? selected;
    }
  }
  return content;
}
