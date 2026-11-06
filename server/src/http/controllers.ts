import { Body, Controller, Get, HttpCode, Inject, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { Core } from '../core/create-core.js';
import { REQUEST_STATUSES } from '../core/domain.js';
import { NotFoundError } from '../core/errors.js';
import { DEFAULT_SCENARIO_NOW } from '../core/time/clock.js';
import { PHASE1_SCRIPT } from '../scenario.js';
import { verifyEvals, verifyPhrasing, verifyRestart, verifyScript } from '../demo/verify.js';

/** Request bodies are validated with zod at the edge; the core re-validates its own invariants. */
const SendMessageBody = z.object({
  from: z.enum(['patient', 'clinic']),
  body: z.string().trim().min(1, 'Message body is required').max(1600),
});
const UpdateRequestBody = z
  .object({ status: z.enum(REQUEST_STATUSES).optional(), staff_note: z.string().max(1000).nullable().optional() })
  .refine((b) => b.status !== undefined || b.staff_note !== undefined, 'Provide status and/or staff_note');
const ClockBody = z.object({
  now: z.string().min(10).optional(),
  mode: z.enum(['frozen', 'running']).optional(),
  reset: z.boolean().optional(),
});

function settings(core: Core) {
  const state = core.clock.state();
  return {
    clock: { now: core.clock.now().toISO(), mode: state.mode, default_now: core.config.scenarioNow ?? DEFAULT_SCENARIO_NOW, zone: core.clinic.timezone },
    agent_mode: core.agent.mode,
  };
}

@Controller('api')
export class StateController {
  constructor(@Inject(Core) private readonly core: Core) {}

  /** Everything the demo UI needs on load. */
  @Get('state')
  state() {
    const { clinic } = this.core;
    return {
      clinic: { name: clinic.clinicName, sms_number: clinic.clinicSmsNumber, phone: clinic.phoneDisplay, timezone: clinic.timezone },
      patient: clinic.patients[0],
      faq: clinic.faq,
      open_slots: clinic.slots,
      settings: settings(this.core),
      conversations: this.core.messaging.listConversations(),
      script: PHASE1_SCRIPT,
    };
  }

  /** Live proof for the Requirements page; runs on throwaway databases, never on the demo data. */
  @Get('verify')
  async verify() {
    const started = Date.now();
    const [script, restart, evals, phrasing] = [await verifyScript(), await verifyRestart(), await verifyEvals(), await verifyPhrasing()];
    return { ran_at: new Date().toISOString(), duration_ms: Date.now() - started, script, restart, evals, phrasing };
  }

  @Get('export')
  export() {
    return this.core.snapshot();
  }

  @Post('admin/reset')
  @HttpCode(200)
  reset() {
    this.core.reset();
    return { ok: true, conversations: this.core.messaging.listConversations() };
  }
}

@Controller('api/conversations')
export class ConversationsController {
  constructor(@Inject(Core) private readonly core: Core) {}

  @Get()
  list() {
    return this.core.messaging.listConversations();
  }

  @Post()
  create() {
    return this.core.messaging.createConversation();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return {
      conversation: this.core.messaging.conversation(id),
      messages: this.core.messaging.thread(id),
      agent_runs: this.core.repos.runs.list(id),
    };
  }

  /** from=clinic: staff outbound (simulated, nothing is sent). from=patient: inbound from Alex's number on file. */
  @Post(':id/messages')
  async send(@Param('id') id: string, @Body() body: unknown) {
    const input = SendMessageBody.parse(body);
    if (input.from === 'clinic') return { message: this.core.messaging.sendClinicMessage(id, input.body) };
    return this.core.messaging.receivePatientMessage(id, input.body);
  }
}

@Controller('api/requests')
export class RequestsController {
  constructor(@Inject(Core) private readonly core: Core) {}

  @Get()
  list(@Query('status') status?: string) {
    return this.core.requests.list({ status: status || undefined }).map((r) => ({ ...r, events: this.core.requests.events(r.id) }));
  }

  @Get(':id')
  get(@Param('id') id: string) {
    const r = this.core.requests.get(id);
    if (!r) throw new NotFoundError(`Request ${id} not found`);
    return { ...r, events: this.core.requests.events(id) };
  }

  /** Staff view: status / note changes. The agent itself can never call this. */
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown) {
    const input = UpdateRequestBody.parse(body);
    const current = this.core.requests.get(id);
    const updated = this.core.requests.setStatus(id, input.status ?? current?.status ?? 'pending_staff', input.staff_note);
    return { ...updated, events: this.core.requests.events(id) };
  }
}

@Controller('api/settings')
export class SettingsController {
  constructor(@Inject(Core) private readonly core: Core) {}

  @Get()
  get() {
    return settings(this.core);
  }

  /** Change the scenario clock ("now") during the walkthrough. */
  @Put('clock')
  setClock(@Body() body: unknown) {
    const input = ClockBody.parse(body);
    if (input.reset) this.core.clock.reset();
    else this.core.clock.set({ now: input.now, mode: input.mode });
    return settings(this.core);
  }
}
