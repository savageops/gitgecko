import type { NativeAgentActivityEvent } from "@gitgecko/review";

type Timer = ReturnType<typeof setInterval>;

export interface CliProgressReporter {
  readonly report: (event: NativeAgentActivityEvent) => void;
  readonly stop: () => void;
}

export interface CliProgressDependencies {
  readonly write?: (text: string) => void;
  readonly now?: () => number;
  readonly setInterval?: (callback: () => void, delayMs: number) => Timer;
  readonly clearInterval?: (timer: Timer) => void;
  readonly heartbeatMs?: number;
  readonly isTTY?: boolean;
}

/** Keep long native reviews visibly alive without contaminating stdout. */
export const createCliProgressReporter = (dependencies: CliProgressDependencies = {}): CliProgressReporter => {
  const write = dependencies.write ?? ((text: string) => process.stderr.write(text));
  const now = dependencies.now ?? Date.now;
  const start = now();
  const isTTY = dependencies.isTTY ?? Boolean(process.stderr.isTTY);
  let current = "Preparing review";
  let stopped = false;
  let renderedWidth = 0;

  const render = (text: string): void => {
    if (!isTTY) { write(`${text}\n`); return; }
    const padding = " ".repeat(Math.max(0, renderedWidth - text.length));
    renderedWidth = text.length;
    write(`\r${text}${padding}`);
  };

  const report = (event: NativeAgentActivityEvent): void => {
    if (stopped) return;
    current = event.message ?? `${event.provider} ${event.phase}`;
    render(`[GitGecko] ${current}`);
  };

  const timer = (dependencies.setInterval ?? setInterval)(() => {
    if (stopped) return;
    const elapsedSeconds = Math.max(1, Math.floor((now() - start) / 1_000));
    render(`[GitGecko] ${current} (${elapsedSeconds}s elapsed)`);
  }, dependencies.heartbeatMs ?? 15_000);
  timer.unref?.();

  return {
    report,
    stop: () => {
      if (stopped) return;
      stopped = true;
      (dependencies.clearInterval ?? clearInterval)(timer);
      if (isTTY && renderedWidth > 0) write("\n");
    },
  };
};
