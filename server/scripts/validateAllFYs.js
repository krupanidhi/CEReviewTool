#!/usr/bin/env node
/**
 * validateAllFYs.js — Deep Cross-FY Validation Suite
 * Tests ALL data sources across ALL fiscal years before expensive DI/AI runs.
 * Usage: node server/scripts/validateAllFYs.js
 */
import fs from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const ROOT = join(__dirname, '../..')

let totalTests = 0, passed = 0, failed = 0, warnings = 0
const failures = [], warningList = []

function assert(cond, msg) { if (!cond) throw new Error(msg) }

async function testAsync(name, fn) {
  totalTests++
  try {
    const r = await fn()
    if (r === 'warn') { warnings++; warningList.push(name); console.log(`  ⚠️  ${name}`) }
    else { passed++; console.log(`  ✅ ${name}`) }
  } catch (err) {
    failed++; failures.push({ name, error: err.message })
    console.log(`  ❌ ${name}\n     → ${err.message}`)
  }
}

async function loadJSON(p) { return JSON.parse(await fs.readFile(p, 'utf-8')) }
async function fileExists(p) { try { await fs.access(p); return true } catch { return false } }

// ═══ SUITE 1: SAAT CSV Parsing ═══
async function testSAAT() {
  console.log('\n═══ SUITE 1: SAAT CSV Parsing ═══')
  const { loadSAATData } = await import('../services/saatService.js')
  const fys = {
    FY24: { ann: 'HRSA-24-066', min: 80 },
    FY25: { ann: 'HRSA-25-012', min: 50 },
    FY26: { ann: 'HRSA-26-002', min: 80 },
  }

  for (const [fy, cfg] of Object.entries(fys)) {
    console.log(`\n  ── ${fy} ──`)
    let data
    await testAsync(`${fy}: CSV loads`, async () => {
      data = await loadSAATData(fy, cfg.ann)
      assert(data.found, `Not found for ${cfg.ann}`)
    })
    if (!data) continue

    await testAsync(`${fy}: >= ${cfg.min} service areas`, async () => {
      assert(data.serviceAreas.length >= cfg.min, `Only ${data.serviceAreas.length}`)
    })
    await testAsync(`${fy}: All SAs have non-zero totalFunding`, async () => {
      const bad = data.serviceAreas.filter(sa => sa.totalFunding === 0)
      assert(bad.length === 0, `${bad.length} SAs have $0: ${bad.slice(0,3).map(s=>`SA ${s.id}`).join(', ')}`)
    })
    await testAsync(`${fy}: All SAs have non-zero patientTarget`, async () => {
      const bad = data.serviceAreas.filter(sa => sa.patientTarget === 0)
      assert(bad.length === 0, `${bad.length} SAs have 0 target: ${bad.slice(0,3).map(s=>`SA ${s.id}`).join(', ')}`)
    })
    await testAsync(`${fy}: Funding breakdown sums correctly`, async () => {
      const bad = data.serviceAreas.filter(sa => {
        const sum = sa.fundingBreakdown.chc + sa.fundingBreakdown.msaw + sa.fundingBreakdown.hp + sa.fundingBreakdown.rph
        return Math.abs(sum - sa.totalFunding) > 1
      })
      assert(bad.length === 0, `${bad.length} SAs mismatch: ${bad.slice(0,3).map(s=>`SA ${s.id}`).join(', ')}`)
    })
    await testAsync(`${fy}: All SAs have service types`, async () => {
      const bad = data.serviceAreas.filter(sa => sa.serviceTypes.length === 0)
      assert(bad.length === 0, `${bad.length} SAs have no service types`)
    })
    await testAsync(`${fy}: All SAs have zip codes`, async () => {
      const bad = data.serviceAreas.filter(sa => sa.totalZipCodes === 0)
      assert(bad.length === 0, `${bad.length} SAs have no zips`)
    })
    await testAsync(`${fy}: Zip pct_patients are valid (0-1)`, async () => {
      const bad = []
      for (const sa of data.serviceAreas) {
        for (const z of sa.zipDetails) {
          if (z.pctPatients > 1 || z.pctPatients < 0) bad.push(`SA${sa.id}:${z.zip}=${z.pctPatients}`)
        }
      }
      assert(bad.length === 0, `${bad.length} invalid: ${bad.slice(0,3).join(', ')}`)
    })

    if (fy === 'FY24') {
      await testAsync(`FY24: SA 005 ADELANTE = $6,629,484 / 73,222 patients`, async () => {
        const sa = data.serviceAreas.find(a => a.id === '005')
        assert(sa, 'SA 005 not found')
        assert(sa.totalFunding === 6629484, `Got $${sa.totalFunding}`)
        assert(sa.patientTarget === 73222, `Got ${sa.patientTarget}`)
        assert(sa.fundingBreakdown.chc === 5548215, `CHC=$${sa.fundingBreakdown.chc}`)
        assert(sa.fundingBreakdown.msaw === 1081269, `MSAW=$${sa.fundingBreakdown.msaw}`)
      })
    }
  }

  console.log('\n  ── Column Normalization ──')
  await testAsync('FY24: mhc→msaw normalization', async () => {
    const d = await loadSAATData('FY24', 'HRSA-24-066')
    assert(d.serviceAreas.some(sa => sa.fundingBreakdown.msaw > 0), 'No MSAW funding found')
  })
}

// ═══ SUITE 2: Checklist Rules JSON ═══
async function testRules() {
  console.log('\n═══ SUITE 2: Checklist Rules JSON ═══')
  const validStrats = ['document_review','eligibility_check','saat_compare','ai_focused','presence','completeness_check','prior_answers_summary']
  const validSaat = ['nofo_match','patient_target_75pct','service_types_match','funding_not_exceed','funding_distribution','population_types','zip_codes_75pct']

  for (const fy of ['FY24','FY25','FY26']) {
    for (const type of ['ProgramSpecificRules','StandardRules']) {
      const p = join(ROOT, 'checklistQuestions', fy, `${type}.json`)
      const label = `${fy}/${type}`
      console.log(`\n  ── ${label} ──`)

      let rules
      await testAsync(`${label}: valid JSON array`, async () => {
        assert(await fileExists(p), 'File not found')
        rules = await loadJSON(p)
        assert(Array.isArray(rules) && rules.length > 0, 'Empty or not array')
      })
      if (!rules) continue

      await testAsync(`${label}: all have questionNumber + answerStrategy`, async () => {
        const bad = rules.filter(r => !r.questionNumber || !r.answerStrategy)
        assert(bad.length === 0, `${bad.length} rules missing required fields`)
      })
      await testAsync(`${label}: sequential question numbers`, async () => {
        const nums = rules.map(r => r.questionNumber).sort((a,b) => a-b)
        for (let i = 0; i < nums.length - 1; i++)
          assert(nums[i+1] === nums[i]+1, `Gap: Q${nums[i]}→Q${nums[i+1]}`)
      })
      await testAsync(`${label}: valid answerStrategies`, async () => {
        const bad = rules.filter(r => !validStrats.includes(r.answerStrategy))
        assert(bad.length === 0, `Invalid: ${bad.map(r=>`Q${r.questionNumber}="${r.answerStrategy}"`).join(', ')}`)
      })
      await testAsync(`${label}: saat_compare rules have saatCheck`, async () => {
        const bad = rules.filter(r => r.answerStrategy === 'saat_compare' && !r.saatCheck)
        assert(bad.length === 0, `Missing saatCheck: ${bad.map(r=>`Q${r.questionNumber}`).join(', ')}`)
      })
      await testAsync(`${label}: valid saatCheck values`, async () => {
        const bad = rules.filter(r => r.saatCheck && !validSaat.includes(r.saatCheck))
        assert(bad.length === 0, `Invalid: ${bad.map(r=>`Q${r.questionNumber}="${r.saatCheck}"`).join(', ')}`)
      })
      await testAsync(`${label}: dependsOn refs valid Qs`, async () => {
        const allNums = new Set(rules.map(r => r.questionNumber))
        for (const r of rules) {
          if (!r.dependsOn) continue
          assert(allNums.has(r.dependsOn.question), `Q${r.questionNumber} depends on non-existent Q${r.dependsOn.question}`)
        }
      })
    }
  }
}

// ═══ SUITE 3: Cross-FY SAAT Question Mapping ═══
async function testCrossFY() {
  console.log('\n═══ SUITE 3: Cross-FY SAAT Question Mapping ═══')
  const required = ['nofo_match','patient_target_75pct','service_types_match','funding_not_exceed','funding_distribution']

  for (const fy of ['FY24','FY25','FY26']) {
    const rules = await loadJSON(join(ROOT, 'checklistQuestions', fy, 'ProgramSpecificRules.json'))
    await testAsync(`${fy}: has all required SAAT checks`, async () => {
      const have = new Set(rules.filter(r => r.saatCheck).map(r => r.saatCheck))
      const missing = required.filter(c => !have.has(c))
      assert(missing.length === 0, `Missing: ${missing.join(', ')}`)
    })

    await testAsync(`${fy}: SAAT dependency chain correct`, async () => {
      const nofoQ = rules.find(r => r.saatCheck === 'nofo_match')
      assert(nofoQ, 'No nofo_match question')
      const others = rules.filter(r => r.saatCheck && r.saatCheck !== 'nofo_match' && r.dependsOn)
      for (const r of others) {
        assert(r.dependsOn.question === nofoQ.questionNumber,
          `Q${r.questionNumber} depends on Q${r.dependsOn.question}, expected Q${nofoQ.questionNumber}`)
      }
    })
  }

  // FY24 has NO dependsOn on SAAT Qs — this is a known gap
  console.log('\n  ── FY24 Dependency Gap Check ──')
  await testAsync('FY24: SAAT questions have dependsOn (critical for skip logic)', async () => {
    const rules = await loadJSON(join(ROOT, 'checklistQuestions', 'FY24', 'ProgramSpecificRules.json'))
    const saatRules = rules.filter(r => r.saatCheck && r.saatCheck !== 'nofo_match')
    const noDep = saatRules.filter(r => !r.dependsOn)
    if (noDep.length > 0) {
      throw new Error(`${noDep.length} SAAT Qs missing dependsOn: ${noDep.map(r=>`Q${r.questionNumber}`).join(', ')} — will process even if NOFO doesn't match`)
    }
  })
}

// ═══ SUITE 4: User Guide + Data Files ═══
async function testDataFiles() {
  console.log('\n═══ SUITE 4: User Guide & Data Files ═══')
  for (const fy of ['FY24','FY25','FY26']) {
    console.log(`\n  ── ${fy} ──`)
    await testAsync(`${fy}: User guide PDF exists`, async () => {
      const dir = join(ROOT, 'userGuides', fy)
      const files = await fs.readdir(dir)
      assert(files.some(f => f.endsWith('.pdf')), 'No PDF in userGuides/' + fy)
    })
    await testAsync(`${fy}: User guide extraction JSON exists`, async () => {
      const dir = join(ROOT, 'userGuides', fy)
      const files = await fs.readdir(dir)
      assert(files.some(f => f.endsWith('_extraction.json')), 'No extraction JSON')
    })
    await testAsync(`${fy}: User guide structured JSON exists`, async () => {
      const dir = join(ROOT, 'userGuides', fy)
      const files = await fs.readdir(dir)
      assert(files.some(f => f.endsWith('_structured.json')), 'No structured JSON')
    })
    await testAsync(`${fy}: SAAT CSV exists`, async () => {
      const dir = join(ROOT, 'SAAT', fy)
      const files = await fs.readdir(dir)
      assert(files.some(f => f.endsWith('.csv')), 'No CSV in SAAT/' + fy)
    })
    await testAsync(`${fy}: Checklist questions extraction exists`, async () => {
      const dir = join(ROOT, 'checklistQuestions', fy)
      const files = await fs.readdir(dir)
      assert(files.some(f => f.includes('_questions.json')), 'No questions JSON')
    })
  }
}

// ═══ SUITE 5: Rule Loading via checklistRules.js ═══
async function testRuleLoading() {
  console.log('\n═══ SUITE 5: Rule Loading (checklistRules.js) ═══')
  const { loadRulesForFiscalYear } = await import('../services/checklistRules.js')

  for (const fy of ['FY24','FY25','FY26']) {
    for (const type of ['programspecific', 'standard']) {
      await testAsync(`${fy}/${type}: loadRulesForFiscalYear succeeds`, async () => {
        const rules = await loadRulesForFiscalYear(fy, type)
        assert(Array.isArray(rules) && rules.length > 0, 'Empty or failed')
      })
    }
  }
}

// ═══ SUITE 6: FY24 Population Type Label Mapping ═══
async function testPopulationLabels() {
  console.log('\n═══ SUITE 6: Population Type Label Consistency ═══')
  // FY24 uses MHC/HCH/PHPC, FY26 uses MSAW/HP/RPH. Rules must handle both.
  for (const fy of ['FY24','FY25','FY26']) {
    const rules = await loadJSON(join(ROOT, 'checklistQuestions', fy, 'ProgramSpecificRules.json'))
    await testAsync(`${fy}: funding_distribution rule has complianceGuidance`, async () => {
      const r = rules.find(r => r.saatCheck === 'funding_distribution')
      if (!r) return 'warn'
      assert(r.complianceGuidance && r.complianceGuidance.length > 50,
        `Q${r.questionNumber}: complianceGuidance too short or missing — AI won't know how to evaluate`)
    })
  }
}

// ═══ MAIN ═══
async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗')
  console.log('║  CE Review Tool — Cross-FY Data Validation Suite       ║')
  console.log('╚══════════════════════════════════════════════════════════╝')

  await testSAAT()
  await testRules()
  await testCrossFY()
  await testDataFiles()
  await testRuleLoading()
  await testPopulationLabels()

  console.log('\n' + '═'.repeat(60))
  console.log(`📊 Results: ${passed} passed, ${failed} failed, ${warnings} warnings (${totalTests} total)`)
  if (failures.length > 0) {
    console.log('\n❌ FAILURES:')
    failures.forEach(f => console.log(`   ${f.name}\n     → ${f.error}`))
  }
  if (warningList.length > 0) {
    console.log('\n⚠️  WARNINGS:')
    warningList.forEach(w => console.log(`   ${w}`))
  }
  console.log('═'.repeat(60))
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(err => { console.error('FATAL:', err); process.exit(1) })
