/**
 * Learning loop — an agent distills a reusable lesson into a SKILL.md draft;
 * a human keeps or discards it from the room. Registers the `propose_skill`
 * delivery action and the module's schema. Channel-agnostic: the web channel
 * listens for the events (events.ts) and draws the cards.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import './migration.js';
import { handleProposeSkill } from './request.js';

registerDeliveryAction(
  'propose_skill',
  handleProposeSkill,
  unguarded('stages a draft for human review only — nothing executes or lands in agent context until someone keeps it'),
);

export * from './events.js';
export * from './settings.js';
