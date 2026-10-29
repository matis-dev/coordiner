import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lastFirst, parseStories, slugify, storyText, wholeFileStory } from "./backlog.ts";

describe("parseStories", () => {
  it("finds Story N and Slice N headings at any level, case-insensitively", () => {
    const stories = parseStories("# Backlog\n## Story 1: Login\nbody one\n### slice 2: Logout\nbody two\n");
    assert.deepEqual(stories.map((s) => s.heading), ["Story 1: Login", "slice 2: Logout"]);
  });

  it("ends a body at the next heading of the same or a higher level", () => {
    const [first, second] = parseStories("## Story 1\nline a\n### Notes\nline b\n## Story 2\nline c\n# Other\nignored\n");
    assert.equal(first!.body, "line a\n### Notes\nline b");
    assert.equal(second!.body, "line c");
  });

  it("runs the last body to the end of the file", () => {
    assert.deepEqual(parseStories("## Story 1\nonly\n"), [{ heading: "Story 1", body: "only" }]);
  });

  it("returns no stories when none match", () => {
    assert.deepEqual(parseStories("# Notes\nStory 1 is mentioned in prose\n## Epic 2\n"), []);
  });
});

describe("wholeFileStory", () => {
  it("is named by the first heading, and the rest of the file is its body", () => {
    const story = wholeFileStory("<!-- meta -->\n# 01 · Register a company and sign in\nintro\n## Acceptance criteria\n- one\n", "01-register.md");
    assert.deepEqual(story, { heading: "01 · Register a company and sign in", body: "<!-- meta -->\nintro\n## Acceptance criteria\n- one" });
    assert.equal(slugify(story.heading), "01-register-a-company-and-sign-in");
  });

  it("is named by the file when it has no heading", () => {
    assert.deepEqual(wholeFileStory("Add a settings page.\n", "settings.MD"), { heading: "settings", body: "Add a settings page." });
  });
});

describe("slugify", () => {
  it("lowercases and joins words with single dashes", () => {
    assert.equal(slugify("Story 1: Café login!"), "story-1-caf-login");
  });

  it("caps at 60 characters without a trailing dash", () => {
    const slug = slugify(`Story 1 ${"a".repeat(51)}-b`);
    assert.equal(slug.length <= 60, true);
    assert.doesNotMatch(slug, /-$/);
  });

  it("throws when nothing usable is left", () => {
    assert.throws(() => slugify("!!! ???"), /at least one letter or digit/);
  });

  it("turns path and shell syntax into plain dashes", () => {
    assert.equal(slugify("Story 3: ../../etc; rm -rf ~"), "story-3-etc-rm-rf");
  });
});

describe("storyText", () => {
  it("is the heading, a blank line, then the body", () => assert.equal(storyText({ heading: "Story 1: Login", body: "Add a login form." }), "Story 1: Login\n\nAdd a login form."));
});

describe("lastFirst", () => {
  it("moves what was used last to the front and keeps the order of the rest", () => {
    assert.deepEqual(lastFirst(["a.md", "b.md", "c.md"], (p) => p === "c.md"), ["c.md", "a.md", "b.md"]);
  });

  it("leaves the list as it was when nothing matches", () => {
    assert.deepEqual(lastFirst(["a.md", "b.md"], (p) => p === "gone.md"), ["a.md", "b.md"]);
    assert.deepEqual(lastFirst([], () => true), []);
  });
});
