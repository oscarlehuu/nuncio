import type { TestingModuleBuilder } from '@nestjs/testing';
import { CursorAgentProvider } from '../../src/agents/providers/cursor-agent.provider';
import { SimulatedCursorAgentProvider } from './simulated-cursor-agent.provider';

export function withSimulatedCursorProvider(builder: TestingModuleBuilder): TestingModuleBuilder {
  return builder.overrideProvider(CursorAgentProvider).useClass(SimulatedCursorAgentProvider);
}

export function configureSimulatedCursorEnv(): void {
  process.env.CURSOR_API_KEY = process.env.CURSOR_API_KEY ?? 'nuncio-test-cursor-key';
}
