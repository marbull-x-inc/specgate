export { analyze, exitCodeFor } from "./analyze.ts";
export { loadConfig } from "./config/load.ts";
export { dddTs } from "./config/presets/ddd-ts.ts";
export {
  type Config,
  type ConfigInput,
  defineConfig,
  type Preset,
  parseConfig,
  RULE_IDS,
  type RuleId,
  type RuleSeverity,
} from "./config/schema.ts";
export { type Finding, type Guarantee, isReport, type Report, type TestCase, type Unit } from "./ir/schema.ts";
