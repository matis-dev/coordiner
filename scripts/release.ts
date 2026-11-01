import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import * as readline from "node:readline/promises";
import { stdin, stdout, argv, exit } from "node:process";

function run(cmd: string, silent = false): string {
  try {
    return execSync(cmd, { stdio: silent ? "pipe" : "inherit", encoding: "utf8" })?.toString().trim() ?? "";
  } catch (error) {
    if (!silent) console.error(`Failed running: ${cmd}`);
    throw error;
  }
}

function runOutput(cmd: string): string {
  try {
    return execSync(cmd, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

async function main() {
  const args = argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const isYes = args.includes("-y") || args.includes("--yes");
  const skipTests = args.includes("--no-test");
  const bumpArg = args.find((a) => !a.startsWith("-")) || "patch";

  console.log("Coordiner Release Automation\n=============================");

  // 1. Check git branch and working tree
  const currentBranch = runOutput("git rev-parse --abbrev-ref HEAD");
  if (currentBranch !== "main") {
    console.error(`Error: Releases must be cut from 'main' branch (current: ${currentBranch || "unknown"}).`);
    exit(1);
  }

  const uncommitted = runOutput("git status --porcelain");
  if (uncommitted) {
    const uncommittedFiles = uncommitted.split("\n").map((l) => l.slice(3).trim());
    const nonDocs = uncommittedFiles.filter(
      (f) => f !== "CHANGELOG.md" && f !== "README.md" && f !== "package.json" && f !== ".claude/PROJECT-PROFILE.md"
    );
    if (nonDocs.length > 0) {
      if (isDryRun) {
        console.warn("⚠️  Warning (ignored in dry-run): Working tree has uncommitted changes:\n" + uncommitted);
      } else {
        console.error("Error: Working tree has uncommitted code changes:\n" + uncommitted);
        console.error("Please commit or stash your changes before cutting a release.");
        exit(1);
      }
    }
  }

  // 2. Read package.json and determine new version
  const pkgPath = new URL("../package.json", import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string; [key: string]: unknown };
  const currentVersion = pkg.version;
  const [major = 0, minor = 0, patch = 0] = currentVersion.split(".").map(Number);

  let newVersion: string;
  if (bumpArg === "patch") {
    newVersion = `${major}.${minor}.${patch + 1}`;
  } else if (bumpArg === "minor") {
    newVersion = `${major}.${minor + 1}.0`;
  } else if (bumpArg === "major") {
    newVersion = `${major + 1}.0.0`;
  } else if (/^\d+\.\d+\.\d+$/.test(bumpArg)) {
    newVersion = bumpArg;
  } else {
    console.error(`Error: Invalid bump type or version '${bumpArg}'. Expected 'patch', 'minor', 'major', or 'X.Y.Z'.`);
    exit(1);
  }

  const tagName = `v${newVersion}`;

  // Check tag doesn't already exist
  const existingTag = runOutput(`git tag -l ${tagName}`);
  if (existingTag) {
    console.error(`Error: Git tag '${tagName}' already exists.`);
    exit(1);
  }

  console.log(`Current version: ${currentVersion}`);
  console.log(`Target version:  ${newVersion} (${tagName})`);

  // 3. Quality gates (typecheck & test)
  if (!skipTests) {
    console.log("\nRunning typecheck and tests...");
    run("pnpm typecheck");
    run("pnpm test");
  }

  // 4. Check CHANGELOG.md
  const changelogPath = new URL("../CHANGELOG.md", import.meta.url);
  const changelog = readFileSync(changelogPath, "utf8");
  if (!changelog.includes(`· ${newVersion}`)) {
    console.warn(`\n⚠️  Notice: CHANGELOG.md does not yet have an entry mentioning '· ${newVersion}'.`);
  }

  // 5. Preview changes
  console.log("\nPlanned actions:");
  console.log(`  1. Update package.json version to "${newVersion}"`);
  console.log(`  2. Update README.md badges to v${newVersion}`);
  console.log(`  3. Stage: package.json, README.md, CHANGELOG.md`);
  console.log(`  4. Commit: "chore: release ${tagName}"`);
  console.log(`  5. Tag: ${tagName}`);
  console.log(`  6. Push: main and ${tagName} to origin`);

  if (isDryRun) {
    console.log("\n[--dry-run] Exiting without modifying files or git.");
    exit(0);
  }

  if (!isYes) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    const answer = await rl.question(`\nProceed with release ${tagName}? [y/N] `);
    rl.close();
    if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
      console.log("Release cancelled.");
      exit(0);
    }
  }

  // 6. Perform file updates
  pkg.version = newVersion;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

  const readmePath = new URL("../README.md", import.meta.url);
  let readme = readFileSync(readmePath, "utf8");
  readme = readme.replace(
    /(img\.shields\.io\/badge\/VS%20Code%20Marketplace-v)\d+\.\d+\.\d+(-007ACC)/,
    `$1${newVersion}$2`
  );
  readme = readme.replace(
    /(img\.shields\.io\/badge\/Open%20VSX-v)\d+\.\d+\.\d+(-purple)/,
    `$1${newVersion}$2`
  );
  writeFileSync(readmePath, readme);

  // 7. Git commit, tag, and push
  console.log("\nCommitting, tagging, and pushing...");
  run("git add package.json README.md CHANGELOG.md");
  run(`git commit -m "chore: release ${tagName}"`);
  run(`git tag ${tagName}`);
  run("git push origin main");
  run(`git push origin ${tagName}`);

  console.log(`\n🎉 Successfully pushed ${tagName}!`);
  console.log("GitHub Actions release workflow will now build and publish to:");
  console.log("  - VS Code Marketplace (via Trusted Publishing OIDC)");
  console.log("  - Open VSX (via OVSX_PAT)");
}

main().catch((err) => {
  console.error(err);
  exit(1);
});
