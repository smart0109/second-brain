# Second Brain Automations

Scheduled Claude tasks that power the Second Brain system. Each file is a SKILL.md defining an autonomous task that runs on a cron schedule via Cowork Scheduled Tasks.

## Automations

| # | Task ID | Schedule | Description |
|---|---------|----------|-------------|
| 1 | pre-meeting-prospect-prep | Weekday 6:00 AM + 12:00 PM | Scan calendar for external meetings, research attendees and companies, generate Gmail prep drafts with talking points and personalized HTML sales assets |
| 2 | morning-outreach-pipeline | Weekday 7:47 AM | Read prospect queue, draft Stage 1 LinkedIn DMs and Stage 2-5 campaign emails per the 5-stage sequence. Each team member signs their own outreach |
| 3 | email-draft-replies-hourly | Every 3 hours 8 AM-5 PM M-F | Scan inbox for unanswered threads, draft replies using Granola meeting context. Draft follow-up bumps for sent emails with no reply |
| 4 | morning-second-brain-digest | Weekday 7:00 AM | Morning digest with calendar, VIP unresponded threads, Granola action items, deals closing this week, team activity |
| 5 | meeting-outcome-router | Every 3 hours 10 AM-6 PM M-F | Pull Granola transcripts post-meeting, detect outcome (yes/maybe/no), log to second-brain REST API with next-action routing |
| 6 | retry-failed-morning-tasks | Hourly 9 AM-12 PM M-F | Verify each morning task produced its expected Gmail draft. Re-run any that failed or were missed |
| 7 | auto-follow-up-sequencer-v2 | Weekday 8:22 AM | Check sent campaign outreach for non-responses, draft next-stage follow-ups per the 5-stage sequence |
| 8 | csuite-change-monitor | Monday 7:00 AM | Scan customer and competitor companies for C-suite leadership changes via web search, create Gmail alert draft |

## Key Rules (all automations)

1. **DRAFT MODE ONLY** -- no automation sends emails. All output is Gmail drafts.
2. **No hallucination** -- if research returns nothing, mark as "pending", never invent data.
3. **Customer name protection** -- zero customer names in outreach. Use "one of our clients" etc.
4. **No em dashes, hyphens, or arrows** in generated message content.

## Source

These files are copies of the SKILL.md definitions from the Cowork Scheduled Tasks system at:
`C:\Users\manis\OneDrive - Wolters Kluwer\Documents 1\Claude\Scheduled\{taskId}\SKILL.md`
