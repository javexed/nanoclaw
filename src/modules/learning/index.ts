/**
 * Learning loop module — registers the `propose_skill` delivery action.
 * See docs/webchat/design/learning-loop.md.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { handleProposeSkill } from './request.js';

registerDeliveryAction(
  'propose_skill',
  handleProposeSkill,
  unguarded('stages a draft for human review only — nothing executes or lands in agent context until an admin keeps it'),
);
export * from './master.js';
