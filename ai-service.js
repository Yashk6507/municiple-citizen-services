const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db');
const civilbot = require('./lib/civilbot');

// The Claude client is created lazily and only when a real key is present.
// ANTHROPIC_API_KEY in a fresh checkout is a placeholder, and using it produced
// a hard 401 from the API, which is what made the assistant look broken.
const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

function anthropicApiKey() {
  const key = String(process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return null;
  if (/^(your|changeme|placeholder|demo|test|xxx)/i.test(key)) return null;
  if (/^sk-ant-api03-demo/i.test(key)) return null;
  return key.length >= 20 ? key : null;
}

let anthropicClient = null;
function anthropic() {
  const apiKey = anthropicApiKey();
  if (!apiKey) return null;
  if (!anthropicClient) anthropicClient = new Anthropic({ apiKey });
  return anthropicClient;
}

function anthropicEnabled() {
  return Boolean(anthropicApiKey());
}

/**
 * Analyze complaint for fake/spam detection and redundancy
 */
async function analyzeComplaint(complaint) {
  try {
    // Get recent similar complaints for redundancy check
    const recentComplaints = await getRecentSimilarComplaints(complaint.category);

    const prompt = `You are an AI assistant helping a municipal government detect fake, spam, or redundant complaints.

Analyze this complaint:
Category: ${complaint.category}
Description: ${complaint.description}
Location: ${complaint.location_text || 'Not specified'}

Recent similar complaints in the same category:
${recentComplaints.map((c, i) => `${i + 1}. "${c.description}" at ${c.location_text || 'location not specified'}`).join('\n')}

Provide analysis in this JSON format:
{
  "is_valid": boolean,
  "confidence_score": number (0-100),
  "issues": ["list of issues found"],
  "is_duplicate": boolean,
  "duplicate_of_id": number or null,
  "severity_level": "low" | "medium" | "high" | "critical",
  "category_accuracy": number (0-100),
  "suggested_category": "string or null",
  "priority_recommendation": "low" | "medium" | "high",
  "reasoning": "brief explanation"
}

Consider:
- Is the description coherent and detailed enough?
- Does it sound like spam or gibberish?
- Is it extremely similar to recent complaints (possible duplicate)?
- Does the severity match the description?
- Is the category appropriate for the description?`;

    const client = anthropic();
    if (!client) throw new Error('ANTHROPIC_API_KEY is not configured');

    const message = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    const responseText = message.content[0].text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const analysis = JSON.parse(jsonMatch[0]);
      return {
        success: true,
        analysis: {
          is_valid: analysis.is_valid !== false,
          confidence_score: analysis.confidence_score || 50,
          issues: analysis.issues || [],
          is_duplicate: analysis.is_duplicate || false,
          duplicate_of_id: analysis.duplicate_of_id || null,
          severity_level: analysis.severity_level || 'medium',
          category_accuracy: analysis.category_accuracy || 100,
          suggested_category: analysis.suggested_category || null,
          priority_recommendation: analysis.priority_recommendation || 'medium',
          reasoning: analysis.reasoning || 'Analysis completed',
          analyzed_at: new Date().toISOString()
        }
      };
    }

    return {
      success: true,
      analysis: {
        is_valid: true,
        confidence_score: 50,
        issues: [],
        reasoning: 'Could not parse AI response, marked as valid by default'
      }
    };
  } catch (error) {
    console.error('AI analysis error:', error.message);
    return {
      success: false,
      error: error.message,
      analysis: {
        is_valid: true,
        confidence_score: 50,
        issues: ['AI analysis unavailable'],
        reasoning: 'AI service error, marked as valid by default'
      }
    };
  }
}

/**
 * Get recent complaints in the same category for redundancy checking
 */
function getRecentSimilarComplaints(category) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT id, description, location_text, created_at
       FROM complaints
       WHERE category = ?
       ORDER BY created_at DESC
       LIMIT 5`,
      [category],
      (err, rows) => {
        if (err) {
          console.error('Error fetching similar complaints:', err);
          resolve([]);
        } else {
          resolve(rows || []);
        }
      }
    );
  });
}

/**
 * CivilBot — the portal's civic assistant.
 *
 * CivilBot answers from the portal's own live data (see lib/civilbot.js), so it
 * works with no API key, no network access and no cost. When a real Anthropic
 * key is configured, Claude is asked first for a more conversational reply and
 * CivilBot becomes the fallback, which means the assistant never returns a
 * "trouble connecting" message.
 */
function groundedSystemPrompt(kb) {
  const categories = kb.categories
    .map((category) => `- ${category.name}: ${category.description || ''}`.trim())
    .join('\n');
  const targets = ['critical', 'high', 'medium', 'low']
    .filter((priority) => kb.targets[priority])
    .map((priority) => `${priority} ${kb.targets[priority]}h`)
    .join(', ');

  return `You are CivilBot, the citizen assistant on a municipal civic issue portal in India.
You help citizens report civic issues, understand the process, and find out where their complaint has reached.

Only use the facts below. If something is not covered, say you do not know and point the citizen to the relevant page of the portal. Never invent a reference number, a phone number, a deadline or a department.

Complaint statuses: ${Object.keys(STATUS_HELP_FOR_PROMPT).join(', ')}.
Internal resolution targets: ${targets || 'not configured'}.

Categories on this portal:
${categories}

Departments: ${kb.departments.map((d) => d.name).join(', ')}.
Wards: ${kb.wards.length} wards.
Reference numbers: CMP-YYYY-NNNNNN for complaints, APP-YYYY-NNNNNN for service applications.

Be brief, warm and concrete — two to four sentences, or a short list when the citizen asks for steps. Use plain language, not bureaucratic jargon.`;
}

const STATUS_HELP_FOR_PROMPT = {
  Submitted: 'received, awaiting triage',
  'Under Review': 'being verified',
  Assigned: 'routed to a department',
  'In Progress': 'work has started',
  Resolved: 'marked resolved, awaiting citizen feedback',
  Rejected: 'not actioned, reason recorded',
  Reopened: 'citizen contested the resolution',
  Closed: 'final'
};

async function claudeReply(userMessage, conversationHistory, context) {
  const client = anthropic();
  if (!client) return null;
  const kb = await civilbot.loadKnowledge();
  const messages = [
    ...(Array.isArray(conversationHistory) ? conversationHistory : []),
    { role: 'user', content: String(userMessage) }
  ];
  const message = await client.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 600,
    system: groundedSystemPrompt(kb),
    messages: messages
  });
  const text = (message.content || [])
    .map((block) => (block && block.type === 'text' ? block.text : ''))
    .join('')
    .trim();
  return text || null;
}

async function getChatbotResponse(userMessage, conversationHistory = [], context = {}) {
  const question = String(userMessage || '').trim();

  if (anthropicEnabled()) {
    try {
      const reply = await claudeReply(question, conversationHistory, context);
      if (reply) return { success: true, source: 'claude', response: reply };
    } catch (error) {
      console.error('CivilBot Claude fallback:', error.message);
    }
  }

  try {
    const local = await civilbot.answer(question, {
      user: context.user,
      action: context.action,
      actionData: context.actionData
    });

    // Handle special response format with actions
    // civilbot returns { response: { response: "...", actions: [...] }, intent: "..." }
    // or { response: "...", intent: "..." }
    let responseText = local.response;
    let actions = null;
    let intent = local.intent;

    if (local && typeof local === 'object' && local.response && typeof local.response === 'object' && local.response.actions) {
      responseText = local.response.response;
      actions = local.response.actions;
    } else if (local && typeof local === 'object' && local.actions) {
      responseText = local.response;
      actions = local.actions;
    }

    return { success: true, source: 'civilbot', intent, response: responseText, actions };
  } catch (error) {
    console.error('CivilBot error:', error.message);
    return {
      success: false,
      source: 'civilbot',
      intent: 'error',
      response:
        'I cannot read the portal records at the moment, so I would rather not guess. Please try again shortly, or open the Complaints section to file or track your complaint directly.'
    };
  }
}

/**
 * Generate admin dashboard insights
 */
async function generateAdminInsights(stats) {
  try {
    const prompt = `Analyze this municipal complaint data and provide brief insights:

Statistics:
- Total Complaints: ${stats.total || 0}
- Pending: ${stats.pending || 0}
- In Progress: ${stats.inProgress || 0}
- Resolved: ${stats.resolved || 0}
- Resolution Rate: ${stats.total > 0 ? ((stats.resolved / stats.total) * 100).toFixed(1) : 0}%

By Category:
${stats.byCategory ? stats.byCategory.map(c => `- ${c.category}: ${c.count}`).join('\n') : 'No data'}

Provide a JSON response with:
{
  "key_insights": ["3-4 brief insights"],
  "recommendations": ["2-3 actionable recommendations"],
  "alert_areas": ["areas needing attention"],
  "performance_summary": "brief summary"
}`;

    const client = anthropic();
    if (!client) throw new Error('ANTHROPIC_API_KEY is not configured');

    const message = await client.messages.create({
      model: DEFAULT_MODEL,
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: prompt
      }]
    });

    const responseText = message.content[0].text;
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      return {
        success: true,
        insights: JSON.parse(jsonMatch[0])
      };
    }

    return {
      success: false,
      insights: {
        key_insights: ['AI insights temporarily unavailable'],
        recommendations: [],
        alert_areas: [],
        performance_summary: 'Data analysis pending'
      }
    };
  } catch (error) {
    console.error('Admin insights error:', error.message);
    return {
      success: false,
      error: error.message,
      insights: {
        key_insights: ['AI insights temporarily unavailable'],
        recommendations: [],
        alert_areas: []
      }
    };
  }
}

module.exports = {
  analyzeComplaint,
  getChatbotResponse,
  generateAdminInsights
};
