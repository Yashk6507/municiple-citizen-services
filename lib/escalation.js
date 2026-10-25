/**
 * SLA escalation sweep (Phase 7).
 *
 * The sweep only records escalation events and notifies the configured
 * reviewer. It never changes a complaint's workflow status silently.
 * A scheduled run is triggered from server.js; an identical run can be
 * triggered manually by an administrator.
 */
const {
  all,
  get,
  run,
  audit,
  notify,
  getSetting,
  setSetting
} = require("./store");
const { OPEN_STATUSES, slaState } = require("./civic");

async function escalateOverdue({ actor = null } = {}) {
  const enabled = (await getSetting("escalation_enabled", "1")) === "1";
  if (!enabled) {
    return { enabled: false, scanned: 0, escalated: [], message: "Escalation is disabled in settings." };
  }

  const overdue = await all(
    `SELECT c.id, c.reference_no, c.status, c.priority, c.due_at, c.escalation_level,
            c.user_id, c.assigned_user_id, c.department_id,
            d.name AS department_name, d.contact_email AS department_email
     FROM complaints c
     LEFT JOIN departments d ON d.id = c.department_id
     WHERE c.due_at IS NOT NULL AND c.due_at < CURRENT_TIMESTAMP
       AND c.status IN (${OPEN_STATUSES.map(() => "?").join(",")})
     ORDER BY c.due_at ASC
     LIMIT 500`,
    [...OPEN_STATUSES]
  );

  const escalated = [];
  for (const row of overdue) {
    const nextLevel = (row.escalation_level || 0) + 1;

    // Guard against duplicate escalation events for the same level.
    const openEscalation = await get(
      `SELECT id FROM complaint_escalations
       WHERE complaint_id = ? AND level = ? AND acknowledged_at IS NULL`,
      [row.id, nextLevel]
    );
    if (openEscalation) continue;

    const target = row.department_email || row.department_name || "Supervisor review queue";

    await run(
      `INSERT INTO complaint_escalations (complaint_id, level, escalated_to, reason)
       VALUES (?, ?, ?, ?)`,
      [
        row.id,
        nextLevel,
        target,
        `Complaint passed its internally configured resolution target (${row.due_at}).`
      ]
    );
    // Only the escalation counter changes; the workflow status is untouched.
    await run("UPDATE complaints SET escalation_level = ? WHERE id = ?", [nextLevel, row.id]);

    await notify(
      row.assigned_user_id || row.user_id,
      row.id,
      "complaint_escalated",
      "Complaint escalated",
      `Complaint ${row.reference_no} has passed its internal resolution target and was escalated to ${target}.`
    );
    await audit(actor, "complaint_escalated", "complaint", row.id, null,
      { level: nextLevel, escalated_to: target }, null);

    escalated.push({ id: row.id, reference_no: row.reference_no, level: nextLevel, escalated_to: target });
  }

  await setSetting("last_escalation_sweep", new Date().toISOString());
  return {
    enabled: true,
    scanned: overdue.length,
    escalated,
    message: escalated.length
      ? `${escalated.length} overdue complaint(s) escalated.`
      : "No new escalations were required."
  };
}

module.exports = { escalateOverdue, slaState };
