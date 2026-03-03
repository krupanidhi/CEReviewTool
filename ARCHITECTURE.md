# CE Review Tool — Architecture & End-to-End Guide

This document covers the **complete system** — from initial setup through rule generation, application processing, and result viewing. It is the single source of truth for how the system works.

---

## Table of Contents

1. [Quick Start — End-to-End](#1-quick-start--end-to-end)
2. [Folder Structure & Purpose](#2-folder-structure--purpose)
3. [Configuration](#3-configuration)
4. [Pipeline Overview](#4-pipeline-overview)
5. [Step 1: User Guide Extraction (DI — One-Time per FY)](#5-step-1-user-guide-extraction)
6. [Step 2: Rule Generation (AI — One-Time per FY)](#6-step-2-rule-generation)
7. [Step 3: Application Processing (Per Application)](#7-step-3-application-processing)
8. [Batch Processing](#8-batch-processing)
9. [Checklist Rules Engine](#9-checklist-rules-engine)
10. [SAAT Integration](#10-saat-integration)
11. [Application Index & Page Resolution](#11-application-index--page-resolution)
12. [AI Response Parsing](#12-ai-response-parsing)
13. [Logs](#13-logs)
14. [Troubleshooting](#14-troubleshooting)
15. [Azure Deployment](#15-azure-deployment)

---

## 1. Quick Start — End-to-End

### First-Time Setup for a New Fiscal Year (e.g., FY26)

```
STEP 1 — Place source files:
  userGuides/FY26/              ← Drop the User Guide PDF here
  checklistQuestions/FY26/      ← Drop Standard + Program-Specific checklist PDFs here
  SAAT/FY26/                    ← Drop the SAAT CSV export here
  applications/FY26/HRSA-26-xxx/ ← Drop application PDFs here

STEP 2 — Extract user guide (one-time, auto-cached):
  The user guide is extracted automatically on first use (batch or UI).
  Or manually: upload via the UI and it will be cached as *_extraction.json.

STEP 3 — Generate rules (one-time per FY):
  node server/scripts/generateRules.js FY26

STEP 4 — Start servers:
  cd server && node server.js          # CE server on port 3002
  cd client && npm run dev             # Client on port 5173

STEP 5 — Process applications:
  Option A: UI — Upload via browser at http://localhost:5173
  Option B: Batch — node server/scripts/combinedBatchProcess.js
```

### Re-Processing After Rule Changes

If you regenerate rules (Step 3), the server picks up the new JSON files **automatically on the next API call** — no restart needed for rule JSON changes. However, if `checklistRules.js` code was modified, **restart the CE server**.

---

## 2. Folder Structure & Purpose

```
CEReviewTool/
│
├── applications/                        # Application PDFs to process
│   └── FY26/
│       └── HRSA-26-002/
│           ├── Application-242645.pdf
│           └── Application-243284.pdf
│
├── userGuides/                          # User Guide PDFs (one per FY)
│   └── FY26/
│       ├── FY26 SAC Application User Guide_Approved.pdf        ← source PDF
│       ├── FY26 SAC Application User Guide_Approved_extraction.json  ← DI output (auto-cached)
│       └── FY26 SAC Application User Guide_Approved_structured.json  ← structured (auto-cached)
│
├── checklistQuestions/                  # Checklist questions + generated rules (per FY)
│   └── FY26/
│       ├── ProgramSpecificQuestions.pdf                  ← source checklist PDF
│       ├── ProgramSpecificQuestions_questions.json       ← extracted questions (from DI)
│       ├── ProgramSpecificRules.json                    ← AI-generated rules ★
│       ├── StandardChecklist.pdf                        ← source checklist PDF
│       ├── StandardChecklist_questions.json             ← extracted questions (from DI)
│       └── StandardRules.json                           ← AI-generated rules ★
│
├── SAAT/                                # SAAT CSV exports (one per FY)
│   └── FY26/
│       └── SAC-SAAT-Export-1720_02_06-2026.csv
│
├── data/                                # Default/fallback checklist question files
│   ├── ProgramSpecificQuestions.json
│   └── CE Standard Checklist_structured.json
│
├── processed-applications/              # Cached results → CE dashboard tiles
│   ├── index.json                      # Metadata index (all apps, with subdir field)
│   ├── FY25/
│   │   ├── HRSA-25-012/                # AI results for HRSA-25-012 applications
│   │   └── HRSA-25-016/
│   └── FY26/
│       ├── HRSA-26-002/
│       ├── HRSA-26-004/
│       ├── HRSA-26-005/
│       └── HRSA-26-006/
│
├── pf-results/                          # Prefunding review results (JSON, FY/NOFO hierarchy)
│   ├── FY24/
│   │   └── HRSA-24-066/
│   ├── FY25/
│   │   ├── HRSA-25-012/
│   │   ├── HRSA-25-013/
│   │   ├── HRSA-25-014/
│   │   ├── HRSA-25-016/
│   │   ├── HRSA-25-017/
│   │   └── HRSA-25-087/
│   └── FY26/
│       ├── HRSA-26-002/
│       ├── HRSA-26-004/
│       ├── HRSA-26-005/
│       └── HRSA-26-006/
├── extractions/                         # Azure DI extraction output (per uploaded doc)
├── documents/                           # Uploaded PDFs with UUID prefix + metadata JSON
├── stored-checklists/                   # Cached user guide extractions (legacy)
├── logs/                                # Processing log text files
├── cache/                               # Key-value pair cache
│
├── server/
│   ├── server.js                        # Express server entry point (port 3002)
│   ├── routes/
│   │   ├── admin.js                     # Admin utilities (cache clear, reindex)
│   │   ├── analyze.js                   # Document analysis API route
│   │   ├── applications.js              # Application file listing/browsing API
│   │   ├── chat.js                      # AI chat API route (context-aware Q&A)
│   │   ├── compare.js                   # Compliance comparison API route
│   │   ├── documents.js                 # Document upload/download/metadata API
│   │   ├── pfResults.js                 # Prefunding results list + fetch API
│   │   ├── pfReview.js                  # Prefunding compliance rules API
│   │   ├── processedApplications.js     # Dashboard cache CRUD routes
│   │   ├── qaComparison.js              # Checklist Q&A API (standard + program-specific)
│   │   ├── saat.js                      # SAAT data API (CSV loading, matching)
│   │   ├── settings.js                  # User settings API
│   │   ├── storedChecklists.js          # Stored checklist extraction API
│   │   └── upload.js                    # File upload handling API
│   ├── services/
│   │   ├── applicationProcessingService.js  # Processed app storage (FY/NOFO subdirs + index.json)
│   │   ├── cacheService.js              # Key-value pair cache service
│   │   ├── checklistRules.js            # Rules engine: condition eval, completeness check, page lookup
│   │   ├── checklistStorageService.js   # Checklist extraction storage
│   │   ├── documentIntelligence.js      # Azure Document Intelligence client
│   │   ├── enhancedDocumentIntelligence.js  # Enhanced DI with table/form extraction
│   │   ├── openAI.js                    # Azure OpenAI client wrapper
│   │   ├── pdfLinkExtractor.js          # PDF TOC hyperlink extraction
│   │   ├── saatService.js               # SAAT CSV loading, matching, summary builder
│   │   └── structuredDocumentTransformer.js # DI output → structured JSON transformer
│   └── scripts/
│       ├── combinedBatchProcess.js      # ★ Main batch entry point (CE + PF)
│       ├── combinedBatchCE.js           # CE review batch functions
│       ├── combinedBatchPF.js           # Prefunding review batch functions
│       ├── batchProcess.js              # Legacy standalone CE batch (interactive prompts)
│       ├── sharedExtraction.js          # Shared Azure DI extraction + format converters
│       ├── generateRules.js             # ★ AI rule generation (one-time per FY)
│       ├── reextractQuestions.js         # Re-extract _questions.json from checklist PDFs
│       ├── generateComparisonExcel.js   # ★ AI vs manual answer comparison Excel
│       ├── migrateProcessedApps.js      # One-time migration: flat processed-apps → FY/NOFO subdirs
│       ├── migratePfResults.js          # One-time migration: flat pf-results → FY/NOFO subdirs
│       ├── extractFY24Checklists.js     # FY24 checklist DI extraction (template)
│       ├── backfillChatData.js          # Backfill chat context for existing apps
│       ├── compare-all-results.js       # Debug: compare all cached results
│       ├── debugSaId.js                 # Debug: SA ID extraction troubleshooting
│       └── testQ10.js                   # Debug: test Q10 SAAT matching
│
├── client/
│   ├── src/
│   │   ├── App.jsx                      # Main app shell, routing, tab management
│   │   ├── services/api.js              # API client (all backend calls)
│   │   └── components/
│   │       ├── Dashboard.jsx            # Main dashboard with application tiles
│   │       ├── ComparisonWorkflow.jsx   # Compliance + checklist comparison orchestrator
│   │       ├── ChecklistComparison.jsx  # Checklist Q&A results display
│   │       ├── ChecklistSelector.jsx    # Checklist/section picker UI
│   │       ├── ComparisonReport.jsx     # Compliance comparison report
│   │       ├── EnhancedComparisonReport.jsx  # Enhanced compliance report with categories
│   │       ├── CategorizedComplianceReport.jsx # Categorized compliance view
│   │       ├── QAComparisonReport.jsx   # Q&A comparison results view
│   │       ├── ComparisonUpload.jsx     # Upload for comparison workflow
│   │       ├── EnhancedComparisonUpload.jsx  # Enhanced upload with preview
│   │       ├── DocumentUpload.jsx       # General document upload
│   │       ├── DocumentList.jsx         # Uploaded documents list
│   │       ├── AnalysisView.jsx         # Document analysis results
│   │       ├── ApplicationBrowser.jsx   # Browse applications by FY/NOFO
│   │       ├── ApplicationPageViewer.jsx # PDF page viewer with navigation
│   │       ├── SideBySideViewer.jsx     # Side-by-side document comparison
│   │       ├── BatchProcessor.jsx       # UI-based batch processing
│   │       ├── ChatInterface.jsx        # AI chat panel (context-aware)
│   │       ├── LogViewer.jsx            # Log viewer slide-out panel
│   │       ├── Settings.jsx             # Settings panel
│   │       ├── AdminModule.jsx          # Admin utilities UI
│   │       ├── PfUploadManual.jsx       # Prefunding: upload manual & extract rules
│   │       ├── PfAnalyzeApplication.jsx # Prefunding: analyze application
│   │       ├── PfCompareWithPO.jsx      # Prefunding: compare with program officer
│   │       └── PrefundingReviewResults.jsx # Prefunding: results display
│   └── vite.config.js                   # Dev server config (port 5173, proxy → 3002)
│
├── .env                                 # Azure credentials + config
└── ARCHITECTURE.md                      # This file
```

### Key Folder Purposes

| Folder | Purpose | When Created |
|--------|---------|--------------|
| `userGuides/FY26/` | Store User Guide PDF + auto-cached DI extraction | Manual (PDF), auto (JSON) |
| `checklistQuestions/FY26/` | Checklist PDFs, extracted questions, **generated rules** | Manual (PDF), auto (JSON) |
| `SAAT/FY26/` | SAAT CSV for service area validation (Q10-Q16) | Manual |
| `applications/` | Application PDFs organized by FY/NOFO | Manual |
| `processed-applications/` | Cached CE results displayed on dashboard, organized by `FY/NOFO/` | Auto (after processing) |
| `pf-results/` | Cached PF results displayed on PF dashboard, organized by `FY/NOFO/` | Auto (after batch PF) |
| `extractions/` | Raw DI output for uploaded application PDFs | Auto (after upload) |
| `documents/` | Uploaded PDFs with UUID prefix for page viewer | Auto (after upload) |

---

## 3. Configuration

### Environment Variables (`.env`)

```env
# Azure Document Intelligence (for PDF extraction)
VITE_AZURE_DOC_ENDPOINT=https://your-di-resource.cognitiveservices.azure.com
VITE_AZURE_DOC_KEY=your-di-key

# Azure OpenAI (for AI-based rule generation and question answering)
VITE_AZURE_OPENAI_ENDPOINT=https://your-openai-resource.openai.azure.com
VITE_AZURE_OPENAI_KEY=your-openai-key
VITE_AZURE_OPENAI_DEPLOYMENT=gpt-4o         # deployment name

# Server URLs
BATCH_SERVER_URL=http://localhost:3002       # CE server (used by batch scripts)
BACKEND_URL=http://localhost:3001            # Prefunding backend (optional)
```

### Ports

| Service | Port | Config |
|---------|------|--------|
| CE Server | 3002 | `server/server.js` (or `.env PORT=3002`) |
| Client (Vite) | 5173 | `client/vite.config.js` |
| Prefunding Backend | 3001 | Separate project |

### Fiscal Year Auto-Detection

The system extracts `HRSA-XX-NNN` from the application PDF text → derives `FYXX` → resolves all paths:

| Detected | Derived FY | Resolves To |
|----------|-----------|-------------|
| `HRSA-26-002` | `FY26` | `userGuides/FY26/`, `checklistQuestions/FY26/`, `SAAT/FY26/` |
| `HRSA-27-001` | `FY27` | `userGuides/FY27/`, `checklistQuestions/FY27/`, `SAAT/FY27/` |

---

## 4. Pipeline Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    ONE-TIME SETUP (per Fiscal Year)                      │
│                                                                         │
│  User Guide PDF ──→ Azure DI ──→ _extraction.json (cached)             │
│                                       │                                 │
│  Checklist PDFs ──→ Azure DI ──→ _questions.json (cached)              │
│                                       │                                 │
│                          ┌────────────┴────────────┐                    │
│                          │   generateRules.js       │                   │
│                          │   (AI interprets User    │                   │
│                          │    Guide to derive rules)│                   │
│                          └────────────┬────────────┘                    │
│                                       │                                 │
│                          StandardRules.json + ProgramSpecificRules.json  │
│                          (cached — reused for ALL apps in this FY)      │
└─────────────────────────────────────────────────────────────────────────┘
                                        │
                                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    PER-APPLICATION PROCESSING                           │
│                                                                         │
│  Application PDF ──→ Azure DI ──→ extraction JSON                      │
│                                       │                                 │
│                          ┌────────────┴────────────┐                    │
│                          │   Rules Engine           │                   │
│                          │   (checklistRules.js)    │                   │
│                          │                          │                   │
│                          │   Loads rules from JSON  │                   │
│                          │   Evaluates conditions   │                   │
│                          │   Dispatches to strategy │                   │
│                          └────────────┬────────────┘                    │
│                                       │                                 │
│                          Checklist answers (Yes/No/N/A)                 │
│                          + Compliance report                            │
│                          → cached in processed-applications/            │
│                          → displayed on dashboard                       │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key insight**: DI extraction and rule generation happen **once per FY**. Only application processing happens per-application.

---

## 5. Step 1: User Guide Extraction

The User Guide PDF is extracted via Azure Document Intelligence **once** and cached as JSON.

### Automatic (during batch or UI processing)
The system checks for `userGuides/FY26/*_extraction.json`. If not found, it extracts the PDF automatically and caches the result.

### Manual (if needed)
Upload the User Guide PDF via the UI. The extraction is saved to `userGuides/FY26/` as:
- `*_extraction.json` — Raw DI output (sections, tables, key-value pairs)
- `*_structured.json` — Clean section-based format

### Extraction JSON Structure

```json
{
  "content": "full text content of the document",
  "pages": [
    {
      "pageNumber": 1,
      "lines": [{ "content": "line text", "boundingBox": [...] }],
      "words": [{ "content": "word", "confidence": 0.99 }],
      "selectionMarks": [{ "state": "selected" }]
    }
  ],
  "tableOfContents": [
    { "id": "section_1", "title": "1. Introduction...", "pageNumber": 2, "level": 1 }
  ],
  "sections": [
    {
      "title": "3.1.1.1 Completing Form 1A",
      "pageNumber": 15,
      "content": [{ "text": "paragraph text", "pageNumber": 15 }],
      "sectionNumber": "3.1.1.1",
      "sectionType": "requirement",
      "depth": 4
    }
  ],
  "tables": [...],
  "keyValuePairs": [...],
  "metadata": { "pageCount": 54, "analyzedAt": "2026-..." }
}
```

---

## 6. Step 2: Rule Generation

### What Are Rules?

Rules are JSON files that tell the system **how to answer each checklist question** — what to look for, where to look, what conditions apply, and what strategy to use. They are derived from the User Guide's actual compliance guidance.

### Command

```bash
# Generate BOTH standard and program-specific rules for FY26:
node server/scripts/generateRules.js FY26

# Standard rules only:
node server/scripts/generateRules.js FY26 --type standard

# Program-specific rules only:
node server/scripts/generateRules.js FY26 --type programspecific
```

### What It Reads

| Input | Path | Description |
|-------|------|-------------|
| User Guide extraction | `userGuides/FY26/*_extraction.json` | Raw text from DI (must exist) |
| Standard questions | `checklistQuestions/FY26/StandardChecklist_questions.json` | Extracted checklist questions |
| Program-specific questions | `checklistQuestions/FY26/ProgramSpecificQuestions_questions.json` | Extracted checklist questions |

### What It Produces

| Output | Path | Description |
|--------|------|-------------|
| Standard rules | `checklistQuestions/FY26/StandardRules.json` | Rules for standard checklist (Q1-Q2) |
| Program-specific rules | `checklistQuestions/FY26/ProgramSpecificRules.json` | Rules for program-specific checklist (Q1-Q22) |

### Standard Rules — Completeness Check (Q1)

The AI reads User Guide **section 2.3.2** and derives the attachment requirement matrix:

- **Always-required attachments** → `lookFor` array
- **Conditional attachments** → `conditionalAttachments` array with conditions:
  - `applicant_type: public_agency` — Public agency only (e.g., Attachment 6)
  - `applicant_status: new` — New applicants only (e.g., Attachment 8, 11)
  - `applicant_status: new_or_supplemental` — New + Supplemental only (e.g., Attachment 12)

### Validation Matrix

After generation, the script prints an **attachment requirement matrix** for human review:

```
  Attachment                              Type 1 (New)  Type 2 (CC)  Type 3 (Supp)
  ─────────────────────────────────────────────────────────────────────────────────
  Attachment 1: Service Area Map          Required      Required     Required
  Attachment 6: Co-Applicant Agreement    If PA         If PA        If PA
  Attachment 8: Articles of Incorporation Required      NOT req      NOT req
  Attachment 11: Evidence of Nonprofit    Required      NOT req      NOT req
  Attachment 12: Operational Plan         Required      NOT req      Required
```

**Always verify this matrix against User Guide section 2.3.2 before using the rules.**

### Program-Specific Rules — Answer Strategies

The AI assigns each question an `answerStrategy`:

| Strategy | Description | AI Required? |
|----------|-------------|-------------|
| `document_review` | Check if a document/attachment exists | No (deterministic) |
| `eligibility_check` | Verify entity eligibility from documents | Yes (focused pages) |
| `saat_compare` | Cross-reference application vs SAAT CSV data | Yes (AI + SAAT) |
| `completeness_check` | Check all required attachments are present | No (deterministic) |
| `prior_answers_summary` | Synthesize all prior answers for final determination | Yes (AI synthesis) |

### Rule JSON Structure

```json
{
  "questionNumber": 4,
  "question": "Does the application include Attachment 12: Operational Plan?",
  "answerStrategy": "document_review",
  "lookFor": ["Attachment 12: Operational Plan"],
  "complianceGuidance": "Required for Type 1 (New) and Type 3 (Supplemental)...",
  "condition": {
    "type": "applicant_status",
    "value": "new_or_supplemental",
    "naIfNot": true
  },
  "dependsOn": null,
  "description": "Checks for inclusion of Operational Plan."
}
```

---

## 7. Step 3: Application Processing

### Via UI (Single Application)

1. Open `http://localhost:5173`
2. Upload application PDF → Azure DI extracts it
3. Select user guide → system loads cached extraction
4. Run compliance comparison + checklist Q&A
5. Results appear on dashboard

### Via Batch (Multiple Applications)

See [Section 8: Batch Processing](#8-batch-processing).

### Processing Flow (Per Application)

```
Application PDF
  │
  ├─→ Azure DI extraction (pages, tables, forms)
  │
  ├─→ Build Application Index (formPageMap, formPageRanges)
  │     Maps every form/attachment to physical page numbers
  │
  ├─→ Detect applicant type (new/competing continuation/supplemental)
  │     Detect: isNew, isCompetingContinuation, isCompetingSupplement,
  │             isPublicAgency, isNonprofit
  │
  ├─→ Load rules for FY (from checklistQuestions/FY26/*Rules.json)
  │
  ├─→ For each checklist question:
  │     1. Evaluate CONDITION → N/A if not applicable
  │     2. Evaluate DEPENDENCY → N/A if prerequisite not met
  │     3. Dispatch to ANSWER STRATEGY:
  │        • document_review  → deterministic presence check
  │        • completeness_check → check all attachments (with conditions)
  │        • saat_compare     → AI + SAAT CSV data
  │        • eligibility_check / ai_focused → AI + targeted pages only
  │        • prior_answers_summary → AI synthesis of all prior answers
  │
  └─→ Cache results → Dashboard tile
```

---

## 8. Batch Processing

### Combined Batch (CE Review + Prefunding Review)

Extracts each application PDF **once** via Azure DI, then runs both reviews.

#### Files

| File | Purpose |
|------|---------|
| `server/scripts/combinedBatchProcess.js` | ★ Main batch entry point — orchestrates CE + PF reviews |
| `server/scripts/combinedBatchCE.js` | CE Review: user guide resolution, compliance, checklist Q&A |
| `server/scripts/combinedBatchPF.js` | Prefunding Review: section-by-section validation (retry/backoff for 429/500/502/503/504) |
| `server/scripts/batchProcess.js` | Legacy standalone CE batch (interactive prompts, pre-combined) |
| `server/scripts/sharedExtraction.js` | Shared Azure DI extraction + format converters |
| `server/scripts/generateRules.js` | ★ Generate `StandardRules.json` + `ProgramSpecificRules.json` from User Guide + questions |
| `server/scripts/reextractQuestions.js` | Re-extract `_questions.json` from checklist PDFs via OpenAI |
| `server/scripts/generateComparisonExcel.js` | ★ Compare AI answers vs manual review Excel |
| `server/scripts/migrateProcessedApps.js` | One-time migration: flat `processed-applications/` → `FY/NOFO/` subdirs |
| `server/scripts/migratePfResults.js` | One-time migration: flat `pf-results/` → `FY/NOFO/` subdirs |
| `server/scripts/extractFY24Checklists.js` | FY24 checklist DI extraction (template for new FYs) |
| `server/scripts/backfillChatData.js` | Backfill chat context data for existing processed apps |
| `server/scripts/compare-all-results.js` | Debug: compare all cached results |
| `server/scripts/debugSaId.js` | Debug: SA ID extraction troubleshooting |
| `server/scripts/testQ10.js` | Debug: test Q10 SAAT matching logic |

---

### Script Command Reference

#### `combinedBatchProcess.js` — Batch Processing

```bash
# Interactive (prompts for mode and scope):
node server/scripts/combinedBatchProcess.js

# Both CE + Prefunding:
node server/scripts/combinedBatchProcess.js --mode both

# CE Review only:
node server/scripts/combinedBatchProcess.js --mode ce-only

# Prefunding only:
node server/scripts/combinedBatchProcess.js --mode prefunding-only

# CE with specific scope:
node server/scripts/combinedBatchProcess.js --mode ce-only --ce-scope checklist-only
node server/scripts/combinedBatchProcess.js --mode ce-only --ce-scope compliance-only
node server/scripts/combinedBatchProcess.js --mode ce-only --ce-scope both

# Target a specific FY:
node server/scripts/combinedBatchProcess.js --folder FY26

# Target a specific FY + NOFO:
node server/scripts/combinedBatchProcess.js --folder FY26/HRSA-26-002

# Combined examples:
node server/scripts/combinedBatchProcess.js --mode ce-only --ce-scope checklist-only --folder FY26/HRSA-26-006
node server/scripts/combinedBatchProcess.js --mode both --folder FY25/HRSA-25-016

# Cleanup existing CE results before reprocessing FY24:
node server/scripts/combinedBatchProcess.js --mode ce-only --cleanup --folder FY24

# Cherry-pick reprocessing from a custom folder:
node server/scripts/combinedBatchProcess.js --mode ce-only --apps-dir reprocessapplications --folder FY26/HRSA-26-006

# Cherry-pick with auto-cleanup:
node server/scripts/combinedBatchProcess.js --mode ce-only --cleanup --apps-dir reprocessapplications --folder FY26/HRSA-26-006
```

| Flag | Values | Default | Description |
|------|--------|---------|-------------|
| `--mode` | `both`, `ce-only`, `prefunding-only` | Interactive prompt | Which reviews to run |
| `--ce-scope` | `both`, `checklist-only`, `compliance-only` | `both` | CE review scope (only with `--mode ce-only` or `--mode both`) |
| `--folder` | `FY26`, `FY26/HRSA-26-002` | All apps in `applications/` | Subfolder to process |
| `--apps-dir` | Relative path to CE_ROOT | `applications/` | Override applications root (e.g., `reprocessapplications`) |
| `--cleanup` | (flag) | Off | Auto-delete existing CE results for matching FY/NOFO before reprocessing |

**Prerequisites:** CE server running on port 3002, rules JSON generated, SAAT CSV in place.

**Reprocessing workflow (FY24 example):**
1. `node server/scripts/combinedBatchProcess.js --mode ce-only --cleanup --folder FY24`
2. `--cleanup` calls `DELETE /api/processed-applications/by-filter?fy=24` to remove old results
3. Batch then processes all PDFs in `applications/FY24/`

**Cherry-pick workflow:**
1. Copy selected PDFs into `reprocessapplications/FY26/HRSA-26-006/` (same FY/NOFO structure)
2. `node server/scripts/combinedBatchProcess.js --mode ce-only --cleanup --apps-dir reprocessapplications --folder FY26/HRSA-26-006`
3. `--cleanup` removes old CE results for that NOFO, then batch processes cherry-picked PDFs
4. Output goes to standard `processed-applications/FY26/HRSA-26-006/`

#### `batchProcess.js` — Legacy Standalone CE Batch

```bash
# Interactive (prompts for paths):
node server/scripts/batchProcess.js

# With explicit paths:
node server/scripts/batchProcess.js \
  --applications "applications/FY26/HRSA-26-004" \
  --userguides "userGuides" \
  --checklists "checklistQuestions" \
  --funding-opp "HRSA-26-004" \
  --year "2026"
```

| Flag | Description |
|------|-------------|
| `--applications` | Path to application PDFs folder |
| `--userguides` | Path to user guides root |
| `--checklists` | Path to checklist questions root |
| `--funding-opp` | Funding opportunity number (e.g., `HRSA-26-004`) |
| `--year` | Fiscal year (e.g., `2026`) |

#### `generateRules.js` — Rule Generation

```bash
# Generate BOTH standard + program-specific rules:
node server/scripts/generateRules.js FY26

# Standard rules only:
node server/scripts/generateRules.js FY26 --type standard

# Program-specific rules only:
node server/scripts/generateRules.js FY26 --type programspecific
```

| Argument | Required | Description |
|----------|----------|-------------|
| `FY26` (positional) | Yes | Fiscal year (e.g., `FY26`, `FY25`) |
| `--type` | No | `standard`, `programspecific`, or omit for both |

**Reads:** `userGuides/<FY>/*_extraction.json` + `checklistQuestions/<FY>/*_questions.json`
**Writes:** `checklistQuestions/<FY>/StandardRules.json` + `ProgramSpecificRules.json`

#### `reextractQuestions.js` — Re-Extract Checklist Questions

```bash
# Re-extract BOTH standard + program-specific questions:
node server/scripts/reextractQuestions.js FY26

# Standard only:
node server/scripts/reextractQuestions.js FY26 --type standard

# Program-specific only:
node server/scripts/reextractQuestions.js FY26 --type programspecific
```

| Argument | Required | Description |
|----------|----------|-------------|
| `FY26` (positional) | Yes | Fiscal year |
| `--type` | No | `standard`, `programspecific`, or omit for both |

**Reads:** `checklistQuestions/<FY>/*_extraction.json` (DI output)
**Writes:** `checklistQuestions/<FY>/*_questions.json` (deletes stale cache first)

#### `generateComparisonExcel.js` — AI vs Manual Comparison

```bash
# All FYs from a single Excel (no FY scoping on AI answers):
node server/scripts/generateComparisonExcel.js --source "checklistQuestions/FY26/Manual CE Review.xlsx"

# Scope AI answers to a specific FY:
node server/scripts/generateComparisonExcel.js --source "checklistQuestions/FY26/Manual CE Review.xlsx" --fy 26

# Auto-detect source Excel from FY folder (first .xlsx found):
node server/scripts/generateComparisonExcel.js --fy FY26

# Filter to a specific NOFO:
node server/scripts/generateComparisonExcel.js --source "checklistQuestions/FY26/Manual CE Review.xlsx" --fy 26 --nofo HRSA-26-006

# Filter to a single application by tracking number:
node server/scripts/generateComparisonExcel.js --fy FY26 --app 243164

# Custom output path:
node server/scripts/generateComparisonExcel.js --fy FY26 --output "checklistQuestions/FY26/HRSA-26-006_Comparison.xlsx"

# Combined: specific source + NOFO filter + custom output:
node server/scripts/generateComparisonExcel.js \
  --source "checklistQuestions/FY26/Manual CE Review.xlsx" \
  --fy 26 --nofo HRSA-26-006 \
  --output "checklistQuestions/FY26/HRSA-26-006_Comparison.xlsx"

# All FYs, all NOFOs, single application:
node server/scripts/generateComparisonExcel.js --source "checklistQuestions/AllYears.xlsx" --app 243164
```

| Flag | Required | Default | Description |
|------|----------|---------|-------------|
| `--source` | One of `--source` or `--fy` | — | Explicit path to manual review Excel |
| `--fy` | One of `--source` or `--fy` | — | Fiscal year (`FY26` or `26`). Auto-detects first `.xlsx` in `checklistQuestions/<FY>/` if `--source` not given. Scopes AI answer scan to `processed-applications/<FY>/` |
| `--nofo` | No | All NOFOs | Filter manual Excel rows by announcement number (e.g., `HRSA-26-006`) |
| `--app` | No | All apps | Filter to a single application tracking number (e.g., `243164`) |
| `--output` | No | `checklistQuestions/ChecklistComparision.xlsx` | Output Excel path |

**AI answer scan behavior:**
- With `--fy`: scans only `processed-applications/<FY>/` subdirs
- Without `--fy`: scans **all** `processed-applications/FY*/HRSA-*/` subdirs (all fiscal years)
- When both `_checklist_comparison.json` and `app_*.json` exist for the same tracking number, the **newest file by modification time** is used (ensures UI-reprocessed results override stale batch files)

#### `migrateProcessedApps.js` — One-Time Migration

```bash
# Dry run (preview what would be moved):
node server/scripts/migrateProcessedApps.js

# Apply migration (actually move files + update index.json):
node server/scripts/migrateProcessedApps.js --apply
```

| Flag | Description |
|------|-------------|
| (none) | Dry run — shows what would be moved, no changes |
| `--apply` | Actually move files and update `index.json` |

**3-pass detection:**
1. NOFO regex in filename (e.g., `HRSA-26-006` in `_checklist_comparison.json` files)
2. Tracking number lookup against `applications/` folder PDFs
3. `index.json` id lookup for truncated `app_*.json` filenames

#### `migratePfResults.js` — PF Results Migration (One-Time)

```bash
# Dry run (preview what would be moved):
node server/scripts/migratePfResults.js

# Apply migration (actually move files):
node server/scripts/migratePfResults.js --apply
```

| Flag | Description |
|------|-------------|
| (none) | Dry run — shows what would be moved, no changes |
| `--apply` | Actually move files into `FY/NOFO/` subdirs |

**3-pass detection:**
1. NOFO regex in filename (e.g., `HRSA-26-002_..._Application-242744.json`)
2. Tracking number lookup against `applications/` folder PDFs
3. `applicationNumber` field inside JSON content → tracking number lookup

#### Prerequisites

- **CE server must be running** on port 3002 (batch calls its API endpoints)
- **`_questions.json` must exist** for both standard and program-specific checklists (generated by `reextractQuestions.js` or auto-extracted on first API call)
- **Rules JSON must exist** for the FY being processed (generated by `generateRules.js` from questions + user guide)
- **SAAT CSV must exist** if processing program-specific questions Q10-Q16
- **`.env` must have correct `VITE_AZURE_OPENAI_KEY`** (no double `=`) for prefunding review

#### Batch Steps (Per Application)

1. **Extract** PDF via Azure DI (called once, shared between CE and PF)
2. **Convert** raw result to CE JSON format + Prefunding plain text format
3. **Auto-detect** Funding Opportunity Number (`HRSA-XX-NNN`) → derive FY
4. **CE Review** (if enabled):
   - Resolve user guide (load cached extraction or extract from PDF)
   - Run compliance comparison (single-call with chunked fallback)
   - Run checklist Q&A via `POST /api/qa-comparison/standard-analyze` and `/analyze`
   - Cache results → CE dashboard tile
5. **Prefunding Review** (if enabled):
   - Load compliance rules for detected year
   - Run all-sections validation via Azure OpenAI
   - Cache results → Prefunding dashboard tile

#### Dashboard Integration

| Review | Cache Location | Visible On |
|--------|---------------|------------|
| CE Review | `processed-applications/FY[xx]/HRSA-[xx]-[nnn]/` via `POST /api/processed-applications/save` | CE Dashboard (port 5173) |
| Prefunding | `pf-results/FY[xx]/HRSA-[xx]-[nnn]/` via `GET /api/pf-results/list` | PF Dashboard (port 5173, Pre-Funding Review tab) |

#### Processed Applications Storage

Results are stored in a **hierarchical FY/NOFO structure** under `processed-applications/`:

```
processed-applications/
  index.json                              ← metadata for ALL apps (in-memory Map on server)
  FY25/
    HRSA-25-012/
      app_<sanitized_name>_<timestamp>.json       ← compliance report
      <sanitized_name>_checklist_comparison.json  ← checklist Q&A results
    HRSA-25-016/
      ...
  FY26/
    HRSA-26-002/
      ...
    HRSA-26-006/
      ...
```

**How subdir is determined:**
- `applicationProcessingService.deriveSubdir(applicationName)` extracts `HRSA-XX-NNN` from the application name → `FY[XX]/HRSA-[XX]-[NNN]`
- Stored in `index.json` as `meta.subdir` field per entry
- Batch scripts (`combinedBatchCE.js`, `batchProcess.js`) also derive subdir when writing `_checklist_comparison.json` files

**How the UI retrieves data (no breaking changes):**

| UI Action | API Route | Service Method | File Path Resolution |
|-----------|-----------|---------------|---------------------|
| List tiles | `GET /api/processed-applications/` | `listApplications()` | In-memory Map (from `index.json`) — no file I/O |
| View results | `GET /api/processed-applications/:id` | `getApplication(id)` | `_resolveDataPath(id)` → checks `meta.subdir`, falls back to root |
| Save new | `POST /api/processed-applications/save` | `saveCompleted()` | `deriveSubdir()` → writes to `FY/NOFO/` subdir |
| Delete one | `DELETE /api/processed-applications/:id` | `deleteApplication(id)` | Tries subdir path first, then root (backward compat) |
| Delete by FY/NOFO | `DELETE /api/processed-applications/by-filter?fy=26&nofo=HRSA-26-006` | `deleteByFilter({fy,nofo})` | Deletes matching index entries + `app_*.json` + `_checklist_comparison.json`. CE-only (no pf-results/) |
| Delete all | `DELETE /api/processed-applications/all` | `deleteAllApplications()` | Tries both paths per entry |
| Chat | `GET /api/processed-applications/:id` | Same as View | Same resolution |

**Backward compatibility:** Old flat files (no `subdir` in index) are still found via root path fallback. New entries always get `subdir` automatically.

---

## 9. Checklist Rules Engine

### Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Checklist Question Input                         │
│  (loaded from checklistQuestions/FY26/*Rules.json)                  │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                    ┌──────▼──────┐
                    │  Condition  │  evaluateCondition()
                    │   Check     │  Is this question applicable?
                    └──────┬──────┘
                           │
              ┌────────────┼─── N/A (condition not met) → method: 'rules_condition'
              │            │
              │     ┌──────▼──────┐
              │     │ Dependency  │  Q11-Q15 depend on Q10=Yes
              │     │   Check     │
              │     └──────┬──────┘
              │            │
              │  ┌─────────┼─── N/A (dependency not met) → method: 'rules_dependency'
              │  │         │
              │  │  ┌──────▼──────────────────────────────────────────┐
              │  │  │         Answer Strategy Dispatch                 │
              │  │  │                                                  │
              │  │  │  'document_review'      → presence check    (no AI)
              │  │  │  'completeness_check'   → attachment matrix (no AI)
              │  │  │  'saat_compare'         → AI + SAAT data         │
              │  │  │  'eligibility_check'    → AI + focused pages     │
              │  │  │  'ai_focused'           → AI + focused pages     │
              │  │  │  'prior_answers_summary'→ AI synthesis of priors │
              │  │  └─────────────────────────────────────────────────┘
              │  │
              ▼  ▼
        ┌─────────────┐
        │   Results    │  Yes/No/N/A + evidence + reasoning + page refs
        └─────────────┘
```

### Condition Types

| Condition | Value | Meaning |
|-----------|-------|---------|
| `applicant_type` | `public_agency` | Only public agency applicants |
| `applicant_status` | `new` | Only Type 1 (New) applicants |
| `applicant_status` | `new_or_supplemental` | Type 1 (New) + Type 3 (Supplemental) |
| `applicant_status` | `new_or_competing` | New or competing supplement (legacy alias) |
| `funding_type` | `rph` | Only RPH funding requestors |
| `funding_type` | `hp_or_rph` | HP and/or RPH funding |

### Completeness Check (Standard Q1 / Program-Specific Q21)

Evaluates whether all required attachments are present:

1. Check `lookFor` array — these are **always required** for all applicant types
2. Check `conditionalAttachments` — each has a `condition` that determines applicability:
   - If condition met → check if attachment is present → Missing or Found
   - If condition not met → "Not required for this applicant"
3. Result: Yes (all present) / No (any missing) with detailed evidence

### Source Files

| File | Purpose |
|------|---------|
| `server/services/checklistRules.js` | Rules engine: loading, condition eval, completeness check, page lookup |
| `server/routes/qaComparison.js` | API routes: AI dispatch, SAAT batch, focused batch, response parsing |
| `server/services/saatService.js` | SAAT CSV loading, service area matching, summary builder |
| `server/services/pdfLinkExtractor.js` | PDF TOC hyperlink extraction for exact page destinations |

### Cross-Document Data Conflict Detection

Applications may contain **conflicting data** across different forms/pages (e.g., Project Abstract says SA ID 445 but Summary Page says SA ID 253). The system detects and flags these automatically.

#### How It Works

1. **Multi-source extraction** — Key data points are extracted from **every page** independently, not just the first match:
   - **Service Area ID** — from Summary Page, Form 1A, Project Abstract, etc.
   - **Patient Projection** — from Form 1A, Summary Page, Project Abstract, tables
   - **Funding Requested** — from SF-424A, Budget Narrative, Summary Page

2. **Source priority** — When multiple values are found, the highest-priority source wins:
   - SA ID: Summary Page > Form 1A > SF-424 > Project Abstract > Project Narrative
   - Patient Projection: Form 1A > Summary Page > Project Abstract
   - Funding: SF-424A > SF-424 > Budget Narrative > Summary Page

3. **Conflict detection** — If different values are found across pages, a `dataConflicts` entry is created with:
   - `field` — which data point (e.g., "Service Area ID")
   - `values` — all values found with their source form and page number
   - `selectedValue` / `selectedSource` — which value was chosen and why
   - `message` — human-readable conflict description

4. **SAAT matching with fallback** — If the primary SA ID doesn't match SAAT, the system tries **all alternate SA IDs** found in the application before giving up. If an alternate matches, it flags `saIdConflict` on the SAAT data.

5. **AI prompt injection** — All detected conflicts are included in the AI prompt so the model:
   - Acknowledges the conflict in its evidence
   - Notes which value was found on which page/form
   - Adds a "⚠️ DATA CONFLICT" warning in the evidence
   - Answers based on the best available data while flagging the inconsistency

6. **API response** — The `/api/qa-comparison/analyze` response includes:
   - `dataConflicts[]` — all detected conflicts
   - `applicantProfile.allServiceAreaIds[]` — every SA ID found with source/page
   - `applicantProfile.allPatientProjections[]` — every patient count with source/page
   - `applicantProfile.allFundingRequested[]` — every funding amount with source/page
   - `saatInfo.saIdConflict` — SA ID conflict details if SAAT matched on alternate

#### Example: SA ID Conflict

```
Application 242764:
  Project Abstract (page 6): SA ID 445  ← NOT in SAAT
  Summary Page (page 5):     SA ID 253  ← IS in SAAT

System behavior:
  1. Primary SA ID = 253 (Summary Page has higher priority)
  2. If primary doesn't match SAAT, tries alternate SA ID 445
  3. If 253 matches SAAT → Q10 = Yes, with conflict warning
  4. AI evidence includes: "⚠️ DATA CONFLICT: Project Abstract says 445, Summary Page says 253"
```

### Question Flow Summary (Program-Specific, 22 Questions)

| Q# | Strategy | Condition | What It Checks |
|----|----------|-----------|----------------|
| Q1 | `document_review` | — | Project Narrative exists |
| Q2 | `document_review` | Public agency only | Attachment 6 (Co-Applicant Agreement) |
| Q3 | `document_review` | New applicants only | Attachment 11 (Nonprofit/Agency Status) |
| Q4 | `document_review` | New/supplemental only | Attachment 12 (Operational Plan) |
| Q5 | `eligibility_check` | New applicants only | Entity type verification |
| Q6 | `eligibility_check` | — | Substantive role (not pass-through) |
| Q7 | `document_review` | — | All required primary health care services |
| Q8 | `document_review` | — | Form 5A: General Primary Medical Care |
| Q9 | `document_review` | — | Services accessible to all populations |
| Q10 | `saat_compare` | — | NOFO match + valid SAAT service area |
| Q11 | `saat_compare` | Q10=Yes | Patient target ≥ 75% of SAAT |
| Q12 | `saat_compare` | Q10=Yes | All SAAT service types proposed |
| Q13 | `saat_compare` | Q10=Yes | Funding ≤ SAAT total |
| Q14 | `saat_compare` | Q10=Yes | Funding distribution matches SAAT |
| Q15 | `saat_compare` | Q10=Yes | All SAAT population types served |
| Q16 | `saat_compare` | New/supplemental, Q10=Yes | Zip codes ≥ 75% of SAAT patients |
| Q17 | `document_review` | New/supplemental only | Full-time permanent site on Form 5B |
| Q18 | `document_review` | RPH funding only | Public housing resident consultation |
| Q19 | `document_review` | HP/RPH funding only | Supplement-not-supplant attestation |
| Q20 | `saat_compare` | Q11=Yes | Funding reduction if patients < 95% of target |
| Q21 | `prior_answers_summary` | — | Overall completeness (synthesizes Q1-Q20) |
| Q22 | `prior_answers_summary` | — | Overall eligibility (synthesizes Q1-Q21) |

---

## 10. SAAT Integration

The SAAT (Service Area Analysis Tool) CSV is loaded during program-specific Q&A to validate Q10-Q16.

**Path:** `SAAT/FY26/SAC-SAAT-Export-*.csv`

**API:** `GET /api/saat/data?fundingOpp=HRSA-26-004`

**CSV columns used:** `announcement_number`, `patient_target`, `total_funding`, `chc_funding`, `msaw_funding`, `hp_funding`, `rph_funding`, `service_type`, `zip`, `pct_patients`

| Question | SAAT Validation |
|----------|----------------|
| Q10 | NOFO matches AND valid service area from SAAT |
| Q11 | Form 1A patients ≥ 75% of SAAT `patient_target` |
| Q12 | Application proposes ALL `service_type` values from SAAT |
| Q13 | Annual SAC funding ≤ SAAT `total_funding` |
| Q14 | Funding distribution matches SAAT (CHC/MSAW/HP/RPH) |
| Q15 | All SAAT population types served |
| Q16 | Form 5B zip codes cover ≥ 75% of SAAT patient percentage |

---

## 11. Application Index & Page Resolution

### `buildApplicationIndex()`

Built once per application. Maps every form/attachment to physical page numbers.

**Three data structures:**

| Structure | Type | Purpose |
|-----------|------|---------|
| `formPageMap` | `Map<string, number>` | Form key → first physical page number |
| `formPageRanges` | `Map<string, {start, end}>` | Form key → full page range |
| `pages` | `Array<{pageNum, text}>` | All page text for extraction |

**Index building priority (highest to lowest):**

1. **PDF TOC hyperlinks** — Exact link destinations from the PDF's clickable TOC. Most accurate.
2. **Text-based TOC entries** — Parsed from TOC pages by matching `N. Name ... PageNum` patterns.
3. **Page header scanning** — Fallback: scan each page's first few lines for form/attachment headers.
4. **Alias resolution** — Copy missing canonical keys from alternative names.

### Page Offset

HRSA application PDFs often have a cover page, so physical page 2 may show "Page Number: 1". The system detects this offset:
- **Backend:** `pageOffset` calculated from footer "Page Number: N" text
- **Frontend:** Badges display footer number, but navigate to physical page

### Page Reference Resolution

After AI returns evidence, page references are resolved **server-side** (not from AI page numbers):
1. Scan evidence text for form/attachment mentions
2. Look up each in `formPageRanges`
3. Include full page range for compact forms (≤5 pages), start page only for large sections
4. Cap at 5 page references per question

---

## 12. AI Response Parsing

The AI returns JSON arrays, but responses can be malformed. The parser (`parseAIResponse`) uses 5 fallback strategies:

1. **Direct parse** — Clean markdown fences, fix malformed `pageReferences`, then `JSON.parse`
2. **Regex array extraction** — Find `[...]` in the response and parse it
3. **Truncated JSON repair** — If braces unbalanced, truncate to last complete object
4. **Individual object extraction** — Regex-match each `{"questionNumber":...}` separately
5. **Failure** — Log raw response for debugging, return empty array

---

## 13. Logs

### UI Log Viewer
- Slide-out panel via green terminal button (bottom-right)
- Persisted to `localStorage` (max 500 entries, survives refresh)
- Filter by level: All / Info / Warn / Error
- Download as `.txt` file

### Server-Side Logs
- Auto-saved to `logs/` folder after each workflow
- Filename: `ce-review-logs_<timestamp>.txt`
- API: `POST /api/logs/save`, `GET /api/logs`

---

## 14. Troubleshooting

### Common Issues

| Problem | Cause | Fix |
|---------|-------|-----|
| "Rules file not found" | Rules not generated for this FY | Run `node server/scripts/generateRules.js FY26` |
| Q1 says "Missing: Attachment 8" for CC app | Old rules with wrong conditions | Regenerate rules: `node server/scripts/generateRules.js FY26 --type standard` |
| SAAT questions all N/A | Q10 answered No (service area not matched) | Check SAAT CSV exists in `SAAT/FY26/` and SA ID extraction |
| "User guide folder not found" | Missing user guide for this FY | Place PDF in `userGuides/FY26/` |
| Batch results differ from UI | TOC links not extracted in batch | Batch now extracts TOC links from PDF (fixed) |
| Dashboard shows stale results | Old cached results | Clear via dashboard "Clear All" button or delete files in `processed-applications/FY[xx]/HRSA-[xx]-[nnn]/` |

### After Changing Rules JSON

Rules JSON files are loaded **from disk on each API call** — no server restart needed. Just regenerate and re-process.

### After Changing `checklistRules.js` Code

Code changes require a **server restart** (kill and re-run `node server/server.js`).

### Regenerating Everything for a New FY

```bash
# ── Step 1: Place source files ──────────────────────────────────────────────
#    userGuides/FY27/*.pdf                          (User Guide PDF)
#    checklistQuestions/FY27/*.pdf                   (Standard + Program-Specific checklist PDFs)
#    SAAT/FY27/*.csv                                 (SAAT export — must be CSV, not XLSX)
#    applications/FY27/HRSA-27-xxx/*.pdf             (Application PDFs per NOFO)
#    AIPrefundingReview/data/27/compliance-rules.json (Prefunding rules, if running PF)

# ── Step 2: Extract checklist PDFs via Azure DI ─────────────────────────────
#    (one-time, if _extraction.json doesn't exist)
#    Upload checklist PDFs via UI, or adapt extractFY24Checklists.js for new FY.

# ── Step 3: Extract checklist questions via OpenAI ───────────────────────────
#    Reads _extraction.json → produces _questions.json (deletes stale cache first)
node server/scripts/reextractQuestions.js FY27
node server/scripts/reextractQuestions.js FY27 --type standard
node server/scripts/reextractQuestions.js FY27 --type programspecific

# ── Step 4: Generate rules from User Guide + questions ───────────────────────
#    Reads _questions.json + userGuides/FY27/*_extraction.json
#    Produces StandardRules.json + ProgramSpecificRules.json
node server/scripts/generateRules.js FY27
node server/scripts/generateRules.js FY27 --type standard
node server/scripts/generateRules.js FY27 --type programspecific

# ── Step 5: Verify the attachment matrix output matches the User Guide ───────

# ── Step 6: Start CE server ─────────────────────────────────────────────────
cd server && node server.js

# ── Step 7: Process applications (CE server must be running on port 3002) ────
node server/scripts/combinedBatchProcess.js --folder FY27
node server/scripts/combinedBatchProcess.js --mode ce-only --folder FY27/HRSA-27-001
node server/scripts/combinedBatchProcess.js --mode both --folder FY27

# ── Step 8: Generate comparison Excel (after manual review Excel is ready) ───
node server/scripts/generateComparisonExcel.js --fy FY27
node server/scripts/generateComparisonExcel.js --source "checklistQuestions/FY27/Manual CE Review.xlsx" --fy 27 --nofo HRSA-27-001
```

### Artifact Dependency Chain

```
Checklist PDF
  → Azure DI extraction → _extraction.json (raw text) + _structured.json
  → OpenAI extraction   → _questions.json (parsed questions with Recommendations)
  → generateRules.js    → StandardRules.json + ProgramSpecificRules.json

User Guide PDF
  → Azure DI extraction → _extraction.json (cached, used by rules + compliance)

Application PDF
  → Azure DI extraction → CE JSON + PF text (per-app, during batch)
  → TOC link extraction → formPageMap (per-app, during batch)
```

---

## 15. Azure Deployment

### Architecture

In production (Azure App Service), the app runs as a **single Node.js process** that:
1. Serves the built React SPA from `dist/` as static files
2. Handles all `/api/*` routes via Express (same `server/server.js`)
3. Falls back to `dist/index.html` for SPA client-side routing

### Deployment Files

| File | Purpose |
|------|---------|
| `server.js` (root) | Production entry point — imports `server/server.js`. Referenced by `web.config` |
| `web.config` | IIS/iisnode configuration — routes static files to `dist/`, all else to `server.js` |
| `.deployment` | Tells Kudu to use `deploy.cmd` |
| `deploy.cmd` | Kudu deployment script: installs deps, builds React, syncs to wwwroot |

### Deployment Steps

The `deploy.cmd` script runs these steps automatically on Azure:

1. Install **server** dependencies (`server/package.json` — production only)
2. Install **client** dependencies (`client/package.json` — includes devDeps for build)
3. Build React app (`npm run build` in `client/` → outputs to root `dist/`)
4. Install **root** dependencies (`package.json` — production only)
5. KuduSync to `wwwroot` (excludes `client/node_modules`, `client/src`, `.env`)

### Azure App Service Settings

These environment variables must be configured in **App Service → Configuration → Application settings**:

| Setting | Description |
|---------|-------------|
| `VITE_AZURE_DOC_ENDPOINT` | Azure Document Intelligence endpoint URL |
| `VITE_AZURE_DOC_KEY` | Azure Document Intelligence API key |
| `VITE_AZURE_OPENAI_ENDPOINT` | Azure OpenAI endpoint URL |
| `VITE_AZURE_OPENAI_KEY` | Azure OpenAI API key |
| `VITE_AZURE_OPENAI_DEPLOYMENT` | OpenAI model deployment name (e.g., `gpt-4`) |
| `WEBSITE_NODE_DEFAULT_VERSION` | Node.js version (e.g., `~20`) |
| `PORT` | (Auto-set by Azure) — server listens on this |

### Manual Zip Deployment

```bash
# 1. Build the client
cd client && npm run build && cd ..

# 2. Create deployment zip (exclude large/unnecessary folders)
#    Include: server/, dist/, server.js, web.config, .deployment, deploy.cmd, package.json
#    Exclude: node_modules/, client/node_modules/, .env, applications/, processed-applications/,
#             extractions/, documents/, logs/, pf-results/, pf-data/, userGuides/, checklistQuestions/

# 3. Upload zip via Azure Portal → App Service → Deployment Center
#    Or use Azure CLI:
az webapp deploy --resource-group <RG> --name <APP_NAME> --src-path deploy.zip --type zip
```

### What Gets Deployed vs What Stays Local

| Folder | Deployed? | Notes |
|--------|-----------|-------|
| `server/` | ✅ Yes | Express API + routes + services |
| `dist/` | ✅ Yes | Built React SPA (generated by `npm run build`) |
| `server.js` (root) | ✅ Yes | Production entry point |
| `web.config` | ✅ Yes | IIS configuration |
| `package.json` (root) | ✅ Yes | Root dependencies |
| `client/src/` | ❌ No | Source code — only `dist/` is needed |
| `client/node_modules/` | ❌ No | Dev deps — not needed at runtime |
| `applications/` | ❌ No | Large PDF storage — local only |
| `processed-applications/` | ❌ No | Cache — regenerated on Azure |
| `extractions/` | ❌ No | Cache — regenerated on Azure |
| `.env` | ❌ No | Secrets — use App Service settings instead |

