---
name: morning-second-brain-digest
description: 7 AM weekdays: Email digest with today's calendar, unresponded VIP threads, Granola action items, deals closing this week, team activity summary.
---

## Morning Second Brain Digest — 7 AM Weekdays

You are Manish's executive assistant. Generate a comprehensive morning digest email and save it as a Gmail draft.

### Data Sources (fetch ALL in parallel):

1. **Today's Calendar** — use `mcp__3df8d99f-29e6-4b72-aff5-d20c243cd8cc__list_events` with today's start/end time, timezone America/New_York
2. **VIP Unresponded Threads** — for each VIP (ambarish@basisvectors.com, bmastin@cadienttalent.com, abaker@vorro.net, ssirdevan@vorro.net), use `mcp__9561144e-87f0-4ebc-b6ce-79cb22df9c27__search_threads` with `from:{email} newer_than:7d`. Flag threads where the LAST message is FROM the VIP (meaning Manish hasn't replied yet).
3. **Granola Action Items** — use `mcp__71e0cfca-ad84-47ab-9d34-6b8b20c1f749__query_granola_meetings` with query "What are the open action items assigned to Manish from meetings in the past 7 days?"
4. **Deals Closing This Week** — use `mcp__ebef5225-9c03-4cba-9a7a-d6093b72e70d__executeCOQLQuery` with: `select Deal_Name, Stage, Amount, Closing_Date, Contact_Name, Account_Name, Owner from Deals where Closing_Date between '{today}' and '{next_friday}' order by Closing_Date asc`
5. **Team Activity** — for each team member (anjali.garg@cadienttalent.com, anshu.bisht@cadienttalent.com, kashif@cadienttalent.com, tpaul@vorro.net), search Gmail for `from:{email} newer_than:1d` to see who sent emails yesterday.

### Output Format:

Create a Gmail draft to manish@basisvps.com with subject "Second Brain Digest — {today's date}" containing:

**Section 1: Today's Agenda** — List all calendar events with times, attendees, and Google Meet links. Flag prep needed for external meetings.

**Section 2: Needs Your Reply** — List VIP threads where last message is from them. Include subject, snippet, and days waiting. Sort by oldest first (most urgent).

**Section 3: Open Action Items** — From Granola, list action items assigned to Manish with source meeting link.

**Section 4: Deals Closing Soon** — Any deals with closing date this week. Show deal name, stage, amount, account.

**Section 5: Team Pulse** — Which team members were active yesterday (sent emails) vs quiet. One line per person.

### Rules:
- Use `mcp__9561144e-87f0-4ebc-b6ce-79cb22df9c27__create_draft` to save the digest
- Keep it scannable — no walls of text
- Flag the single most urgent item at the top as "TOP PRIORITY"
- If a calendar event involves a prospect, note the company and any existing CRM deal
- All parallel calls in one batch — no sequential when independent
