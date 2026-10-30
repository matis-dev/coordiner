export type Helper = { file: string; args: string[] };

const inhibit = (command: string[]): string[] => ["--what=sleep", "--who=Coordiner", "--why=A run is working", "--mode=block", ...command];

// ES_CONTINUOUS | ES_SYSTEM_REQUIRED (0x80000001), written in decimal: Windows PowerShell reads the hex literal as a negative
// Int32, which does not convert to the uint the call takes. `Stop` makes a refused Add-Type end the helper instead of leaving it
// waiting while it holds nothing.
const windowsScript = (pid: number): string =>
  [
    "$ErrorActionPreference = 'Stop'",
    `$power = Add-Type -Name Power -Namespace Coordiner -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'`,
    "if ($power::SetThreadExecutionState([uint32]2147483649) -eq 0) { exit 1 }",
    `Wait-Process -Id ${pid}`,
  ].join("; ");

// A process that blocks system sleep, never the display, the screen lock or the lid, for as long as it lives. Each one ends on
// its own when the extension host does, so a crashed editor cannot keep the computer awake. Undefined where there is none.
export function awakeHelper(platform: NodeJS.Platform, pid: number, flatpak: boolean): Helper | undefined {
  switch (platform) {
    case "linux":
      // The host cannot see the sandbox's pids; --watch-bus ends the host's process when this one leaves the session bus.
      return flatpak
        ? { file: "flatpak-spawn", args: ["--host", "--watch-bus", "systemd-inhibit", ...inhibit(["sleep", "infinity"])] }
        : { file: "systemd-inhibit", args: inhibit(["tail", `--pid=${pid}`, "-f", "/dev/null"]) };
    case "darwin":
      return { file: "caffeinate", args: ["-i", "-w", String(pid)] };
    case "win32":
      return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", windowsScript(pid)] };
    default:
      return undefined;
  }
}

// `onExit` hears the helper end, or fail to start, with a few words on how.
export type Spawned = { kill(): void; onExit(listener: (how: string) => void): void };
export type AwakeDeps = { helper: Helper | undefined; start(helper: Helper): Spawned; log(line: string): void };
export type KeepAwake = { set(on: boolean): void; dispose(): void };

// Holds one helper while it is wanted. A helper that ends on its own, or never starts, is not started again until the hold is
// let go and taken once more, so a missing or refused command logs once per hold rather than looping. Never throws: the run
// goes on without the hold.
export function keepAwake({ helper, start, log }: AwakeDeps): KeepAwake {
  let wanted = false;
  let held: Spawned | undefined;
  let unsupported = false;
  const release = () => {
    const spawned = held;
    held = undefined;
    spawned?.kill();
    return spawned !== undefined;
  };
  const take = (helper: Helper) => {
    try {
      const spawned = start(helper);
      held = spawned;
      spawned.onExit((how) => {
        // The exit of a helper let go on purpose is not news.
        if (held !== spawned) return;
        held = undefined;
        log(`Coordiner: the computer can sleep during the run: ${helper.file} ${how}.`);
      });
      log("Coordiner: keeping the computer awake while the run works.");
    } catch (error) {
      log(`Coordiner: the computer can sleep during the run: ${helper.file} did not start: ${error instanceof Error ? error.message : String(error)}.`);
    }
  };
  return {
    set(on) {
      if (on === wanted) return;
      wanted = on;
      if (!on) {
        if (release()) log("Coordiner: the computer can sleep again.");
      } else if (helper) take(helper);
      else if (!unsupported) {
        unsupported = true;
        log("Coordiner: keeping the computer awake is not supported on this system.");
      }
    },
    dispose() {
      wanted = false;
      release();
    },
  };
}
