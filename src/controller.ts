// The extension's state machine. It decides when to probe agent-mail, what
// the light shows, and when to wake the agent; every effect (processes,
// timers, Pi) goes through Deps, so it runs the same under test as in Pi.
//
// Modes: off (before start), inactive (nothing to do: another Pi mode, no
// mailbox name, no agent-mail), error (agent-mail answered with a failure;
// probed again on the timer), full (agent-mail 2.3+: JSON status), legacy
// (agent-mail 2.2: doorbell lines only).

import { cleanText, parseRingLine, parseStatus, type MailStatus, type Ring, type StatusResult } from "./contract.ts";
import type { DoorbellHandle, RunResult } from "./process.ts";
import { type Flags, renderDetails, renderStatus, type Theme, type View, wakeText } from "./render.ts";
import { type AgentMailOp, classifyCall, receiveHint } from "./tools.ts";

export interface WakeDetails {
  name: string;
  direct: number;
  channel: number;
  digest: string;
}

/** What one runtime hands the next in the same Pi process (after /new, /resume, /fork, /reload). */
export interface Carry {
  deferred: boolean;
  wakeOn: boolean;
  lastWakeAt: number;
  /** The bound name; in legacy mode the only way the next runtime knows it before a ring. */
  name: string | null;
}

/** Per-process record: which instance is active, and what the last one handed over. */
export interface ProcessSlot {
  owner: object | null;
  carry: Carry | null;
}

export interface Deps {
  slot: ProcessSlot;
  run(args: readonly string[]): Promise<RunResult>;
  startDoorbell(onLine: (line: string) => void, onExit: (code: number | null, signal: string | null) => void): DoorbellHandle;
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  isIdle(): boolean;
  /** Whether agent-mail's environment holds any source of a session name. */
  hasNameSource(): boolean;
  toolNames(): readonly string[];
  sendWake(text: string, details: WakeDetails): void;
  setStatus(text: string | undefined): void;
  theme(): Theme;
}

export interface Config {
  wake: boolean;
  refreshMs: number;
  cooldownMs: number;
}

type Mode = "off" | "inactive" | "error" | "full" | "legacy";

export const USAGE = "usage: /mail [check | pause | resume | restart]";
const LOG_HINT = "see ~/.local/state/agent-mail/log";
const REFRESHING: ReadonlySet<AgentMailOp> = new Set(["receive", "reread", "subscribe", "unsubscribe", "send"]);
const MAX_TRACKED_CALLS = 64;

function describeFailure(result: RunResult, parsed: StatusResult | null): string {
  if (result.spawnError) return `agent-mail could not run (${cleanText(result.spawnError, 80)})`;
  if (result.timedOut) return "agent-mail did not answer within 10 s";
  if (result.truncated) return "agent-mail's answer was too long";
  if (parsed?.kind === "error") return `${parsed.error.replace(/_/g, " ")}: ${parsed.problem}`;
  if (parsed?.kind === "invalid") return `agent-mail's answer was not understood (${parsed.reason})`;
  return `agent-mail exited ${result.code ?? result.signal ?? "oddly"}`;
}

export class Controller {
  private mode: Mode = "off";
  private allowed = false;
  private stopped = false;
  private reason = "not started";
  private problem: string | null = null;
  private name: string | null = null;
  private status: MailStatus | null = null;
  private ring: Ring | null = null;
  private stale = false;
  private lastFailure: string | null = null;
  private bell: DoorbellHandle | null = null;
  private bellGen = 0;
  private bellState = "not started";
  private wakeOn: boolean;
  private deferred = false;
  private owed = false;
  private carriedName: string | null = null;
  private lastWakeAt = Number.NEGATIVE_INFINITY;
  private cooldownTimer: unknown = null;
  private interval: unknown = null;
  private inflight: Promise<void> | null = null;
  private rerun = false;
  private rechecking = false;
  private readonly calls = new Map<string, AgentMailOp>();

  constructor(
    private readonly deps: Deps,
    private readonly config: Config,
  ) {
    this.wakeOn = config.wake;
  }

  /** Begin, in Pi's MODE: only tui and rpc sessions do anything. */
  async start(mode: string): Promise<void> {
    if (this.stopped || this.mode !== "off") return;
    if (mode !== "tui" && mode !== "rpc") {
      this.mode = "inactive";
      this.reason = `Pi's ${mode} mode`;
      return;
    }
    const slot = this.deps.slot;
    if (slot.owner !== null && slot.owner !== this) {
      this.mode = "inactive";
      this.reason = "another session in this Pi process watches agent-mail";
      return;
    }
    slot.owner = this;
    if (slot.carry) {
      this.wakeOn = slot.carry.wakeOn;
      this.lastWakeAt = slot.carry.lastWakeAt;
      this.owed = slot.carry.deferred;
      this.carriedName = slot.carry.name;
      slot.carry = null;
    }
    this.allowed = true;
    try {
      await this.probe();
    } catch (error) {
      if (!this.stopped) this.becomeError("internal error", cleanText(String(error), 160));
    }
  }

  /** End everything this controller started; every later callback is a no-op. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.deps.slot.owner === this) {
      this.deps.slot.owner = null;
      this.deps.slot.carry = {
        deferred: this.deferred || this.owed,
        wakeOn: this.wakeOn,
        lastWakeAt: this.lastWakeAt,
        name: this.name ?? this.carriedName,
      };
    }
    this.bellGen++;
    this.bell?.stop();
    this.bell = null;
    this.clearInterval();
    if (this.cooldownTimer !== null) this.deps.clearTimeout(this.cooldownTimer);
    this.cooldownTimer = null;
    if (this.allowed) this.deps.setStatus(undefined);
  }

  view(): View {
    const flags: Flags = { wakeOff: !this.wakeOn, doorbellStopped: this.bellState.startsWith("stopped"), stale: this.stale };
    switch (this.mode) {
      case "full":
        return { mode: "full", status: this.status as MailStatus, flags };
      case "legacy":
        return { mode: "legacy", name: this.name, ring: this.ring, flags };
      case "error":
        return { mode: "error", reason: this.reason, name: this.name };
      default:
        return { mode: "inactive", reason: this.reason };
    }
  }

  // ---- failures ----

  /** Record an unexpected failure: the light goes stale and /mail says what happened. */
  private fail(error: unknown): void {
    if (this.stopped) return;
    this.stale = true;
    this.lastFailure = `internal error: ${cleanText(String(error), 160)}`;
    this.render();
  }

  /** Run P in the background; whatever it throws stays here, never an unhandled rejection in Pi. */
  private background(p: Promise<unknown>): void {
    p.catch((error) => this.fail(error));
  }

  // ---- probing ----

  /** Refresh the light; never rejects. */
  private refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inflight) {
      this.rerun = true;
      return this.inflight;
    }
    this.inflight = (async () => {
      try {
        do {
          this.rerun = false;
          try {
            await this.refreshOnce();
          } catch (error) {
            this.fail(error);
          }
        } while (this.rerun && !this.stopped);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  private async refreshOnce(): Promise<void> {
    if (this.mode === "full") return this.refreshFull();
    if (this.mode === "legacy") return this.refreshLegacy();
    if (this.mode === "error") return this.probe();
  }

  /**
   * The first probe, without a name, and the retries while in error. Only a first probe that
   * cannot start agent-mail at all means it is not installed; while retrying, a failed start
   * (a link replaced by a switch, no file descriptors) is one more failure to retry.
   */
  private async probe(): Promise<void> {
    const first = this.mode === "off" || this.mode === "inactive";
    const result = await this.deps.run(["pending", "--format", "json"]);
    if (this.stopped) return;
    if (result.spawnError) {
      const why = describeFailure(result, null);
      return first ? this.becomeInactive(why) : this.becomeError("agent-mail could not run", why);
    }
    const parsed = result.timedOut || result.truncated ? null : parseStatus(result.stdout);
    if (parsed?.kind === "ok" && result.code === 0) return this.becomeFull(parsed.status);
    if (parsed?.kind === "error" && parsed.error === "no_identity") return this.becomeInactive("no mailbox name for this session");
    if (parsed?.kind === "error") {
      this.name = parsed.name;
      return this.becomeError(parsed.error.replace(/_/g, " "), parsed.problem);
    }
    if (result.code === 2 && result.stdout.trim() === "") {
      // agent-mail 2.2 cannot say whether this session has a name; the doorbell would fail on
      // none, so a session without any name source stays silent, as it does on 2.3.
      if (!this.deps.hasNameSource()) return this.becomeInactive("no mailbox name for this session");
      return this.becomeLegacy();
    }
    return this.becomeError("no usable answer", describeFailure(result, parsed));
  }

  private async refreshFull(): Promise<void> {
    const result = await this.deps.run(["pending", this.name as string, "--format", "json"]);
    if (this.stopped) return;
    const parsed = result.spawnError || result.timedOut || result.truncated ? null : parseStatus(result.stdout);
    if (parsed?.kind === "ok" && result.code === 0 && parsed.status.name === this.name) {
      this.status = parsed.status;
      this.stale = false;
      this.lastFailure = null;
    } else {
      this.stale = true;
      this.lastFailure = describeFailure(result, parsed);
    }
    this.render();
  }

  private async refreshLegacy(): Promise<void> {
    if (this.name !== null) {
      const ring = await this.contextRing();
      if (this.stopped) return;
      if (ring === "failed") this.stale = true;
      else {
        this.ring = ring;
        this.stale = false;
      }
    }
    this.render();
  }

  /** What rings for the bound name now: a ring, null for nothing, or "failed". */
  private async contextRing(): Promise<Ring | null | "failed"> {
    const result = await this.deps.run(["pending", this.name as string, "--format", "context"]);
    if (result.spawnError || result.timedOut || result.truncated || result.code !== 0) return "failed";
    const text = result.stdout.replace(/\r?\n$/, "");
    if (text === "") return null;
    const ring = parseRingLine(text);
    return ring && ring.name === this.name ? ring : "failed";
  }

  // ---- mode changes ----

  private becomeFull(status: MailStatus): void {
    const first = this.mode !== "full";
    this.mode = "full";
    this.name = status.name;
    this.status = status;
    this.stale = false;
    this.problem = null;
    if (first) this.startBell();
    this.takeOwed();
    this.ensureInterval();
    this.render();
  }

  private becomeLegacy(): void {
    this.mode = "legacy";
    this.problem = null;
    if (this.name === null) this.name = this.carriedName;
    this.carriedName = null;
    this.startBell();
    this.takeOwed();
    this.ensureInterval();
    this.render();
  }

  /** A wake the previous runtime still owed is checked at the first tick, never at once. */
  private takeOwed(): void {
    if (!this.owed) return;
    this.owed = false;
    this.deferred = true;
  }

  private becomeError(reason: string, problem: string): void {
    this.mode = "error";
    this.reason = reason;
    this.problem = problem;
    this.ensureInterval();
    this.render();
  }

  private becomeInactive(reason: string): void {
    this.mode = "inactive";
    this.reason = reason;
    this.clearInterval();
    this.render();
  }

  private ensureInterval(): void {
    if (this.interval === null) this.interval = this.deps.setInterval(() => this.background(this.tick()), this.config.refreshMs);
  }

  /** The refresh timer: the light, then any deferred wake while Pi is idle. */
  private async tick(): Promise<void> {
    await this.refresh();
    if (!this.stopped && this.deferred && this.deps.isIdle()) await this.recheck();
  }

  private clearInterval(): void {
    if (this.interval !== null) this.deps.clearInterval(this.interval);
    this.interval = null;
  }

  private render(): void {
    if (!this.stopped) this.deps.setStatus(renderStatus(this.view(), this.deps.theme()));
  }

  // ---- the doorbell ----

  private startBell(): void {
    if (this.stopped || this.bell) return;
    const gen = ++this.bellGen;
    this.bellState = "running";
    this.bell = this.deps.startDoorbell(
      (line) => {
        if (gen === this.bellGen) this.onDoorbellLine(line);
      },
      (code, signal) => {
        if (gen === this.bellGen) this.onDoorbellExit(code, signal);
      },
    );
  }

  private onDoorbellExit(code: number | null, signal: string | null): void {
    if (this.stopped) return;
    this.bell = null;
    this.bellGen++;
    const how = code !== null ? `exit ${code}` : `signal ${signal ?? "unknown"}`;
    this.bellState = `stopped (${how}; ${LOG_HINT})`;
    this.render();
  }

  /** One stdout line from the doorbell. */
  onDoorbellLine(line: string): void {
    if (this.stopped || (this.mode !== "full" && this.mode !== "legacy")) return;
    const ring = parseRingLine(line);
    if (!ring) return;
    if (this.mode === "legacy") {
      if (this.name === null) this.name = ring.name;
      if (ring.name !== this.name) return;
      this.ring = ring;
      this.render();
    } else if (ring.name !== this.name) {
      return;
    }
    this.background(this.refresh());
    this.considerWake(ring);
  }

  // ---- waking ----

  private cooldownLeft(): number {
    return this.lastWakeAt + this.config.cooldownMs - this.deps.now();
  }

  private considerWake(ring: Ring): void {
    if (!this.wakeOn) return;
    const wait = this.cooldownLeft();
    if (wait <= 0 && this.deps.isIdle()) {
      this.wake(ring);
      return;
    }
    this.deferred = true;
    if (wait > 0) this.armCooldown(wait);
  }

  private armCooldown(ms: number): void {
    if (this.cooldownTimer !== null) return;
    this.cooldownTimer = this.deps.setTimeout(() => {
      this.cooldownTimer = null;
      if (!this.stopped && this.deferred && this.deps.isIdle()) this.background(this.recheck());
    }, ms);
  }

  /** Send the notice. A failure leaves the wake deferred, to be tried again at the next check. */
  private wake(ring: Ring): boolean {
    try {
      const hint = receiveHint(this.deps.toolNames());
      this.deps.sendWake(wakeText(ring.name, ring.direct, ring.channel, hint), {
        name: ring.name,
        direct: ring.direct,
        channel: ring.channel,
        digest: ring.digest,
      });
    } catch (error) {
      this.deferred = true;
      this.fail(error);
      return false;
    }
    this.deferred = false;
    this.lastWakeAt = this.deps.now();
    return true;
  }

  /** A deferred wake, once Pi is idle: wake only if mail still rings. */
  private async recheck(): Promise<void> {
    if (this.stopped || !this.deferred || !this.wakeOn || this.name === null || this.rechecking) return;
    if (this.mode !== "full" && this.mode !== "legacy") return;
    const wait = this.cooldownLeft();
    if (wait > 0) {
      this.armCooldown(wait);
      return;
    }
    this.rechecking = true;
    try {
      const ring = await this.contextRing();
      if (this.stopped || ring === "failed") return;
      if (ring === null) {
        this.deferred = false;
        return;
      }
      if (this.deferred && this.wakeOn && this.deps.isIdle()) this.wake(ring);
    } finally {
      this.rechecking = false;
    }
  }

  /**
   * Pi has settled: refresh the light, and wake if a deferred ring still rings.
   * After an abort (Escape) John gets his turn first: nothing is checked until the next tick.
   */
  async onSettled(aborted = false): Promise<void> {
    if (this.stopped || (this.mode !== "full" && this.mode !== "legacy")) return;
    if (aborted && this.cooldownTimer !== null) {
      this.deps.clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    this.background(this.refresh());
    if (this.deferred && !aborted) {
      try {
        await this.recheck();
      } catch (error) {
        this.fail(error);
      }
    }
  }

  // ---- the agent's own agent-mail calls ----

  onToolStart(id: string, toolName: string, args: unknown): void {
    if (this.stopped) return;
    const op = classifyCall(toolName, args);
    if (op === null) return;
    if (this.calls.size >= MAX_TRACKED_CALLS) this.calls.delete(this.calls.keys().next().value as string);
    this.calls.set(id, op);
  }

  /**
   * A finished call: the light refreshes after anything that changes what waits. A receive
   * never cancels a deferred wake by itself; the settle-time check asks agent-mail whether
   * mail still rings, so a failed or partial receive still leads to a wake.
   */
  onToolEnd(id: string, toolName: string): void {
    if (this.stopped) return;
    const op = this.calls.get(id) ?? classifyCall(toolName, undefined);
    this.calls.delete(id);
    if (op === null || (this.mode !== "full" && this.mode !== "legacy")) return;
    if (REFRESHING.has(op)) this.background(this.refresh());
  }

  // ---- /mail ----

  private wakeState(): string {
    if (!this.wakeOn) return this.config.wake ? "paused (/mail resume)" : "off (PI_AGENT_MAIL_WAKE=0; /mail resume)";
    return this.deferred ? "on (one waits for Pi to settle)" : "on";
  }

  private details(): string {
    const lines = [renderDetails(this.view(), this.bellState, this.wakeState())];
    if (this.mode === "error" && this.problem) lines.push(`agent-mail says: ${this.problem}`);
    if (this.stale && this.lastFailure) lines.push(`the last refresh failed: ${this.lastFailure}`);
    return lines.join("\n");
  }

  /** One /mail command; never rejects. */
  async command(args: string): Promise<string> {
    try {
      return await this.commandOnce(args);
    } catch (error) {
      this.fail(error);
      return `agent-mail: /mail failed: ${cleanText(String(error), 160)}`;
    }
  }

  private async commandOnce(args: string): Promise<string> {
    if (this.stopped) return "agent-mail: stopped";
    switch (args.trim().toLowerCase()) {
      case "":
      case "status":
        await this.refresh();
        return this.details();
      case "check":
        return this.check();
      case "pause":
        this.wakeOn = false;
        this.deferred = false;
        if (this.cooldownTimer !== null) this.deps.clearTimeout(this.cooldownTimer);
        this.cooldownTimer = null;
        this.render();
        return "agent-mail: automatic wakes paused; /mail resume turns them back on";
      case "resume":
        this.wakeOn = true;
        this.render();
        if (this.name !== null && (this.mode === "full" || this.mode === "legacy")) {
          this.deferred = true;
          await this.recheck();
        }
        return "agent-mail: automatic wakes on";
      case "restart":
        return this.restart();
      default:
        return USAGE;
    }
  }

  private async check(): Promise<string> {
    if (this.mode === "inactive" && this.allowed) await this.probe();
    else await this.refresh();
    if (this.stopped) return "agent-mail: stopped";
    if ((this.mode !== "full" && this.mode !== "legacy") || this.name === null) return this.details();
    const ring = await this.contextRing();
    if (this.stopped) return "agent-mail: stopped";
    if (ring === "failed") return `agent-mail: the check failed\n${this.details()}`;
    if (ring === null) return `agent-mail: nothing rings now\n${this.details()}`;
    if (!this.deps.isIdle()) {
      this.deferred = true;
      return "agent-mail: mail waits; Pi is busy, so the agent is woken when it settles";
    }
    if (!this.wake(ring)) return `agent-mail: mail waits, but the wake failed\n${this.details()}`;
    return `agent-mail: woke the agent (${ring.direct} direct, ${ring.channel} channel waiting)`;
  }

  private async restart(): Promise<string> {
    if (this.mode === "full" || this.mode === "legacy") {
      if (this.bell) return "agent-mail: the doorbell is already running";
      this.startBell();
      this.render();
      return "agent-mail: doorbell started";
    }
    if (this.allowed) await this.probe();
    return this.details();
  }
}
