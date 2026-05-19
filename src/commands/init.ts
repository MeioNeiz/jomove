import { connect } from "../db.ts";
import { DB_PATH } from "../config.ts";

export function cmdInit(): void {
  connect().close();
  console.log(`Initialised database at ${DB_PATH}`);
}
