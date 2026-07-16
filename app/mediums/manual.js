import { registerMedium } from './index.js';

export const manualMedium = {
  id: 'manual',
  label: 'Manual search',
  canUse: () => true,
  start() {},
  stop() {},
};

registerMedium(manualMedium);
