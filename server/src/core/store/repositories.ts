import type { DatabaseSync } from 'node:sqlite';
import type {
  AgentRun,
  Conversation,
  HandoffRequest,
  Message,
  MessageMeta,
  RequestEvent,
} from '../domain.js';
import type { ClockState, ClockStore } from '../time/clock.js';

type Row = Record<string, unknown>;
const json = <T>(v: unknown, fallback: T): T => (typeof v === 'string' && v.length ? (JSON.parse(v) as T) : fallback);

/** Human-friendly sequential ids (msg_0001, req_001 ...) that survive restarts. */
export class IdGenerator {
  constructor(private readonly db: DatabaseSync) {}

  next(prefix: 'conv' | 'msg' | 'req' | 'run', width = prefix === 'msg' || prefix === 'run' ? 4 : 3): string {
    const row = this.db
      .prepare(
        'INSERT INTO counters (name, value) VALUES (?, 1) ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value',
      )
      .get(prefix) as { value: number };
    return `${prefix}_${String(row.value).padStart(width, '0')}`;
  }
}

export class SettingsRepo implements ClockStore {
  constructor(private readonly db: DatabaseSync) {}

  get<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  getClock(): ClockState | null {
    return this.get<ClockState>('clock');
  }

  saveClock(state: ClockState): void {
    this.set('clock', state);
  }
}

export class ConversationRepo {
  constructor(private readonly db: DatabaseSync) {}

  insert(c: Conversation): Conversation {
    this.db
      .prepare(
        `INSERT INTO conversations (id, patient_id, channel, patient_number, clinic_number, started_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(c.id, c.patient_id, c.channel, c.patient_number, c.clinic_number, c.started_by, c.created_at, c.updated_at);
    return c;
  }

  get(id: string): Conversation | null {
    return (this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as Conversation | undefined) ?? null;
  }

  list(patientId?: string): Conversation[] {
    return (
      patientId
        ? this.db.prepare('SELECT * FROM conversations WHERE patient_id = ? ORDER BY id').all(patientId)
        : this.db.prepare('SELECT * FROM conversations ORDER BY id').all()
    ) as unknown as Conversation[];
  }

  touch(id: string, at: string, startedBy?: 'clinic' | 'patient'): void {
    this.db
      .prepare('UPDATE conversations SET updated_at = ?, started_by = COALESCE(started_by, ?) WHERE id = ?')
      .run(at, startedBy ?? null, id);
  }
}

export class MessageRepo {
  constructor(private readonly db: DatabaseSync) {}

  private map = (r: Row): Message => ({ ...(r as unknown as Message), meta: json<MessageMeta>(r.meta, {}) });

  insert(m: Omit<Message, 'seq'>): Message {
    const { seq } = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE conversation_id = ?')
      .get(m.conversation_id) as { seq: number };
    const full: Message = { ...m, seq };
    this.db
      .prepare(
        `INSERT INTO messages (id, conversation_id, seq, direction, author, from_number, to_number, body, in_reply_to, meta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        full.id, full.conversation_id, full.seq, full.direction, full.author, full.from_number, full.to_number,
        full.body, full.in_reply_to, JSON.stringify(full.meta), full.created_at,
      );
    return full;
  }

  get(id: string): Message | null {
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Row | undefined;
    return r ? this.map(r) : null;
  }

  thread(conversationId: string): Message[] {
    return (this.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq').all(conversationId) as Row[]).map(
      this.map,
    );
  }

  all(): Message[] {
    return (this.db.prepare('SELECT * FROM messages ORDER BY conversation_id, seq').all() as Row[]).map(this.map);
  }

  setReplyLink(id: string, inReplyTo: string | null, meta: MessageMeta): void {
    this.db.prepare('UPDATE messages SET in_reply_to = ?, meta = ? WHERE id = ?').run(inReplyTo, JSON.stringify(meta), id);
  }
}

export class RequestRepo {
  constructor(private readonly db: DatabaseSync) {}

  private map = (r: Row): HandoffRequest => ({
    ...(r as unknown as HandoffRequest),
    details: json<Record<string, unknown>>(r.details, {}),
    source_message_ids: json<string[]>(r.source_message_ids, []),
  });

  insert(q: HandoffRequest): void {
    this.db
      .prepare(
        `INSERT INTO requests (id, patient_id, conversation_id, type, status, priority, summary, details, source_message_ids,
                               revision, staff_note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        q.id, q.patient_id, q.conversation_id, q.type, q.status, q.priority, q.summary, JSON.stringify(q.details),
        JSON.stringify(q.source_message_ids), q.revision, q.staff_note, q.created_at, q.updated_at,
      );
  }

  update(q: HandoffRequest): void {
    this.db
      .prepare(
        `UPDATE requests SET status = ?, priority = ?, summary = ?, details = ?, source_message_ids = ?, revision = ?,
                             staff_note = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        q.status, q.priority, q.summary, JSON.stringify(q.details), JSON.stringify(q.source_message_ids), q.revision,
        q.staff_note, q.updated_at, q.id,
      );
  }

  get(id: string): HandoffRequest | null {
    const r = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as Row | undefined;
    return r ? this.map(r) : null;
  }

  list(filter: { patientId?: string; status?: string } = {}): HandoffRequest[] {
    const where: string[] = [];
    const args: string[] = [];
    if (filter.patientId) (where.push('patient_id = ?'), args.push(filter.patientId));
    if (filter.status) (where.push('status = ?'), args.push(filter.status));
    const sql = `SELECT * FROM requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id`;
    return (this.db.prepare(sql).all(...args) as Row[]).map(this.map);
  }
}

export class RequestEventRepo {
  constructor(private readonly db: DatabaseSync) {}

  insert(e: Omit<RequestEvent, 'id'>): void {
    this.db
      .prepare('INSERT INTO request_events (request_id, at, actor, kind, message_id, changes, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(e.request_id, e.at, e.actor, e.kind, e.message_id, JSON.stringify(e.changes), e.note);
  }

  forRequest(requestId: string): RequestEvent[] {
    return (this.db.prepare('SELECT * FROM request_events WHERE request_id = ? ORDER BY id').all(requestId) as Row[]).map(
      (r) => ({ ...(r as unknown as RequestEvent), changes: json(r.changes, {}) }),
    );
  }

  all(): RequestEvent[] {
    return (this.db.prepare('SELECT * FROM request_events ORDER BY id').all() as Row[]).map((r) => ({
      ...(r as unknown as RequestEvent),
      changes: json(r.changes, {}),
    }));
  }
}

export class AgentRunRepo {
  constructor(private readonly db: DatabaseSync) {}

  insert(run: AgentRun): void {
    this.db
      .prepare(
        `INSERT INTO agent_runs (id, conversation_id, inbound_message_id, reply_message_id, mode, trace, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(run.id, run.conversation_id, run.inbound_message_id, run.reply_message_id, run.mode, JSON.stringify(run.trace), run.error, run.created_at);
  }

  list(conversationId?: string): AgentRun[] {
    const rows = (
      conversationId
        ? this.db.prepare('SELECT * FROM agent_runs WHERE conversation_id = ? ORDER BY id').all(conversationId)
        : this.db.prepare('SELECT * FROM agent_runs ORDER BY id').all()
    ) as Row[];
    return rows.map((r) => ({ ...(r as unknown as AgentRun), trace: json(r.trace, {}) }));
  }
}

export interface Repositories {
  ids: IdGenerator;
  settings: SettingsRepo;
  conversations: ConversationRepo;
  messages: MessageRepo;
  requests: RequestRepo;
  events: RequestEventRepo;
  runs: AgentRunRepo;
}

export function createRepositories(db: DatabaseSync): Repositories {
  return {
    ids: new IdGenerator(db),
    settings: new SettingsRepo(db),
    conversations: new ConversationRepo(db),
    messages: new MessageRepo(db),
    requests: new RequestRepo(db),
    events: new RequestEventRepo(db),
    runs: new AgentRunRepo(db),
  };
}
