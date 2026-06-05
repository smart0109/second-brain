---
name: retry-failed-morning-tasks
description: Hourly 9am-12pm Mon-Fri: Check if each morning task produced its expected output (summary draft in Gmail). If any are missing, re-run that task's core logic. Catches failures and missed runs.
---

## Retry Orchestrator — Catch Failed Morning Tasks

You run hourly from 9am-12pm and verify that each morning task completed successfully today.
If any task failed or was missed, you re-run its core logic.

### How to check if a task ran successfully

Each morning task creates a summary Gmail draft to manish@basisvps.com when it completes.
Search for these drafts to verify completion:

```
gmail_search_messages query: "to:manish@basisvps.com subject:{expected_subject} newer_than:1d"
```

### Tasks to verify (in order)

| Task | Expected Subject Pattern | Scheduled Time |
|------|------------------------|----------------|
| competitive-signal-alerts | "Competitive Alerts" OR "Competitive Scan" | 7:15am |
| news-trigger-monitor | "Trigger Alerts" | 7:30am |
| morning-outreach-pipeline | "Morning Outreach Summary" | 7:45am |
| pre-meeting-prospect-prep | (check calendar prep email) | 8:10am |
| auto-follow-up-sequencer | "Follow-Up Sequencer" | 8:15am |
| draft-approval-queue | "Outreach Approval Queue" | 9:00am |

### Step 1: Check each task

For each task in the table, search Gmail (both drafts and sent) for the expected subject pattern with today's date.

If found -> task completed, skip.
If NOT found -> task likely failed or was missed. Log it and proceed to step 2.

### Step 2: Re-run failed tasks

For each task that appears to have NOT run:

**competitive-signal-alerts missing:**
- Pick 5 least-recently-scanned competitors per brand (Cadient + Vorro)
- Web search each for news, reviews, pricing, outages from last 14 days
- Score signals as RED/YELLOW/GREEN
- Create alert draft to manish@basisvps.com

**news-trigger-monitor missing:**
- Read MASTER files for A-tier companies
- Pick today's batch of 50 companies
- Web search each for funding, layoffs, exec changes, launches
- Create trigger drafts for HOT signals, log WARM/COOL
- Create summary draft

**morning-outreach-pipeline missing:**
- Search Gmail for Warmly notifications from last 24hrs
- Process visitors: route by site, dedup, research, create HTML drafts
- Search for HL7/FHIR job postings, create Vorro drafts for new companies
- Check MASTERs for A-tier prospects needing first outreach, create drafts (max 10/brand)
- Create summary draft

**auto-follow-up-sequencer missing:**
- Read MASTERs for prospects with "Stage X Sent" status, 5+ days old
- Check Gmail for replies (skip if replied)
- Research each company fresh via web search
- Create next-stage draft with personalized opener
- Max 15 drafts (5/brand)
- Create summary draft

**draft-approval-queue missing:**
- List all Gmail drafts created today
- Filter for outreach drafts (exclude reports/internal)
- Build consolidated HTML approval table
- Create approval draft to manish@basisvps.com

### Step 3: Report

If ANY tasks were retried, create draft to manish@basisvps.com:
Subject: "Retry Report -- {date} ({count} tasks retried)"
Body: which tasks were missing, what was re-run, results

If ALL tasks had already completed, do nothing (no email noise).

### Dedup safeguard
Before creating ANY draft in retry mode, always check if a draft to the same recipient with a similar subject already exists today. Never create duplicate outreach.

### HARD RULES
- This is a SAFETY NET, not a primary runner. Tasks should succeed on first try.
- Max 2 retry attempts per task per day (if this task runs at 9, 10, 11, 12 -- that's 4 checks, but only retry twice)
  Track attempts: if you already retried a task earlier today (check for "Retry Report" draft mentioning that task), skip it.
- NEVER send emails. Only create drafts.
- If MASTER files are inaccessible, log it and skip tasks that need them
- If Gmail MCP is down, there's nothing you can do -- just log and wait for next hour
