#!/usr/bin/env node
// Read ~/.pi/agent/router-shadow.jsonl (or PI_CODING_AGENT_DIR) and print tier shares.

import {
  formatShadowReport,
  readShadowLines,
  shadowLogPath,
  summarizeShadowLog,
} from "../packages/router/shadow-log.mjs";

const file = process.argv[2] ?? shadowLogPath();
const summary = summarizeShadowLog(readShadowLines(file));
console.log(formatShadowReport(summary));
console.log(`file ${file}`);
