/**
 * CivilBot — the portal's built-in civic assistant.
 *
 * Every answer is composed from the portal's own live reference data: the
 * service categories and subcategories, the departments and wards, the
 * resolution targets in sla_policies, the complaint workflow and the signed-in
 * citizen's own records. No external AI service, no API key and no network
 * call are involved, so CivilBot always answers, works offline, and can never
 * leak a citizen's data to a third party.
 *
 * lib/store is deliberately not required here: this module is read-only and
 * talks to SQLite directly, which keeps the dependency graph acyclic.
 */
const db = require("../db");
const { OPEN_STATUSES, REOPENABLE_STATUSES } = require("./civic");

// Reference data is cached briefly so administrator edits appear promptly
// without re-querying on every keystroke.
const CACHE_MS = 60000;
let cache = { at: 0, data: null };

const STOPWORDS = new Set([
  "a", "about", "after", "again", "all", "also", "am", "an", "and", "any", "are", "as", "at",
  "be", "because", "been", "before", "but", "by", "can", "could", "did", "do", "does", "for",
  "from", "get", "give", "got", "had", "has", "have", "here", "how", "i", "if", "in", "into",
  "is", "it", "its", "just", "know", "like", "me", "more", "my", "need", "no", "not", "of",
  "on", "or", "our", "out", "please", "should", "so", "some", "tell", "than", "that", "the",
  "their", "them", "then", "there", "these", "they", "this", "those", "to", "up", "us", "want",
  "was", "we", "were", "what", "when", "where", "which", "who", "why", "will", "with", "would",
  "you", "your"
]);

const PRIORITY_LABELS = { critical: "critical", high: "high", medium: "medium", low: "low" };

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------
function normalise(value) {
  return String(value === null || value === undefined ? "" : value)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Crude but consistent stemming, so "potholes" matches "pothole". */
function stem(word) {
  return word.replace(/ies$/, "y").replace(/(ses|es|s)$/, "");
}

function tokens(value) {
  return normalise(value)
    .split(" ")
    .filter((token) => token.length > 2 && !STOPWORDS.has(token))
    .map(stem);
}

function bullets(lines) {
  return lines.filter(Boolean).map((line) => `• ${line}`).join("\n");
}

function hoursText(hours) {
  if (!hours) return null;
  if (hours % 24 === 0) {
    const days = hours / 24;
    return `${hours} hours (${days} ${days === 1 ? "day" : "days"})`;
  }
  return `${hours} hours`;
}

// ---------------------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------------------
async function loadKnowledge() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;

  const [categories, subcategories, departments, wards, targets, offices, settings, counts] =
    await Promise.all([
      db.allAsync(
        `SELECT id, code, name, kind, description, is_emergency
         FROM service_categories WHERE is_active = 1 ORDER BY sort_order, name`
      ),
      db.allAsync(
        `SELECT s.id, s.name, s.item_type, s.checklist, s.processing_time, s.official_url,
                s.default_priority, s.sla_hours, s.category_id, s.department_id,
                c.name AS category_name, d.name AS department_name
         FROM service_subcategories s
         LEFT JOIN service_categories c ON c.id = s.category_id
         LEFT JOIN departments d ON d.id = s.department_id
         WHERE s.is_active = 1
         ORDER BY s.sort_order, s.name`
      ),
      db.allAsync(
        `SELECT id, code, name, description, contact_email, contact_phone
         FROM departments WHERE is_active = 1 ORDER BY name`
      ),
      db.allAsync("SELECT id, name, zone FROM wards WHERE is_active = 1 ORDER BY name"),
      db.allAsync("SELECT priority, target_hours FROM sla_policies WHERE category_id IS NULL"),
      db.allAsync(
        `SELECT name, address, phone, email, office_hours
         FROM municipal_offices WHERE is_active = 1 ORDER BY id`
      ),
      db.allAsync("SELECT key, value FROM app_settings"),
      db.getAsync(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS resolved
         FROM complaints`
      )
    ]);

  const settingsMap = {};
  for (const row of settings || []) settingsMap[row.key] = row.value;

  const openPlaceholders = OPEN_STATUSES.map(() => "?").join(",");
  const openRow = await db.getAsync(
    `SELECT COUNT(*) AS open FROM complaints WHERE status IN (${openPlaceholders})`,
    [...OPEN_STATUSES]
  );

  const byCategory = new Map();
  for (const category of categories) byCategory.set(category.id, category);
  for (const category of byCategory.values()) category.subcategories = [];
  for (const sub of subcategories) {
    const parent = byCategory.get(sub.category_id);
    if (parent) parent.subcategories.push(sub);
  }

  const targetMap = {};
  for (const row of targets || []) targetMap[row.priority] = row.target_hours;

  const data = {
    categories: [...byCategory.values()],
    subcategories,
    departments,
    wards,
    targets: targetMap,
    offices,
    duplicateRadius: Number(settingsMap.duplicate_radius_meters) || 300,
    minGroup: Number(settingsMap.public_min_group_count) || 3,
    counts: {
      total: (counts && counts.total) || 0,
      resolved: (counts && counts.resolved) || 0,
      open: (openRow && openRow.open) || 0
    }
  };

  cache = { at: Date.now(), data };
  return data;
}

/** Best-matching category or subcategory for a set of question tokens. */
function findTopic(questionTokens, kb) {
  if (!questionTokens.length) return null;
  let best = null;

  const score = (name) => {
    const nameTokens = tokens(name);
    if (!nameTokens.length) return 0;
    let hits = 0;
    for (const token of nameTokens) {
      if (questionTokens.includes(token)) hits += 1;
      else if (questionTokens.some((q) => q.length > 4 && token.length > 4 && (q.includes(token) || token.includes(q)))) {
        hits += 0.75;
      }
    }
    return hits / nameTokens.length;
  };

  for (const sub of kb.subcategories) {
    const value = score(sub.name) + 0.35; // a specific service beats its parent category
    if (value > 0.6 && (!best || value > best.score)) best = { type: "subcategory", score: value, item: sub };
  }
  for (const category of kb.categories) {
    const value = score(category.name);
    if (value > 0.6 && (!best || value > best.score)) best = { type: "category", score: value, item: category };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Answer builders
// ---------------------------------------------------------------------------
function describeCategory(category, kb) {
  const parts = [`${category.name}`];
  if (category.description) parts.push(category.description);

  const departments = [
    ...new Set((category.subcategories || []).map((sub) => sub.department_name).filter(Boolean))
  ];
  if (departments.length) parts.push(`Handled by: ${departments.join(", ")}.`);
  if (category.is_emergency) {
    parts.push("This category is flagged as an emergency category.");
  }

  const sample = (category.subcategories || []).slice(0, 6).map((sub) => sub.name);
  if (sample.length) {
    const extra = (category.subcategories || []).length - sample.length;
    parts.push(
      `You can report:\n${bullets(sample)}${extra > 0 ? `\n…and ${extra} more.` : ""}`
    );
  }
  parts.push("Filing takes a couple of minutes: open Complaints, pick this category and the exact service, describe the problem, pin the location and attach a photo or video.");
  return parts.join("\n\n");
}

function describeSubcategory(sub) {
  const parts = [`${sub.name} — ${sub.category_name}`];
  if (sub.department_name) parts.push(`Handled by ${sub.department_name}.`);

  const facts = [];
  if (sub.default_priority) {
    const label = PRIORITY_LABELS[sub.default_priority] || sub.default_priority;
    const hours = sub.sla_hours || null;
    facts.push(
      `Default priority ${label}${hours ? ` with an internal target of ${hoursText(hours)}` : ""}.`
    );
  }
  if (sub.processing_time) facts.push(`Published processing time: ${sub.processing_time}.`);
  if (facts.length) parts.push(facts.join(" "));

  if (sub.checklist) {
    const items = String(sub.checklist)
      .split(/\r?\n|;/)
      .map((line) => line.replace(/^[-•\d.\s]+/, "").trim())
      .filter(Boolean)
      .slice(0, 8);
    if (items.length) parts.push(`What to have ready:\n${bullets(items)}`);
  }
  if (sub.item_type === "information") {
    parts.push("This is an information service — it explains a process rather than accepting a complaint.");
  } else if (sub.item_type === "application") {
    parts.push("This is an application service: submit it from Services and you will receive an APP- reference number to track it.");
  }
  parts.push(`File it from Complaints, choosing "${sub.category_name}" and then "${sub.name}".`);
  return parts.join("\n\n");
}

function targetsText(kb) {
  const order = ["critical", "high", "medium", "low"];
  const lines = order
    .filter((priority) => kb.targets[priority])
    .map((priority) => `${priority}: ${hoursText(kb.targets[priority])}`);
  return lines.length
    ? lines.join("\n")
    : "No resolution targets are configured yet.";
}

// ---------------------------------------------------------------------------
// Intents
// ---------------------------------------------------------------------------
const STATUS_HELP = {
  Submitted: "your complaint has been received and is waiting to be triaged.",
  "Under Review": "an officer is verifying the details before routing it.",
  Assigned: "it has been routed to a department and an officer is responsible for it.",
  "In Progress": "work on the ground has started.",
  Resolved: "the department has marked it resolved. You can rate the work, and reopen it if it is not actually fixed.",
  Rejected: "it was not actioned, and the reason is recorded on the complaint.",
  Reopened: "you contested the resolution and a reviewer is looking at it again.",
  Closed: "it is final. A closed complaint can still be reopened if the problem returns."
};

const INTENTS = [
  {
    id: "greeting",
    keywords: ["hello", "hi", "hey", "good morning", "good afternoon", "good evening", "namaste"],
    answer: () => "Hello, I am CivilBot — this portal's civic assistant. I can explain how to report an issue, which department handles what, how long a complaint should take, and where your complaint has reached. What would you like to know?"
  },
  {
    id: "thanks",
    keywords: ["thank you", "thanks", "thankyou", "appreciate it", "helpful"],
    answer: () => "Happy to help. Ask me anything else about the portal, or file your complaint from the Complaints section."
  },
  {
    id: "capabilities",
    keywords: ["what can you do", "who are you", "your name", "what are you", "help me", "how can you help", "civilbot"],
    answer: (ctx) => {
      const kb = ctx.kb;
      return [
        "I am CivilBot. I answer from this portal's own live records, so nothing I say is guesswork.",
        "Things I can do:",
        bullets([
          `Explain the ${kb.categories.length} complaint categories and which department handles each`,
          "Walk you through filing a complaint, step by step",
          "Explain what each complaint status means",
          `Quote the internal resolution targets (${targetsText(kb).replace(/\n/g, ", ")})`,
          "Tell you how to track a complaint with its CMP- reference number",
          "List your own complaints and their current status when you are signed in",
          "Explain escalation, duplicate detection, feedback and reopening"
        ])
      ].join("\n\n");
    }
  },
  {
    id: "emergency",
    keywords: ["emergency", "urgent danger", "fire", "burning", "collapse", "electrocution", "live wire", "accident", "ambulance", "police"],
    answer: (ctx) => {
      const emergency = ctx.kb.categories.filter((category) => category.is_emergency).map((category) => category.name);
      return [
        "If anyone is in danger right now, do not use this portal — call the emergency services on 112 immediately.",
        emergency.length
          ? `The portal does carry routine reports for: ${emergency.join(", ")}. Active fires, collapsing structures and live wires must go to the emergency services first.`
          : "",
        "Once the immediate danger is handled, you can still file a complaint here so the department has a record and can carry out follow-up work."
      ]
        .filter(Boolean)
        .join("\n\n");
    }
  },
  {
    id: "how_to_file",
    keywords: ["how to file", "how do i file", "how to report", "how do i report", "file a complaint", "register a complaint", "lodge a complaint", "submit a complaint", "make a complaint", "raise a complaint", "new complaint", "start a complaint", "report an issue", "report a problem"],
    answer: (ctx) => {
      const steps = [
        "Sign in, or register with your email address — a complaint is linked to your account so you can track it.",
        "Open Complaints and choose File a complaint.",
        "Pick the category and then the exact service, so it is routed to the right department automatically.",
        "Describe what is wrong and where, in plain language.",
        "Pin the location on the map, or use your device's position. The coordinates let the department find the spot.",
        "Attach a photo or a short video as evidence — this is optional but it speeds up verification.",
        "Submit. You receive a reference number in the form CMP-2026-000123."
      ];
      const suffix = ctx.topic
        ? `For ${ctx.topic.item.name}, choose the category "${ctx.topic.item.category_name || ctx.topic.item.name}".`
        : "";
      return [
        "Filing a complaint takes about two minutes:",
        steps.map((step, index) => `${index + 1}. ${step}`).join("\n"),
        suffix
      ]
        .filter(Boolean)
        .join("\n\n");
    }
  },
  {
    id: "categories",
    keywords: ["categories", "category list", "what can i report", "what can be reported", "types of complaints", "kinds of complaints", "list of complaints", "complaint types", "all categories", "which complaints"],
    answer: (ctx) => {
      const kb = ctx.kb;
      return [
        `The portal accepts ${kb.categories.length} categories of civic issue:`,
        bullets(kb.categories.map((category) => `${category.name}${category.is_emergency ? " (emergency category)" : ""} — ${category.description || ""}`.trim())),
        "Name any one of them and I will tell you which department handles it and how to file it."
      ].join("\n\n");
    }
  },
  {
    id: "applications",
    keywords: ["application", "certificate", "birth certificate", "death certificate", "marriage certificate", "licence", "license", "permission", "apply for", "how to apply", "scheme", "admission", "school", "community hall", "app-"],
    answer: (ctx) => {
      const kb = ctx.kb;
      const applicable = kb.subcategories.filter((sub) => sub.item_type === "application");
      const information = kb.subcategories.filter((sub) => sub.item_type === "information");
      const serviceCategories = kb.categories
        .filter((category) => category.kind && category.kind !== "complaint")
        .map((category) => category.name);

      return [
        "Besides complaints, the portal handles service requests and information.",
        serviceCategories.length
          ? `Service categories: ${serviceCategories.join(", ")}.`
          : "",
        applicable.length
          ? `${applicable.length} service${applicable.length === 1 ? "" : "s"} accept an online application. You submit them from Services and receive a reference number in the form APP-2026-000045 to track progress.`
          : "",
        information.length
          ? `${information.length} service${information.length === 1 ? "" : "s"} provide guidance only — they explain a process and do not accept a submission.`
          : "",
        applicable.length
          ? `Examples: ${applicable.slice(0, 5).map((sub) => sub.name).join(", ")}.`
          : "",
        "Ask me about any specific service and I will tell you who handles it and what to prepare."
      ]
        .filter(Boolean)
        .join("\n\n");
    }
  },
  {
    id: "tracking",
    keywords: ["track", "tracking", "check status", "complaint status", "reference number", "reference no", "where is my complaint", "what happened to my complaint", "follow up", "cmp-", "status of my complaint", "latest update"],
    answer: (ctx) => {
      const reference = String(ctx.question || "").match(/\b(?:CMP|APP)-\d{4}-\d{4,8}\b/i);
      const parts = [];
      if (reference) {
        parts.push(`Open the Track complaint page, enter ${reference[0].toUpperCase()} and your registered email address, and you will see the full timeline: every status change, the assigned department, notes and any evidence.`);
      } else {
        parts.push("Open the Track complaint page and enter your reference number. Reference numbers look like CMP-2026-000123 for a complaint and APP-2026-000045 for a service application.");
      }
      parts.push(
        ctx.user
          ? "Because you are signed in, everything you filed is also listed under Dashboard → My complaints, with the current status and the internal target date."
          : "If you sign in with the same email address you used when filing, the complaint also appears under Dashboard → My complaints."
      );
      if (ctx.kb && ctx.kb.counts.total) {
        parts.push(`The portal currently holds ${ctx.kb.counts.total} complaint record(s), of which ${ctx.kb.counts.open} are still open.`);
      }
      return parts.join("\n\n");
    }
  },
  {
    id: "my_complaints",
    keywords: ["my complaints", "my cases", "my requests", "my reports", "complaints i filed", "what did i report", "show my", "list my", "mine"],
    answer: async (ctx) => {
      if (!ctx.user) {
        return "I can only show your own complaints once you are signed in, because complaints are private to the citizen who filed them. Sign in with the email address you used when reporting, then ask me again.";
      }
      const rows = await db.allAsync(
        `SELECT c.reference_no, c.title, c.status, c.priority, c.due_at, c.created_at,
                d.name AS department_name, u.name AS officer_name
         FROM complaints c
         LEFT JOIN departments d ON d.id = c.department_id
         LEFT JOIN users u ON u.id = c.assigned_user_id
         WHERE c.user_id = ?
         ORDER BY c.created_at DESC LIMIT 6`,
        [ctx.user.id]
      );
      if (!rows.length) {
        return "I cannot find any complaints filed from your account. Open Complaints → File a complaint and I can walk you through it.";
      }
      const recent = rows.map((row) => {
        const who = row.officer_name
          ? `handled by ${row.officer_name}`
          : row.department_name
            ? `with ${row.department_name}`
            : "still awaiting routing";
        return `${row.reference_no} — ${row.title || "no title"} — ${row.status} (${who})`;
      });
      return [
        `You have ${rows.length === 6 ? "at least 6" : rows.length} complaint record${rows.length === 1 ? "" : "s"}. The most recent:`,
        bullets(recent),
        "Open Dashboard → My complaints for the full list and the complete timeline of any one of them."
      ].join("\n\n");
    }
  },
  {
    id: "status_meaning",
    keywords: ["status mean", "what does under review mean", "what does assigned mean", "what does resolved mean", "what does closed mean", "what does reopened mean", "what does rejected mean", "statuses", "status list", "stages", "workflow", "lifecycle", "meaning of status"],
    answer: (ctx) => {
      const listed = String(ctx.question || "").toLowerCase();
      const asked = Object.keys(STATUS_HELP).find((status) => listed.includes(status.toLowerCase()));
      if (asked) return `"${asked}" means ${STATUS_HELP[asked]}`;
      return [
        "A complaint moves through eight statuses:",
        bullets(Object.keys(STATUS_HELP).map((status) => `${status} — ${STATUS_HELP[status]}`)),
        "Only certain transitions are allowed, so a complaint cannot jump straight to Resolved without passing through the work stages."
      ].join("\n\n");
    }
  },
  {
    id: "how_long",
    keywords: ["how long", "how many days", "resolution time", "sla", "deadline", "target date", "time limit", "turnaround", "when will", "how much time", "due date", "resolution target"],
    answer: (ctx) => [
      "Each complaint gets an internal resolution target based on its priority:",
      targetsText(ctx.kb),
      "The target date is shown on the complaint itself. These are internal municipal targets used to trigger escalation — they are not a legal guarantee.",
      "Priority is set from the category and the severity you describe, and a supervisor can adjust it."
    ].join("\n\n")
  },
  {
    id: "escalation",
    keywords: ["escalat", "overdue", "past the target", "not resolved", "ignored", "no action taken", "delayed", "still pending", "nothing happened"],
    answer: () => [
      "If a complaint passes its internal target date while still open, the portal raises an escalation automatically:",
      bullets([
        "The escalation level on the complaint increases and the event is recorded in its history.",
        "The responsible officer and the review queue are notified.",
        "The workflow status is not changed silently — the department still has to act and record what it did."
      ]),
      "Escalations are swept on a schedule, so a complaint is not escalated twice for the same level."
    ].join("\n\n")
  },
  {
    id: "evidence",
    keywords: ["photo", "picture", "image", "video", "attach", "attachment", "evidence", "upload", "prove", "proof", "camera"],
    answer: () => [
      "You can attach photographs and video as evidence when you file a complaint, and officers can attach resolution evidence later.",
      "A few things worth knowing:",
      bullets([
        "Each file is checked for type and size before it is accepted.",
        "Evidence is stored in a private area of the server, outside the public website.",
        "It is visible only to you and to the officers handling the complaint — it never appears on the public transparency pages.",
        "A clear photo of the problem, taken at the location, is the single most useful thing you can add."
      ])
    ].join("\n\n")
  },
  {
    id: "duplicates",
    keywords: ["duplicate", "already reported", "someone already", "same problem", "repeat complaint", "reported before", "similar complaint"],
    answer: (ctx) => [
      "Before a complaint is accepted, the portal compares it with nearby recent complaints to avoid duplicate work.",
      `It looks at both how close the complaints are (within about ${ctx.kb.duplicateRadius} metres) and how similar the wording is.`,
      "If a likely duplicate is found, you are shown it before you submit, so you can add your report to the existing one instead of creating a second ticket.",
      "If your issue genuinely is separate — a different pothole, a different street — go ahead and file it."
    ].join("\n\n")
  },
  {
    id: "feedback",
    keywords: ["feedback", "rate", "rating", "review", "satisfied", "not satisfied", "star", "how was the work"],
    answer: () => [
      "Once a complaint is marked Resolved you can rate the work and leave a comment.",
      "Your rating is recorded against the complaint and feeds the department's performance figures on the transparency pages.",
      "It is entirely optional, but it is the quickest way to tell the municipality that a job was done properly."
    ].join("\n\n")
  },
  {
    id: "reopen",
    keywords: ["reopen", "re-open", "still not fixed", "problem again", "not actually fixed", "came back", "resolved but", "wrongly closed", "contest"],
    answer: () => [
      `A complaint that is ${REOPENABLE_STATUSES.join(", ")} can be reopened.`,
      bullets([
        "Open the complaint and choose Reopen request.",
        "Give the reason: what is still wrong, and any new evidence.",
        "A reviewer approves or rejects the request, and you are notified either way."
      ]),
      "Reopening does not erase the original record — the reopened complaint keeps its full history and its reference number."
    ].join("\n\n")
  },
  {
    id: "priority",
    keywords: ["priority", "urgent", "how urgent", "severity", "critical", "high priority", "severity level"],
    answer: (ctx) => [
      "Complaints carry one of four priorities: critical, high, medium and low.",
      "The priority normally comes from the service you chose, and officers can raise or lower it based on what they find. It cannot be set arbitrarily outside those four levels.",
      "Priority drives the internal target:",
      targetsText(ctx.kb)
    ].join("\n\n")
  },
  {
    id: "departments",
    keywords: ["department", "departments", "who handles", "who is responsible", "which department", "who deals", "authority", "concerned department"],
    answer: (ctx) => {
      const kb = ctx.kb;
      const topic = ctx.topic;
      if (topic) {
        const name = topic.item.name;
        const subs = topic.type === "category" ? topic.item.subcategories || [] : [topic.item];
        const departments = [...new Set(subs.map((sub) => sub.department_name).filter(Boolean))];
        if (departments.length) {
          return `${name} is handled by: ${departments.join(", ")}.\n\nEach service under it is routed to its own department automatically when you file, so you do not need to choose the department yourself.`;
        }
      }
      return [
        `The municipality is organised into ${kb.departments.length} departments that receive routed complaints:`,
        bullets(kb.departments.map((department) => `${department.name}${department.contact_email ? ` (${department.contact_email})` : ""}`)),
        "You never pick the department yourself — choosing the right category and service routes the complaint automatically."
      ].join("\n\n");
    }
  },
  {
    id: "wards",
    keywords: ["ward", "wards", "zone", "my area", "locality", "which ward"],
    answer: (ctx) => {
      const kb = ctx.kb;
      return [
        `The city is divided into ${kb.wards.length} wards:`,
        bullets(kb.wards.map((ward) => `${ward.name}${ward.zone ? ` — ${ward.zone}` : ""}`)),
        "When you file, pin the location on the map and the ward is determined from the coordinates, so reports can be grouped by area."
      ].join("\n\n");
    }
  },
  {
    id: "statistics",
    keywords: ["statistic", "statistics", "how many complaints", "total complaints", "how many resolved", "numbers", "figures", "dashboard numbers", "performance", "resolution rate"],
    answer: (ctx) => {
      const counts = ctx.kb.counts;
      return [
        "Here is the live position:",
        bullets([
          `Complaints on record: ${counts.total}`,
          `Resolved: ${counts.resolved}`,
          `Still open: ${counts.open}`
        ]),
        "The Transparency pages carry the full breakdown by category, ward and department, with automatic suppression of very small groups so no individual citizen can be identified from a public chart."
      ].join("\n\n");
    }
  },
  {
    id: "privacy",
    keywords: ["privacy", "private", "who can see", "public", "confidential", "anonymous", "my data", "personal information", "visible to others", "data safe"],
    answer: (ctx) => [
      "Your complaint is private. Only you and the municipal officers dealing with it can see the details, the notes and the evidence.",
      "The public Transparency pages publish aggregate figures only — counts by category, ward and status. They never show names, phone numbers, email addresses, exact addresses or attachments.",
      `Groups smaller than ${ctx.kb.minGroup} are suppressed, so a figure cannot be traced back to a single person.`,
      "If you file while signed in, the complaint is tied to your account so you can track it; without signing in you can still track it using the reference number and your email address."
    ].join("\n\n")
  },
  {
    id: "account",
    keywords: ["register", "sign up", "signup", "create account", "login", "log in", "sign in", "password", "forgot password", "my account", "profile", "change email"],
    answer: () => [
      "You can browse and track a complaint without an account, but signing in lets you see everything in one place.",
      bullets([
        "Register with your email address and a password from the Register page.",
        "Sign in from the Login page; you stay signed in on this device.",
        "Your details live under Profile, where you can update your name, phone number and address.",
        "If you have forgotten your password, contact the municipal office — an administrator can reset it for you."
      ]),
      "Filing while signed in is recommended: the complaint is linked to your account automatically."
    ].join("\n\n")
  },
  {
    id: "notifications",
    keywords: ["notification", "notify", "alert", "email alert", "sms", "informed", "updates by email", "tell me when", "get notified"],
    answer: () => [
      "You are kept informed at every stage:",
      bullets([
        "Every status change adds an entry to your in-app notifications, visible from the bell in the header.",
        "The portal also sends email alerts to the citizen, the assigned officer and the department mailbox when an address is configured.",
        "Inbound replies are matched by the reference number in the subject, so replying to an alert email adds your message to the complaint record."
      ]),
      "Make sure your email address is correct under Profile, otherwise alerts cannot reach you."
    ].join("\n\n")
  },
  {
    id: "contact",
    keywords: ["contact", "phone number", "helpline", "office", "address", "email address", "office hours", "visit", "reach you", "talk to someone", "complaint against staff", "escalate to human"],
    answer: (ctx) => {
      const kb = ctx.kb;
      const officeLines = (kb.offices || []).map((office) => {
        const details = [office.address, office.phone, office.email, office.office_hours]
          .filter((value) => value && !/not configured/i.test(String(value)));
        return details.length ? `${office.name} — ${details.join(" · ")}` : null;
      });
      const usable = officeLines.filter(Boolean);
      return [
        usable.length
          ? bullets(usable)
          : "The municipal office contact details have not been published on this portal yet, so I cannot give you a verified phone number or address. Please use the Contact page, which an administrator keeps up to date.",
        "For anything about a specific complaint, quote its reference number — it lets the office find the record immediately.",
        "If a complaint has passed its target date with no action, the escalation process routes it to the review queue automatically."
      ]
        .filter(Boolean)
        .join("\n\n");
    }
  },
  {
    id: "location",
    keywords: ["location", "gps", "map", "coordinates", "pin", "address of the problem", "where is the problem", "latitude"],
    answer: () => [
      "When you file, the portal asks for the location of the problem, because a department cannot act on \"somewhere in the city\".",
      bullets([
        "Use the map to place the pin exactly where the problem is.",
        "Or allow the browser to use your current position if you are standing at the spot.",
        "Add a landmark in the description — \"opposite the bus stand\" — for extra clarity.",
        "The coordinates also let the portal detect duplicates nearby and group reports by ward."
      ])
    ].join("\n\n")
  },
  {
    id: "rejected",
    keywords: ["rejected", "why was it rejected", "refused", "not accepted", "invalid complaint", "declined"],
    answer: () => [
      "A complaint is rejected when it is not something the municipality can act on, or when it clearly does not belong to the service chosen.",
      "The reason is always recorded on the complaint and shown to you in its timeline.",
      "If you disagree, you can submit a reopen request and a reviewer will look at it again — you do not need to file a duplicate."
    ].join("\n\n")
  },
  {
    id: "pay_bills",
    keywords: ["pay bill", "pay bills", "pay_bills", "pay electricity bill", "pay water bill", "pay property tax", "bill payment", "pay my bills", "pay online", "online payment", "electricity payment", "water payment", "property tax payment"],
    answer: (ctx) => {
      const parts = [
        "You can pay your municipal bills online from the Dashboard:",
        bullets([
          "Sign in, then open Dashboard → My payments",
          "View all your pending bills (Electricity, Water, Property Tax)",
          "Click \"Pay Now\" on any bill to open the secure payment modal",
          "Choose your payment method (UPI, Card, Net Banking)",
          "Confirm the amount and complete the payment",
          "A receipt is generated instantly with a transaction reference"
        ])
      ];

      if (ctx.user) {
        parts.push("Your pending bills are listed under Dashboard → My payments tab. You can also see your payment history and download receipts there.");
      } else {
        parts.push("You need to sign in first to see your bills and make payments. Once signed in, your bills will appear automatically.");
      }

      return parts.join("\n\n");
    }
  },
  {
    id: "file_complaint",
    keywords: ["file complaint", "file a complaint", "file_complaint", "report issue", "report problem", "lodge complaint", "new complaint", "register complaint", "submit complaint", "how to complain", "make complaint", "complaint registration"],
    answer: (ctx) => {
      const steps = [
        "Sign in, or register with your email address — a complaint is linked to your account so you can track it.",
        "Open Complaints and choose File a complaint.",
        "Pick the category and then the exact service, so it is routed to the right department automatically.",
        "Describe what is wrong and where, in plain language.",
        "Pin the location on the map, or use your device's position. The coordinates let the department find the spot.",
        "Attach a photo or a short video as evidence — this is optional but it speeds up verification.",
        "Submit. You receive a reference number in the form CMP-2026-000123."
      ];
      const suffix = ctx.topic
        ? `For ${ctx.topic.item.name}, choose the category "${ctx.topic.item.category_name || ctx.topic.item.name}".`
        : "";
      return [
        "Filing a complaint takes about two minutes:",
        steps.map((step, index) => `${index + 1}. ${step}`).join("\n"),
        suffix,
        "Would you like me to open the complaint form for you?"
      ].join("\n\n");
    }
  },
  {
    id: "service_application",
    keywords: ["apply for", "service application", "service_application", "birth certificate", "death certificate", "certificate application", "marriage registration", "apply online", "online application", "municipal services", "apply for certificate", "application form"],
    answer: (ctx) => {
      const kb = ctx.kb;
      const applicable = kb.subcategories.filter((sub) => sub.item_type === "application");
      const information = kb.subcategories.filter((sub) => sub.item_type === "information");
      const serviceCategories = kb.categories
        .filter((category) => category.kind && category.kind !== "complaint")
        .map((category) => category.name);

      return [
        "Besides complaints, the portal handles service requests and information.",
        serviceCategories.length
          ? `Service categories: ${serviceCategories.join(", ")}.`
          : "",
        applicable.length
          ? `${applicable.length} service${applicable.length === 1 ? "" : "s"} accept an online application. You submit them from Services and receive a reference number in the form APP-2026-000045 to track progress.`
          : "",
        information.length
          ? `${information.length} service${information.length === 1 ? "" : "s"} provide guidance only — they explain a process and do not accept a submission.`
          : "",
        applicable.length
          ? `Examples: ${applicable.slice(0, 5).map((sub) => sub.name).join(", ")}.`
          : "",
        "Popular services: Birth certificate, Death certificate, Marriage registration, Property certificates.",
        "Ask me about any specific service and I will tell you who handles it and what to prepare."
      ].filter(Boolean).join("\n\n");
    }
  },
  {
    id: "track_complaint",
    keywords: ["track complaint", "track my complaint", "track_complaint", "check status", "complaint status", "reference number", "where is my complaint", "what happened to my complaint", "follow up", "cmp-", "status of my complaint", "latest update", "track application", "app-"],
    answer: (ctx) => {
      const reference = String(ctx.question || "").match(/\b(?:CMP|APP)-\d{4}-\d{4,8}\b/i);
      const parts = [];
      if (reference) {
        parts.push(`Open the Track complaint page, enter ${reference[0].toUpperCase()} and your registered email address, and you will see the full timeline: every status change, the assigned department, notes and any evidence.`);
      } else {
        parts.push("Open the Track complaint page and enter your reference number. Reference numbers look like CMP-2026-000123 for a complaint and APP-2026-000045 for a service application.");
      }
      parts.push(
        ctx.user
          ? "Because you are signed in, everything you filed is also listed under Dashboard → My complaints, with the current status and the internal target date."
          : "If you sign in with the same email address you used when filing, the complaint also appears under Dashboard → My complaints."
      );
      if (ctx.kb && ctx.kb.counts.total) {
        parts.push(`The portal currently holds ${ctx.kb.counts.total} complaint record(s), of which ${ctx.kb.counts.open} are still open.`);
      }
      return parts.join("\n\n");
    }
  },
  {
    id: "quick_actions",
    keywords: ["what can you do", "what are my options", "quick actions", "quick_actions", "help me", "options", "menu", "show me options", "what now", "next steps"],
    answer: (ctx) => {
      const actions = [
        { label: "File a Complaint", action: "file_complaint", data: {} },
        { label: "Track Complaint", action: "track_complaint", data: {} },
        { label: "Apply for Service", action: "service_application", data: {} },
        { label: "Pay Bills", action: "pay_bills", data: {} },
        { label: "View Dashboard", action: "nav_dashboard", data: {} },
        { label: "Contact Municipality", action: "nav_contact", data: {} }
      ];

      return {
        response: "Here are the main things I can help you with:",
        actions: actions
      };
    }
  },
  {
    id: "nav_dashboard",
    keywords: ["dashboard", "my dashboard", "go to dashboard", "open dashboard"],
    answer: (ctx) => {
      if (!ctx.user) return "Please sign in first to access your dashboard. Once signed in, your dashboard shows your complaints, applications, bills and notifications in one place.";
      return "Your dashboard is at the top navigation → Dashboard. It shows your complaints, applications, bills, notifications and profile all in one place.";
    }
  },
  {
    id: "nav_contact",
    keywords: ["contact", "contact us", "municipal office", "phone number", "address", "email", "helpline", "contact municipality"],
    answer: (ctx) => {
      return [
        "You can contact the Municipal Corporation through:",
        bullets([
          "General enquiries: 1800-000-000 (toll free)",
          "Complaint helpline: 1800-000-111",
          "Emergency services: 112",
          "Office hours: Monday to Saturday, 10:00 to 17:30"
        ]),
        "For anything about a specific complaint, quote its reference number — it lets the office find the record immediately."
      ].join("\n\n");
    }
  },
  {
    id: "language",
    keywords: ["language", "hindi", "marathi", "regional language", "english only", "translate"],
    answer: () => "CivilBot answers in English only at the moment. You are welcome to write your complaint description in the language you are most comfortable with — officers read the original text."
  }
];

// Keywords are matched on word boundaries, not as raw substrings. Without this
// the greeting "hi" also fired inside "hindi" and "this", so a question about
// languages was answered with a greeting.
function keywordMatches(text, keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const lead = /^[a-z0-9]/.test(keyword) ? "(?<![a-z0-9])" : "";
  const trail = /[a-z0-9]$/.test(keyword) ? "(?![a-z0-9])" : "";
  return new RegExp(`${lead}${escaped}${trail}`).test(text);
}

function pickIntent(text, ctx) {
  let best = null;
  for (const intent of INTENTS) {
    let score = 0;
    let specificity = 0;
    for (const keyword of intent.keywords) {
      if (!keywordMatches(text, keyword)) continue;
      score += keyword.split(" ").length + (keyword.includes(" ") ? 1 : 0);
      specificity += keyword.length;
    }
    if (score === 0) continue;
    // Equal scores go to the intent that matched the longer, more specific
    // phrase rather than to whichever intent happens to sit first in the list.
    if (!best || score > best.score || (score === best.score && specificity > best.specificity)) {
      best = { intent, score, specificity };
    }
  }
  // A specific topic mention is a strong signal: describe it when nothing else matched.
  if (!best && ctx.topic) return null;
  return best ? best.intent : null;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
/**
 * Answers a question from the portal's own data.
 * Always resolves: returns { response, intent }.
 */
async function answer(question, context = {}) {
  const text = normalise(question);
  if (!text) {
    return { response: "Ask me about reporting a civic issue, tracking a complaint or the services on this portal.", intent: "empty" };
  }

  const kb = await loadKnowledge();
  const topic = findTopic(tokens(question), kb);
  const ctx = { kb, question: String(question || ""), topic, user: context.user || null };

  const intent = pickIntent(text, ctx);
  if (intent) {
    const response = await intent.answer(ctx);
    return { response, intent: intent.id };
  }

  if (topic) {
    const response =
      topic.type === "subcategory"
        ? describeSubcategory(topic.item)
        : describeCategory(topic.item, kb);
    return { response, intent: topic.type === "subcategory" ? "service_detail" : "category_detail" };
  }

  return {
    intent: "fallback",
    response: [
      "I could not match that to anything on the portal, and I would rather say so than invent an answer.",
      "Try asking me about:",
      bullets([
        "how to file a complaint",
        "a specific issue, such as potholes, garbage, streetlights or drainage",
        "what a complaint status means",
        "how long a complaint should take",
        "tracking a complaint with its reference number"
      ])
    ].join("\n\n")
  };
}

/** Clears the cached reference data; used after administrative edits. */
function invalidate() {
  cache = { at: 0, data: null };
}

module.exports = { answer, invalidate, loadKnowledge };
