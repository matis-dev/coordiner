import type { HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";

// Ported from m-skills scripts/guard-mutations.sh and guard-outward.sh. The whole command string is scanned,
// so `&&`, `;` and `bash -c "…"` are caught; a command assembled at run time (`g=git; $g commit`) is not.
// A lookbehind rather than a consumed prefix, so `/usr/bin/git` matches without a quadratic scan over long tokens.
const BEFORE = "(?<![A-Za-z0-9_.-])";
const VALUE = `(?:"[^"]*"|'[^']*'|\\S+)`;
// Global options before the subcommand: the ones that take a separate value, then any other flag (-P, --no-pager, --git-dir=x).
const OPTION = `(?:(?:-[cC]|--(?:git-dir|work-tree|namespace|exec-path|config-env|super-prefix))\\s+${VALUE}|-\\S*)`;
const GIT = `${BEFORE}git["']?(?:\\s+${OPTION})*\\s+`;
const HARD = "(add|stage|commit|push|checkout|switch|reset|rebase|cherry-pick|revert|clean|am|mv|rm|merge|pull|fetch|gc|prune|filter-branch|update-ref|symbolic-ref|restore|bisect|apply|notes|replace)";
// Listing forms stay open; only the writing form of each subcommand matches.
const SOFT =
  "(branch\\s+(?:-[dDmMcC](?:\\s|$)|--(?:delete|move|copy|set-upstream-to|unset-upstream|edit-description)|[^-\\s])" +
  "|tag\\s+(?:-[adsfD](?:\\s|$)|--(?:delete|force|annotate|sign)|[^-\\s])" +
  "|remote\\s+(?:add|remove|rm|rename|set-url|set-head|prune)" +
  "|worktree\\s+(?:add|remove|move|prune|lock)" +
  "|submodule\\s+(?:add|update|init|deinit|sync|set-url)" +
  "|stash(?:\\s+(?:push|pop|apply|drop|clear|save|create|store)(?:\\s|$)|\\s*$))";

const GIT_HARD = new RegExp(`${GIT}${HARD}(?:[^A-Za-z0-9_-]|$)`);
const GIT_SOFT = new RegExp(`${GIT}${SOFT}`);
const NO_VERIFY = /(?:^|\s)--(?:no-verify|no-gpg-sign)(?:\s|=|$)/;
const GH_WRITE = new RegExp(
  `${BEFORE}gh["']?\\s+(?:` +
    [
      "pr\\s+(?:create|merge|close|reopen|comment|edit|review|ready)",
      "issue\\s+(?:create|close|reopen|comment|edit|transfer|delete|pin)",
      "release\\s+(?:create|edit|delete|upload)",
      "secret\\s+(?:delete|remove|set)",
      "(?:repo|gist)\\s+(?:create|delete|edit|rename|archive)",
      "workflow\\s+(?:run|enable|disable)",
    ].join("|") +
    ")(?:[^A-Za-z0-9_-]|$)" +
    `|${BEFORE}gh["']?\\s+api\\s+.*(?:-X|--method)\\s*(?:POST|PUT|PATCH|DELETE)`,
);

const STAYS_OPEN = "Read-only git stays open: status, diff, log, show, blame, and the listing forms of branch, tag, remote, stash and worktree.";

export function gitWriteDenial(command: string): string | undefined {
  const hard = GIT_HARD.exec(command) ?? GIT_SOFT.exec(command);
  if (hard) return `coordiner: \`git ${hard[1]!.split(/\s/)[0]}\` writes to the repository; commits are the user's to make. ${STAYS_OPEN}`;
  if (NO_VERIFY.test(command)) return "coordiner: skipping hooks with --no-verify or --no-gpg-sign is not allowed.";
  if (GH_WRITE.test(command)) return "coordiner: this `gh` command publishes to GitHub; that is the user's to run. Read-only `gh` (view, list, diff, checks) stays open.";
  return undefined;
}

const deny = (reason: string): HookJSONOutput => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });

// Fails closed: a command the guard cannot read, or an error inside it, is denied.
export const guardHook =
  (log: (line: string) => void): HookCallback =>
  async (input) => {
    try {
      if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return {};
      const command = (input.tool_input as { command?: unknown } | null)?.command;
      if (typeof command !== "string") {
        log("guard denied a Bash call without a readable command");
        return deny("coordiner could not read this command, so it is denied.");
      }
      const reason = gitWriteDenial(command);
      if (reason === undefined) return {};
      log(`guard denied: ${reason}`);
      return deny(reason);
    } catch (error) {
      log(`guard failed and denied the call: ${error instanceof Error ? error.message : String(error)}`);
      return deny("coordiner's guard failed, so the call is denied.");
    }
  };
