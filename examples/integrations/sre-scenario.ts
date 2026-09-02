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

const { explanation, ...summary } = result;
console.log(JSON.stringify(summary, null, 2));
console.log("");
console.log(explanation);
