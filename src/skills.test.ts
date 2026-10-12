import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mskillsPresent, palette } from "./skills.ts";
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
