/** API host composition: the governance boundary receives identity's consent
 * reader and audit writer through required ports, without lib importing modules. */
import { getAIPrivacySettings, logAICall } from "../modules/identity/ai-consent-service.ts";
import type { ApiAIGovernanceDependencies } from "../lib/ai-governance.ts";

export const productionAiGovernancePorts: ApiAIGovernanceDependencies = Object.freeze({
  settings: getAIPrivacySettings,
  audit: logAICall,
});
