import { config } from "./config.js";
import { openDatabase } from "./db.js";

process.umask(0o077);
const db = openDatabase(config.dbPath);
db.close();
process.stderr.write(`Base preparada en ${config.dbPath}\n`);
