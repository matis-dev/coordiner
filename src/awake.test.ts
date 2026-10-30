import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { awakeHelper, keepAwake, type Helper, type Spawned } from "./awake.ts";

describe("awakeHelper", () => {
  const inhibit = ["--what=sleep", "--who=Coordiner", "--why=A run is working", "--mode=block"];

  it("blocks only sleep on Linux, until the extension host ends", () => {
    assert.deepEqual(awakeHelper("linux", 4242, false), { file: "systemd-inhibit", args: [...inhibit, "tail", "--pid=4242", "-f", "/dev/null"] });
  });

  it("runs on the host from the flatpak, ended by the session bus rather than a pid the host cannot see", () => {
    assert.deepEqual(awakeHelper("linux", 4242, true), {
      file: "flatpak-spawn",
      args: ["--host", "--watch-bus", "systemd-inhibit", ...inhibit, "sleep", "infinity"],
    });
  });

  it("blocks idle sleep on macOS until the extension host ends", () => {
    assert.deepEqual(awakeHelper("darwin", 4242, false), { file: "caffeinate", args: ["-i", "-w", "4242"] });
  });

  it("asks Windows for the system, not the display, until the extension host ends, and stops on a refused Add-Type", () => {
    const helper = awakeHelper("win32", 4242, false)!;
    assert.equal(helper.file, "powershell.exe");
    assert.deepEqual(helper.args.slice(0, 3), ["-NoProfile", "-NonInteractive", "-Command"]);
    const script = helper.args[3]!;
    assert.ok(script.startsWith("$ErrorActionPreference = 'Stop'; "));
    assert.match(script, /SetThreadExecutionState\(\[uint32\]2147483649\)/);
    assert.ok(script.endsWith("Wait-Process -Id 4242"));
    assert.equal(helper.args.length, 4);
  });

  it("has none elsewhere", () => {
    assert.equal(awakeHelper("freebsd", 4242, false), undefined);
  });
});

describe("keepAwake", () => {
  const helper: Helper = { file: "systemd-inhibit", args: ["x"] };
  // A fake start: records each helper it starts, and lets the test end one.
  const setup = (over: { helper?: Helper | undefined; fail?: Error } = {}) => {
    const started: Array<{ killed: boolean; exit(how: string): void }> = [];
    const lines: string[] = [];
    const start = (): Spawned => {
      if (over.fail) throw over.fail;
      const listeners: Array<(how: string) => void> = [];
      const one = { killed: false, exit: (how: string) => listeners.forEach((l) => l(how)) };
      started.push(one);
      return { kill: () => void (one.killed = true), onExit: (listener) => void listeners.push(listener) };
    };
    const awake = keepAwake({ helper: "helper" in over ? over.helper : helper, start, log: (line) => lines.push(line) });
    return { awake, started, lines };
  };

  it("starts one helper however often it is asked, and kills it when let go", () => {
    const { awake, started, lines } = setup();
    awake.set(true);
    awake.set(true);
    assert.equal(started.length, 1);
    awake.set(false);
    assert.equal(started[0]!.killed, true);
    assert.deepEqual(lines, ["Coordiner: keeping the computer awake while the run works.", "Coordiner: the computer can sleep again."]);
  });

  it("does nothing when let go while not holding", () => {
    const { awake, started, lines } = setup();
    awake.set(false);
    assert.equal(started.length, 0);
    assert.deepEqual(lines, []);
  });

  it("does not log the exit of a helper it let go", () => {
    const { awake, started, lines } = setup();
    awake.set(true);
    awake.set(false);
    started[0]!.exit("exited (SIGTERM)");
    assert.equal(lines.length, 2);
  });

  it("logs a helper that ends on its own, and starts no other until the hold is let go and taken again", () => {
    const { awake, started, lines } = setup();
    awake.set(true);
    started[0]!.exit("exited (code 1)");
    assert.equal(lines.at(-1), "Coordiner: the computer can sleep during the run: systemd-inhibit exited (code 1).");
    awake.set(true);
    assert.equal(started.length, 1);
    awake.set(false);
    assert.equal(lines.length, 2, "nothing was held, so nothing is released");
    awake.set(true);
    assert.equal(started.length, 2);
  });

  it("logs a helper that cannot start, and does not throw", () => {
    const { awake, lines } = setup({ fail: new Error("spawn systemd-inhibit ENOENT") });
    assert.doesNotThrow(() => awake.set(true));
    assert.deepEqual(lines, ["Coordiner: the computer can sleep during the run: systemd-inhibit did not start: spawn systemd-inhibit ENOENT."]);
    awake.set(false);
    assert.equal(lines.length, 1);
  });

  it("reports a thrown value that is not an Error as written", () => {
    const awake = keepAwake({ helper, start: () => { throw "denied"; }, log: (line) => assert.match(line, /did not start: denied\.$/) });
    awake.set(true);
  });

  it("says once that the system has no helper, and starts nothing", () => {
    const { awake, started, lines } = setup({ helper: undefined });
    awake.set(true);
    awake.set(false);
    awake.set(true);
    assert.equal(started.length, 0);
    assert.deepEqual(lines, ["Coordiner: keeping the computer awake is not supported on this system."]);
  });

  it("kills the helper on dispose, silently, and can be held again after", () => {
    const { awake, started, lines } = setup();
    awake.set(true);
    awake.dispose();
    started[0]!.exit("exited (SIGTERM)");
    assert.equal(started[0]!.killed, true);
    assert.equal(lines.length, 1);
    awake.set(true);
    assert.equal(started.length, 2);
  });
});
