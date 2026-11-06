import type { DatabaseSync } from 'node:sqlite';
import { PatientAgent } from './agent/agent.js';
import { type Interpreter, RuleBasedInterpreter } from './agent/interpreter.js';
import { loadClinicData } from './clinic-data/load.js';
import type { ClinicData } from './clinic-data/types.js';
import type { AgentRun, Conversation, HandoffRequest, Message, RequestEvent } from './domain.js';
import { MessagingService } from './messaging/messaging-service.js';
import { RequestService } from './requests/request-service.js';
import { openDatabase, wipeDatabase } from './store/db.js';
import { createRepositories, type Repositories } from './store/repositories.js';
import { ScenarioClock } from './time/clock.js';

export interface CoreConfig {
  /** SQLite file path, or ":memory:" for tests and evals. */
  dbPath: string;
  /** Directory with alex_morgan.json, clinic_faq.md and open_slots.json. */
  dataDir: string;
  /** Default scenario "now" (clinic-local ISO). */
  scenarioNow?: string;
  interpreter?: Interpreter;
}

export interface Snapshot {
  exported_at: string;
  scenario_now: string;
  conversations: Conversation[];
  messages: Message[];
  requests: Array<HandoffRequest & { events: RequestEvent[] }>;
  agent_runs: AgentRun[];
}

/**
 * Composition root: wires data, storage, clock, request service and agent.
 * Framework-free so the HTTP app, CLI scripts, tests and evals share one core.
 */
export class Core {
  readonly repos: Repositories;
  readonly clinic: ClinicData;
  readonly clock: ScenarioClock;
  readonly requests: RequestService;
  readonly agent: PatientAgent;
  readonly messaging: MessagingService;

  constructor(
    readonly db: DatabaseSync,
    readonly config: CoreConfig,
  ) {
    this.repos = createRepositories(db);
    this.clinic = loadClinicData(config.dataDir);
    this.clock = new ScenarioClock(this.repos.settings, config.scenarioNow);
    this.requests = new RequestService(db, this.repos, this.clock);
    this.agent = new PatientAgent(config.interpreter ?? new RuleBasedInterpreter());
    this.messaging = new MessagingService(db, this.repos, this.clinic, this.clock, this.requests, this.agent);
    this.messaging.ensureConversation();
  }

  /** Demo reset: deletes all conversations, messages, requests and settings. */
  reset(): void {
    wipeDatabase(this.db);
    this.messaging.ensureConversation();
  }

  snapshot(): Snapshot {
    return {
      exported_at: new Date().toISOString(),
      scenario_now: this.clock.now().toISO()!,
      conversations: this.repos.conversations.list(),
      messages: this.repos.messages.all(),
      requests: this.requests.list().map((r) => ({ ...r, events: this.requests.events(r.id) })),
      agent_runs: this.repos.runs.list(),
    };
  }

  private closed = false;

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

export function createCore(config: CoreConfig): Core {
  return new Core(openDatabase(config.dbPath), config);
}
