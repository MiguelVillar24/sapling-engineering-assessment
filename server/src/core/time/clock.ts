import { DateTime } from 'luxon';
import { ValidationError } from '../errors.js';
import { CLINIC_ZONE } from './calendar.js';

export type ClockMode = 'frozen' | 'running';

export interface ClockState {
  mode: ClockMode;
  /** The scenario "now" at the moment the clock was set (ISO with offset). */
  anchor: string;
  /** Wall-clock ms when the anchor was set; only used in running mode. */
  setAtMs: number;
}

export interface ClockStore {
  getClock(): ClockState | null;
  saveClock(state: ClockState): void;
}

/** Wednesday, November 4, 2026, 10:00 a.m. Pacific — the scenario's "now". */
export const DEFAULT_SCENARIO_NOW = '2026-11-04T10:00:00';

/**
 * The scenario clock. "Now" is a persisted setting rather than the computer's
 * clock so reviewers can move it during the walkthrough. Frozen (default) keeps
 * the script deterministic; running ticks forward from the anchor in real time.
 */
export class ScenarioClock {
  constructor(
    private readonly store: ClockStore,
    private readonly defaultNow: string = process.env.SCENARIO_NOW ?? DEFAULT_SCENARIO_NOW,
    private readonly zone: string = CLINIC_ZONE,
    private readonly wallNow: () => number = Date.now,
  ) {}

  state(): ClockState {
    return (
      this.store.getClock() ?? {
        mode: 'frozen',
        anchor: this.parse(this.defaultNow).toISO()!,
        setAtMs: this.wallNow(),
      }
    );
  }

  now(): DateTime {
    const s = this.state();
    const anchor = DateTime.fromISO(s.anchor, { setZone: true }).setZone(this.zone);
    if (s.mode === 'frozen') return anchor;
    return anchor.plus({ milliseconds: Math.max(0, this.wallNow() - s.setAtMs) });
  }

  /** Accepts an ISO date-time; without an offset it is read as clinic-local time. */
  set(input: { now?: string; mode?: ClockMode }): DateTime {
    const anchor = input.now ? this.parse(input.now) : this.now();
    this.store.saveClock({
      mode: input.mode ?? this.state().mode,
      anchor: anchor.toISO()!,
      setAtMs: this.wallNow(),
    });
    return this.now();
  }

  reset(): DateTime {
    this.store.saveClock({ mode: 'frozen', anchor: this.parse(this.defaultNow).toISO()!, setAtMs: this.wallNow() });
    return this.now();
  }

  private parse(value: string): DateTime {
    const dt = DateTime.fromISO(value, { zone: this.zone });
    if (!dt.isValid) throw new ValidationError(`Invalid scenario date-time: "${value}" (use e.g. 2026-11-04T10:00)`);
    return dt.setZone(this.zone);
  }
}
