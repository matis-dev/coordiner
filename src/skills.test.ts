import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { commonEfforts, modelOptions, mskillsPresent, palette } from "./skills.ts";
import { REQUIRED_COMMANDS } from "./session.ts";

describe("mskillsPresent", () => {
  it("is true only when every command the templates use is there", () => {
    assert.equal(mskillsPresent([...REQUIRED_COMMANDS, "other"]), true);
    assert.equal(mskillsPresent(REQUIRED_COMMANDS.slice(1)), false);
    assert.equal(mskillsPresent([]), false);
  });
});

describe("palette", () => {
  it("lists m-skills first, then the rest, each alphabetically and once", () => {
    assert.deepEqual(palette(["zeta", "m-skills:rolling-history", "acme:lint", "m-skills:planning-architect", "zeta"]), [
      { skill: "m-skills:planning-architect", label: "Plan", mskills: true },
      { skill: "m-skills:rolling-history", label: "History", mskills: true },
      { skill: "acme:lint", label: "lint", mskills: false },
      { skill: "zeta", label: "zeta", mskills: false },
    ]);
  });

  it("is empty when nothing was discovered", () => assert.deepEqual(palette([]), []));
});

describe("modelOptions", () => {
  const info = (value: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ value, displayName: value, description: "", ...extra });

  it("offers each model once, by the id the session resolves it to, with the efforts it takes in a fixed order", () => {
    const listed = [
      info("opus", { resolvedModel: "claude-opus-5-5", displayName: "Opus", supportedEffortLevels: ["max", "low"] }),
      info("claude-opus-5-5", { displayName: "Opus 5.5" }),
      info("claude-haiku-5-5", { displayName: "Haiku" }),
    ];
    assert.deepEqual(modelOptions(listed), [
      { id: "claude-opus-5-5", label: "Opus", efforts: ["low", "max"] },
      { id: "claude-haiku-5-5", label: "Haiku", efforts: [] },
    ]);
  });

  it("offers no effort for a model that says it has none, whatever levels it lists", () => {
    assert.deepEqual(modelOptions([info("m", { supportsEffort: false, supportedEffortLevels: ["low"] })])[0]!.efforts, []);
  });

  it("leaves out an id that is not one plain token, and strips control characters from the label", () => {
    assert.deepEqual(modelOptions([info("bad id;rm"), info("m", { displayName: "M\u001b[31m" })]), [{ id: "m", label: "M[31m", efforts: [] }]);
  });

  it("falls back to the id when the label is empty", () => {
    assert.equal(modelOptions([info("m", { displayName: "" })])[0]!.label, "m");
  });
});

describe("commonEfforts", () => {
  const options = [
    { id: "a", label: "A", efforts: ["low", "high", "max"] as const },
    { id: "b", label: "B", efforts: ["low", "high"] as const },
  ].map((o) => ({ ...o, efforts: [...o.efforts] }));

  it("is the efforts every tier model takes", () => assert.deepEqual(commonEfforts(options, ["a", "b", "a"]), ["low", "high"]));
  it("is none when a tier model is not listed", () => assert.deepEqual(commonEfforts(options, ["a", "missing", "b"]), []));
});
