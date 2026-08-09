import { describe, expect, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  buildPiFormElicitationContent,
  buildPiFormElicitationQuestions,
} from "./PiAcpElicitation.ts";

const formRequest = {
  mode: "form",
  sessionId: "session-1",
  message: "Choose deployment settings.",
  requestedSchema: {
    type: "object",
    title: "Deploy",
    properties: {
      region: {
        type: "string",
        title: "Region",
        oneOf: [
          { const: "us-east-1", title: "US East" },
          { const: "eu-west-1", title: "EU West" },
        ],
      },
      dryRun: { type: "boolean", title: "Dry run" },
      targets: {
        type: "array",
        title: "Targets",
        items: {
          anyOf: [
            { const: "web", title: "Web" },
            { const: "mobile", title: "Mobile" },
          ],
        },
      },
    },
  },
} satisfies EffectAcpSchema.ElicitationRequest;

describe("Pi ACP elicitation", () => {
  it("maps representable form fields to T3 user input and restores ACP values", () => {
    const mapped = buildPiFormElicitationQuestions(formRequest);
    expect(mapped.ok).toBe(true);
    if (!mapped.ok) return;
    expect(mapped.questions.map((question) => [question.id, question.multiSelect])).toEqual([
      ["region", false],
      ["dryRun", false],
      ["targets", true],
    ]);
    expect(
      buildPiFormElicitationContent(formRequest, {
        region: "EU West",
        dryRun: "true",
        targets: ["Web", "Mobile"],
      }),
    ).toEqual({
      region: "eu-west-1",
      dryRun: true,
      targets: ["web", "mobile"],
    });
  });

  it("rejects URL and arbitrary form elicitation clearly", () => {
    const url = buildPiFormElicitationQuestions({
      mode: "url",
      sessionId: "session-1",
      elicitationId: "auth-1",
      message: "Sign in",
      url: "https://example.test/login",
    });
    expect(url).toEqual(expect.objectContaining({ ok: false }));
    if (!url.ok) expect(url.detail).toContain("URL elicitation");

    const arbitrary = buildPiFormElicitationQuestions({
      mode: "form",
      sessionId: "session-1",
      message: "Enter a name",
      requestedSchema: {
        properties: { name: { type: "string" } },
      },
    });
    expect(arbitrary).toEqual(expect.objectContaining({ ok: false }));
    if (!arbitrary.ok) expect(arbitrary.detail).toContain("unsupported arbitrary elicitation");
  });
});
