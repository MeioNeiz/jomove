import { connect } from "../db.ts";
import { HTML_OUT } from "../config.ts";
import { renderDashboard } from "../template.ts";
import { buildPayload } from "../payload.ts";

export async function cmdReport(): Promise<void> {
  const db = connect();
  const data = buildPayload(db);
  db.close();
  await Bun.write(HTML_OUT, renderDashboard(data));
  console.log(
    `Wrote ${HTML_OUT}  ` +
    `(${data.unique} unique, ${data.total} active, data version ${data.generatedAt})`
  );
}
