# MEMORY.md — Long-Term Memory

> Rule: Only what I need in EVERY conversation. Details go in daily files.

## Abhishek & Pavisha
- **Company:** Pavisha PET Industries, Patna, Bihar
- **Products:** PET jars, bottles, cans, preforms, caps, accessories
- **GSTIN:** 10AENPK6359M3Z2 | Proprietor: Poonam Keshri
- **Goal:** AI to manage business — operations, research, communications, planning

## Active Projects
- **AutifyME** → Pivoting to OpenClaw-native skills (was LangChain/LangGraph)
  - Repo: `D:\openclaw` (github: openclaw/openclaw) — THIS is the working repo, NOT AutifyME
  - Master doc: `AutifyME/docs/REDESIGN_MASTER_DOCUMENT.md`
  - Whitepaper: `AutifyME/docs/whitepaper.md` (14 workflow domains, Agentic Business OS vision)
  - Backend: Supabase (project: badupjrwhiucpvnuwluc)
  - Vision: Platform for MILLIONS of businesses, not just Pavisha

### Database Skill ✅ DONE
- Location: `workspace/skills/database/` (SKILL.md, scripts/db_tool.py, references/)
- **--file flag**: model writes JSON file with `Write` tool, runs `python db_tool.py --file q.json` — zero escaping
- 38/38 regression on Sonnet, Haiku, AND free 11B model (StepFun Step 3.5 Flash)
- Merged to main, pushed to github

### Domain Architecture (UNDER DISCUSSION — NOT finalized)
- Abhishek wants: user message → classify intent into domain(s) → spawn specialist sub-agents per domain → each specialist uses domain-specific skills
- User roles (owner/employee/customer) affect domain access + action permissions
- Discussion so far explored: RLS for security, Supabase Auth for users, skill folders for domain knowledge, LLM for classification
- **Abhishek's feedback**: I overcomplicated with custom views/RPCs/registries — solutions must be GENERIC and scale to millions of businesses
- **NOT DECIDED YET** — more discussions needed before finalizing design
- Key docs to review: `AutifyME/docs/whitepaper.md` (14 domains, platform vision), `AutifyME/docs/REDESIGN_MASTER_DOCUMENT.md`

### OpenRouter
- API key configured in OpenClaw (`env.OPENROUTER_API_KEY`)
- Free models available: StepFun Step 3.5 Flash (11B active), Aurora Alpha, Arcee Trinity

## Priorities
1. Extract catalog protocols → product-cataloging skill (domain knowledge)
2. Set up Supabase Auth + profiles + generic RLS
3. Build domain routing in AGENTS.md (classification + orchestration patterns)
4. Connect Pavisha WhatsApp Business number to OpenClaw
5. Build image_gen.py (creative-production skill)
6. Migrate Pavisha website to use AutifyME schema
7. Claim Google Business profile

## System
- **PC:** ASRock B450 Steel Legend, Windows
- **OpenClaw:** Source at `D:\openclaw`, workspace at `D:\openclaw\workspace`
- **Auto-start:** Startup bat in Windows Startup folder
- **WhatsApp:** Active channel
- **GitHub CLI:** `C:\Program Files\GitHub CLI\gh.exe` (auth as akeshr)
