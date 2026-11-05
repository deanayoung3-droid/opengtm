import type { Alerter } from "./alerts";
import type { Clock } from "./clock";
import type { Config } from "./config";
import type { Db } from "./db/client";
import type { Llm } from "./llm/types";
import type { Logger } from "./log";

/** Everything a pipeline stage needs. Built once by the worker, or by tests with fakes. */
export interface Ctx {
  db: Db;
  config: Config;
  llm: Llm;
  clock: Clock;
  log: Logger;
  alerts: Alerter;
  env: NodeJS.ProcessEnv;
  /** Injectable randomness (sampling, jitter, variant assignment). */
  random: () => number;
}
