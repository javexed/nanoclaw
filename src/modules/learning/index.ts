/**
 * Learning loop module — registers the `propose_skill` delivery action.
 * See docs/design/learning-loop.md.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { handleProposeSkill } from './request.js';

registerDeliveryAction('propose_skill', handleProposeSkill);
