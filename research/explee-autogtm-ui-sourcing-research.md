# Explee / AutoGTM — UI & Sourcing Research
Compiled 2026-08-13 for Second Brain. Source: explee.com, explee.com/b2b-database, and press coverage (links at bottom). Browser screenshots weren't possible this session (Chrome extension + device bridge both disconnected), so this is built from fetched page content/copy, not visual captures.

## 1. What Explee/AutoGTM is
A fully automated outbound sales pipeline. You give it a website URL; in ~2 minutes it does market research, ICP definition, prospect discovery, contact verification, personalized cold email writing, sending, reply handling, and meeting booking — no human in the loop unless you want one.

## 2. UI structure (explee.com homepage)

**Header/nav:** Logo, Products, Pricing, Sign in — minimal, dark theme (#0f0f13).

**Hero:** Headline built around "AI agents that find, qualify, and email clients while you sleep." CTA is "$30 in free credits" (with a no-website fallback path). Social proof directly under the fold: G2 5.0 rating + client logos (Vivid, HotHawk, Zinit, Eightify).

**"We run the entire pipeline" — the core UI device.** This is the section worth stealing. It walks one real example (a wholesale silk flower business) through 6 steps, each rendered as a live-looking data artifact rather than a static screenshot:
1. Learns what you sell — competitor list with favicons (afloral.com, nearlynatural.com, etc.)
2. Figures out who buys it — a fit-scoring table (Event designers 92%, Wedding floral studios 88%, Wedding planners 85%, Country clubs 79%, Boutique hotels 74%)
3. Finds those exact people — a table of real-looking contacts (name, title, company, email)
4. Writes each a personal email — one full sample email shown inline
5. Handles replies and books meetings — a mini chat transcript ending in a calendar confirmation
6. Learns what works and doubles down — a campaign performance table with cost-per-lead and a "scaling" status tag

The effect: instead of telling you it's an AI agent, the page shows you the literal outputs (tables, emails, chat) as if you're watching the product run. That's the single biggest UI idea to borrow for the command center — replace feature bullets with "artifacts the pipeline actually produces."

**Differentiators strip:** "Three things nobody else has" — 536M person profiles on proprietary GPU infra, 0% claimed bounce/inbox-placement issue, pre-warmed domains from day one, $0.03/email pay-as-you-go.

**Testimonials:** rotating quotes, each with name/title/company/LinkedIn link. Tone is specific and operational ("it's capable of booking five to ten demos a week on its own") rather than generic praise.

**Pricing:** single visible tier — $30 to 1,000 emails to 2-8 warm leads / 1-2 meetings, CPL $1-$15. Deliberately simple, one CTA.

**FAQ:** accordion covering setup requirements, cost, sender domain/mailbox handling, spam prevention, how much control you have over outgoing copy, reply handling, importing existing leads, cold email legality.

**Footer:** Product links (AutoGTM, AI search, B2B Company Database "105M+", Google Maps Dataset "218M+", Lookalike Companies, Segments Explorer), then a full grid of regional database links (North America, Europe, APAC, SE Asia, LatAm, Middle East, CIS, Oceania, Africa) — this footer alone functions as an SEO/credibility surface. Legal footer: UK company (No. 15759064, VAT GB478208465), London address.

## 3. Sourcing structure (how they actually source data)

**Database scale:** 105M+ company profiles, 536M person profiles, 238 countries, 21 NACE industry sectors. Largest concentrations: US (22M+ companies), Germany (6M+), UK (6M+).

**Raw sources aggregated (4 channels):**
- 310M company websites (crawled)
- 74M LinkedIn company profiles
- 210M Google Maps places
- 100M+ business registry records

**Enrichment layer:** an AI ("deep-research agent") reads at least 5 web pages per company plus LinkedIn, Google Maps, and registry data, then generates an "Ultimate Business Profile" — i.e., the raw scrape is not what's sold; it's summarized/normalized by an LLM pass before it reaches the user.

**Refresh cycle:** full 4-week refresh.

**Field depth:** 93 fields, ~500+ datapoints/company, spanning firmographic (name, AI description, keywords, industry), segmentation (B2B/B2C score, startup probability, SaaS/AI relevance), geo, financial (headcount, revenue estimate — only 2.4% fill rate, funding), contact (email 29% fill, phone 30% fill, socials), web analytics (traffic, bounce), LinkedIn (employee count, hiring signals), Google Maps (branches, reviews), and tech stack (detected via DNS/site analysis).

**Agent architecture:** 7 autonomous AI agents work the pipeline end to end (research to ICP to discovery to verification to personalization to send to reply-handling), not a single monolithic bot. Claims 97% email deliverability, contact-level verification before send, integrations with calendars/CRMs/APIs.

**Pricing mechanics:** pay-as-you-go, $0.03/email, daily spend caps, $50 free credit on signup, no minimum commitment.

## 4. How this compares to your Cadient/Vorro/CV3 command center

Your socialcommandcentre.cadient.ai platform (per upload_to_command_center.py) is a brand-scoped prospect CRM — bulk import + paged read via /api/prospects, keyed by brand (cadient/vorro/cv3), with its own login/cookie auth. That's a fundamentally different layer of the stack than what Explee is showing on its marketing site:

- **Explee's site is selling a fully autonomous pipeline** (find to verify to write to send to book), monetized per-email. Your command center is the **system of record** for prospects your team (and your existing Apify/Evaboot/Warmly pipelines) already sourced — it's not trying to be the sourcing engine itself.
- **Where Explee is genuinely ahead:** the "show, don't tell" UI pattern (live artifacts instead of feature bullets), the sheer breadth of their raw data blend (web + LinkedIn + Maps + registries) unified into one profile, and the fully closed-loop autonomy (they also handle replies + booking, which your pipeline currently doesn't — yours is send/enrich-focused with human-reviewed Gmail drafts).
- **Where your setup is arguably stronger or safer for you specifically:** you already have brand-specific tone, testimonials, and asset control that a generic AI agent won't have out of the box; you're keeping humans in the loop on send (per your "Gmail DRAFTS only until I lift the pause" rule) which Explee explicitly does NOT do; and you're not paying per-email to a third party for data you could source more cheaply via your existing Apify/harvestapi/Evaboot stack (their blended cost benchmark ~$0.07/email all-in vs. Explee's $0.03/email — comparable, but yours stays first-party).
- **Fair "is it better" answer:** not categorically — it's a different product shape (fully autonomous, pay-per-email SaaS with its own database) vs. your setup (a controlled, multi-brand pipeline you own end-to-end, backed by your own enrichment stack and a human-approved send gate). The UI/UX polish and the "watch it work" demo pattern is the part worth copying into your command center; the "let it send unsupervised" part is not something you've wanted per your own draft-only rule.

## Sources
- AutoGTM by Explee — homepage: https://explee.com/
- Explee B2B Company Database: https://explee.com/b2b-database
- Explee launches AutoGTM AI Agent for outbound sales — TestingCatalog: https://www.testingcatalog.com/explee-launches-autogtm-ai-agent-for-outbound-sales/
- Discover Explee: Your AI Solution for Lead Generation — KeywordSearch: https://www.keywordsearch.com/blog/discover-explee-your-ai-lead-generation-solution
- Explee AI Reviews: Use Cases, Pricing & Alternatives — Futurepedia: https://www.futurepedia.io/tool/explee
