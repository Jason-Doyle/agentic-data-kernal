import {
  loadMigrationDatabaseConfig,
  loadProductionConfig,
  runSreScenario,
} from "agentic-data-kernel/production";

const result = await runSreScenario({
  config: loadProductionConfig(),
  migrationConfig: loadMigrationDatabaseConfig(),
  runId: process.env.SRE_RUN_ID,
});

console.log(JSON.stringify(result, null, 2));
