---
name: meeting-outcome-router
description: Every 3hrs 10am-6pm Mon-Fri: After external meetings, pull Granola transcript, detect outcome (yes/maybe/no), auto-route: yes = create proposal draft with personalized attachments from Gmail/Drive, maybe = schedule 5-day follow-up, no = add to 90-day nurture.
---

<!-- TEAM_CONTEXT_POINTER_INJECTED -->
## Team context (load every run)

Authoritative team roster lives at `C:\Users\manis\social-selling-v4.1\social-selling-deploy\configs\team-config.json`. Read that file at the start of any task that needs team rosters, tier routing, or per-person email/full_name. Do NOT hardcode names from memory.

Quick reference (last verified 2026-05-02, may drift -- config.json is canonical):

- Cadient (11): Manish (CRO), Prateek (CTO), Thomas (Sr AE), Justin (Sr AE), Anshu (AE), Kyle (AE), Anjali (AE), Nida (BDR), Kashif (BDR), Akanksha (BDR), Pamela (BDR)
- Vorro (9): Manish (CRO), Scott (CTO), Terry (Sr AE), Shashank (BDR), Toiba (BDR), Gibran (BDR), Nida (BDR also), Kashif (BDR also), Rashmi (BDR)
- CV3 (2): Yara Chepa, Aakriti Nagpal (both @basisvectors.com)

Tier routing (cadient / vorro / cv3):
- Executive: [Manish,Thomas,Justin,Anshu,Kyle,Anjali] / [Manish,Terry] / [Yara,Aakriti]
- Technology: [Prateek,Thomas,Justin,Anshu,Kyle,Anjali] / [Scott,Terry] / [Yara,Aakriti]
- Senior: [Thomas,Justin,Anshu,Kyle,Anjali] / [Terry] / [Yara,Aakriti]
- General: [Nida,Kashif,Akanksha,Pamela] / [Nida,Kashif,Shashank,Toiba,Gibran,Rashmi] / [Yara,Aakriti]

## Authentication

The second-brain REST API requires Bearer token authentication. Before running this task:

1. Ensure the second-brain Node.js application is running (http://localhost:3001)
2. Obtain an API token from the second-brain authentication system or use the Granola meeting context (user_id from Granola will map to second-brain user)
3. Set environment variable: `export SECOND_BRAIN_API_TOKEN="<your_token_here>"`
4. All REST API calls include header: `Authorization: Bearer ${SECOND_BRAIN_API_TOKEN}`

If authentication fails (401 Unauthorized), verify the token is valid by testing: `curl -H "Authorization: Bearer <token>" http://localhost:3001/api/users/me`

## Meeting Outcome Router — Post-Meeting Auto-Routing

You detect meeting outcomes from Granola transcripts and auto-route to the right next action.

### Step 1: Find recent external meetings

Query Granola for meetings in the last 4 hours:
```
query_granola_meetings: query "meeting" from last 4 hours
```
Or use `list_meetings` and filter by time.

Filter for EXTERNAL meetings only (attendees outside @cadienttalent.com, @vorro.net, @basisvps.com, @basisvectors.com, @bridgegateintl.com, @commercev3.com, @cultureos.company).

Skip internal-only meetings.

### Step 2: Pull transcript and detect outcome

For each external meeting, get the transcript:
```
get_meeting_transcript: meeting_id
```

Analyze the transcript for outcome signals:

**YES signals** (prospect is moving forward):
- "Let's schedule a demo"
- "Send me a proposal"
- "What are the next steps?"
- "I'd like to loop in my team"
- "Can you send pricing?"
- "Let's do a pilot"
- "When can we start?"
- Agreement on timeline or deliverables

**MAYBE signals** (interested but not committed):
- "Let me think about it"
- "I need to check with my team"
- "Can you send more info?"
- "Interesting, but timing isn't right"
- "Let's reconnect in a few weeks"
- "I'll get back to you"
- No clear commitment either way

**NO signals** (not moving forward):
- "We just signed with [competitor]"
- "Not in the budget right now"
- "We're not looking at this"
- "Our contract doesn't expire until..."
- Polite decline or deflection
- Meeting ended without any next steps discussed

### Step 3: Log outcome to second-brain via REST API

For each external meeting with a detected outcome, create a note in the second-brain system linked to the prospect/contact.

**Extract key data from meeting:**
- meeting_id (UUID from Granola)
- meeting_date (timestamp)
- prospect_name, email, company (from attendees)
- outcome_type (YES/MAYBE/NO)
- detected_signals (comma-separated list of matching signal phrases)
- transcript_snippet (one key sentence from meeting)
- next_action_recommended (string describing what should happen next)
- brand (cadient or vorro, inferred from attendee domains)

**Implementation via REST API:**

1. **Find or create contact record** — POST to `/api/contacts`:
```
POST http://localhost:3001/api/contacts
Authorization: Bearer <SECOND_BRAIN_API_TOKEN>
Content-Type: application/json

{
  "name": "{prospect_name}",
  "email": "{prospect_email}",
  "company": "{prospect_company}",
  "source": "granola",
  "company_brand": "{brand}"
}
```
Capture the `contact_id` from the response.

2. **Create meeting outcome note** — POST to `/api/notes`:
```
POST http://localhost:3001/api/notes
Authorization: Bearer <SECOND_BRAIN_API_TOKEN>
Content-Type: application/json

{
  "title": "Meeting Outcome: {prospect_name} ({outcome_type})",
  "content": "Outcome: {outcome_type}\n\nDetected Signals: {detected_signals}\n\nKey Quote: \"{transcript_snippet}\"\n\nRecommended Next Action: {next_action_recommended}",
  "type": "meeting-outcome",
  "source": "granola",
  "source_id": "{meeting_id}"
}
```
Capture the `note_id` from the response.

3. **Link note to contact** — INSERT into note_contacts junction table:
```
INSERT INTO note_contacts (note_id, contact_id) VALUES ('{note_id}', '{contact_id}')
```
(If a REST endpoint exists for this, use it instead. Otherwise, use direct DB access to the linked second-brain SQLite database.)

**Outcome-specific next actions:**

- **YES outcomes**: "next_action_recommended" = "Create proposal draft with personalized attachments. Review SmartSuite case studies from company's industry vertical."
- **MAYBE outcomes**: "next_action_recommended" = "Schedule 5-day follow-up call. Send additional ROI calculators and competitive analysis."
- **NO outcomes**: "next_action_recommended" = "Add to 90-day nurture sequence. Revisit in Q3 when budget cycles reset."

**Do NOT create Gmail drafts, send emails, or create nurture queue files.**

### Step 4: Verify and report

After processing all meetings:
- Count outcomes by type (YES/MAYBE/NO)
- Count successful API calls vs failures
- Log any API errors or skipped meetings
- Record timestamp of run

**HARD RULES:**
- NO Gmail draft creation whatsoever
- NO email sending
- ONLY REST API calls to second-brain
- If transcript unavailable, skip the meeting
- If API unreachable (connection refused), skip and retry on next scheduled run
- If outcome unclear, default to MAYBE
- If contact creation fails, retry note creation (contact may already exist)
- Always include source_id=granola_meeting_id in note creation for traceability

## TRANSCRIPT FALLBACK (critical - read on every run)

The Granola MCP ``get_meeting_transcript`` tool returns "Transcripts are only available to paid Granola tiers" on the free tier. Discovered 2026-05-03. Workaround: read the LOCAL transcript cache directly.

### Local cache location

Windows: ``C:\Users\manis\AppData\Roaming\Granola\cache-v6.json`` (2.2 MB JSON, current schema as of 2026-05-03)
Older versions: cache-v3.json (no longer used by current Granola)

### Cache structure

``cache.state.transcripts`` is a dict keyed by meeting UUID. Each value is an array of transcript segments:
``{id, document_id, start_timestamp, end_timestamp, text, source (system/microphone), is_final, transcriber_user_id}``

``cache.state.documents`` is keyed by the same UUID and contains: title, notes_markdown (may be empty), notes_plain, people, google_calendar_event, etc.

### Fallback flow

1. Try ``query_granola_meetings`` with the meeting IDs first (works on free tier, returns AI summary)
2. If you need raw transcript text and ``get_meeting_transcript`` returns the paid-tier error, fall back to local cache:
   a. Read cache-v6.json
   b. Locate ``state.transcripts[meeting_id]``
   c. Sort segments by ``start_timestamp``
   d. Concatenate ``text`` fields with speaker source labels
3. If meeting_id not in local cache (only ~5 most recent meetings are cached locally), fall back to ``query_granola_meetings`` for AI summary only.

### Limitations

Only the most recent meetings (~5-15 depending on usage) are kept in local cache. Older meetings rely on the cloud API which requires the paid tier.
