export type Story = { heading: string; body: string };

const STORY_HEADING = /^(#{1,6})\s+((?:Story|Slice)\s+\d+.*)$/i;
const ANY_HEADING = /^(#{1,6})\s/;

// A story runs from its heading to the next heading of the same or a higher level.
export function parseStories(markdown: string): Story[] {
  const lines = markdown.split("\n");
  const stories: Story[] = [];
  for (const [i, line] of lines.entries()) {
    const match = STORY_HEADING.exec(line);
    if (!match) continue;
    const level = match[1]!.length;
    const end = lines.findIndex((next, j) => j > i && (ANY_HEADING.exec(next)?.[1]?.length ?? Infinity) <= level);
    stories.push({ heading: match[2]!.trim(), body: lines.slice(i + 1, end === -1 ? undefined : end).join("\n").trim() });
  }
  return stories;
}

// The slug becomes a branch and a directory name, so it is restricted to [a-z0-9-].
export function slugify(heading: string): string {
  const slug = heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "");
  if (slug === "") throw new Error("The story heading needs at least one letter or digit.");
  return slug;
}
