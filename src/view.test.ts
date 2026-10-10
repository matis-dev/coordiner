import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stepItem, type StepView } from "./view.ts";

const step = (overrides: Partial<StepView> = {}): StepView => ({ label: "Plan", tier: "strong", model: "m-strong", status: "running", ...overrides });

describe("stepItem", () => {
  it("maps each status to its icon", () => {
    const icons = (["running", "done", "failed", "halted", "stopped"] as const).map((status) => stepItem(step({ status })).icon);
    assert.deepEqual(icons, ["loading~spin", "check", "error", "debug-stop", "circle-slash"]);
  });

  it("speaks the status, tier and model in words", () => {
    assert.equal(stepItem(step({ status: "failed" })).accessibleLabel, "Plan, failed, strong, m-strong");
  });

  it("shows tier and model, and the detail when it adds something", () => {
    assert.equal(stepItem(step()).description, "strong · m-strong");
    assert.equal(stepItem(step({ status: "done", detail: "next: Light" })).description, "strong · m-strong · next: Light");
  });

  it("does not repeat a detail that only echoes the status", () => {
    assert.equal(stepItem(step({ status: "done", detail: "done" })).description, "strong · m-strong");
  });

  it("clips a long detail", () => {
    const { description } = stepItem(step({ status: "failed", detail: "x".repeat(300) }));
    assert.equal(description.length, "strong · m-strong · ".length + 121);
  });

  it("strips control characters from every text field", () => {
    const item = stepItem(step({ label: "Pl\u001b[31man", model: "m\u0007x", status: "halted", detail: "re\u001bason" }));
    assert.equal(item.label, "Pl[31man");
    assert.equal(item.description, "strong · mx · re" + "ason");
    assert.equal(item.accessibleLabel, "Pl[31man, halted, strong, mx");
  });
});
