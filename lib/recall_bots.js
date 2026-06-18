// Per-user ownership of Recall.ai bots. Lets transcript/status reads be scoped to
// the user who launched the bot, so a shared (admin env) Recall key can't be used
// to read another user's transcripts by guessing bot IDs.
const db = require('./db');

async function record(userId, botId, meetingUrl) {
  if (!db.isConfigured() || !botId) return;
  await db.query(
    `INSERT INTO recall_bots (bot_id, user_id, meeting_url) VALUES ($1, $2, $3)
     ON CONFLICT (bot_id) DO NOTHING`,
    [String(botId), userId, meetingUrl || null]
  );
}

async function ownerOf(botId) {
  if (!db.isConfigured()) return null;
  const { rows } = await db.query(`SELECT user_id FROM recall_bots WHERE bot_id = $1`, [String(botId)]);
  return rows.length ? rows[0].user_id : null;
}

// Throw a 403/404-style error unless `userId` owns `botId`.
// Policy: when the DB is configured, an UNKNOWN bot is denied (can't prove ownership) —
// this is what makes a shared key safe. In dev (no DB) ownership is not enforced.
async function assertOwner(userId, botId) {
  if (!db.isConfigured()) return;
  const owner = await ownerOf(botId);
  if (owner == null) { const e = new Error('Bot not found.'); e.status = 404; throw e; }
  if (String(owner) !== String(userId)) { const e = new Error('Not authorized for this bot.'); e.status = 403; throw e; }
}

async function listForUser(userId) {
  if (!db.isConfigured()) return [];
  const { rows } = await db.query(`SELECT bot_id, meeting_url, created_at FROM recall_bots WHERE user_id = $1 ORDER BY created_at DESC`, [userId]);
  return rows;
}

module.exports = { record, ownerOf, assertOwner, listForUser };
