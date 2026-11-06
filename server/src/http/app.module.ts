import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Core } from '../core/create-core.js';
import { ConversationsController, RequestsController, SettingsController, StateController } from './controllers.js';
import { DomainErrorFilter } from './http-errors.js';

/**
 * Nest is the HTTP shell only. The framework-free Core (agent, tools, storage)
 * is created once and injected, which keeps the agent testable without HTTP and
 * lets tests/evals use an in-memory database.
 */
@Module({})
export class AppModule {
  static register(core: Core): DynamicModule {
    return {
      module: AppModule,
      controllers: [StateController, ConversationsController, RequestsController, SettingsController],
      providers: [
        { provide: Core, useValue: core },
        { provide: APP_FILTER, useClass: DomainErrorFilter },
      ],
    };
  }
}
