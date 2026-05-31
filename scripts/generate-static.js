import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { refreshAnalysis } from "../server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const outputFile = path.join(projectRoot, "public", "api", "analysis.json");

const payload = await refreshAnalysis(process.env.ANALYSIS_REASON || "static-build");

await fs.mkdir(path.dirname(outputFile), { recursive: true });
await fs.writeFile(outputFile, `${JSON.stringify(payload)}\n`, "utf8");

console.log(`Wrote ${path.relative(projectRoot, outputFile)} for ${payload.latestTradingDate || "unknown date"}.`);
