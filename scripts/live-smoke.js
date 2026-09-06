'use strict';

const { randomUUID } = require('node:crypto');
const { createPostgresPool } = require('../services/api/src/postgres-runtime');
const { createMappedDatabase } = require('../services/api/src/postgres-schema-mapping');
const { JudgmentPostgresRepository } = require('../services/api/src/judgment-postgres-repository');
const { JudicialWorkbenchService } = require('../services/api/src/judicial-workbench-service');

function createLiveSmokeConfig(env = process.env) {
  const databaseUrl = env.DATABASE_URL && String(env.DATABASE_URL).trim();
  if (!databaseUrl) {
    const error = new Error('DATABASE_URL is required for live Supabase smoke testing');
    error.code = 'DATABASE_URL_REQUIRED';
    throw error;
  }
  return Object.freeze({ databaseUrl, dbProfile: 'supabase_test' });
}

function pngDate(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Port_Moresby', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(value);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

async function seedFixture(db, ids, actor, scheduledStart, scheduledEnd) {
  await db.query(`INSERT INTO config.courts (court_id,court_code,court_name,court_type,status) VALUES ($1,$2,$3,'DISTRICT','ACTIVE')`, [ids.courtId, ids.courtCode, 'DCIECMS Live Smoke Court']);
  await db.query(`INSERT INTO case_mgmt.parties (party_id,court_id,party_type,display_name) VALUES ($1,$2,'PERSON','DCIECMS Smoke Filer')`, [ids.partyId, ids.courtId]);
  await db.query(`INSERT INTO registry.filings (filing_id,filing_reference,court_id,case_type_code,filer_party_id,status,created_by,created_at) VALUES ($1,$2,$3,'CIVIL',$4,'ACCEPTED',NULL,now())`, [ids.filingId, ids.filingReference, ids.courtId, ids.partyId]);
  await db.query(`INSERT INTO finance.fee_assessments (assessment_id,filing_id,court_id,amount_minor,currency,status,assessed_by_subject) VALUES ($1,$2,$3,1000,'PGK','PAID',$4)`, [ids.assessmentId, ids.filingId, ids.courtId, actor.userId]);
  await db.query(`INSERT INTO finance.payments (payment_id,assessment_id,court_id,amount_minor,currency,status,provider_reference,created_by_subject,confirmed_at,confirmed_by_subject) VALUES ($1,$2,$3,1000,'PGK','CONFIRMED',$4,$5,now(),$5)`, [ids.paymentId, ids.assessmentId, ids.courtId, ids.providerReference, actor.userId]);
  await db.query(`INSERT INTO case_mgmt.cases (case_id,case_number,filing_id,payment_id,court_id,case_type_code,status,opened_by_subject,opened_at,assigned_to_subject,assigned_by_subject,assigned_at) VALUES ($1,$2,$3,$4,$5,'CIVIL','ASSIGNED',$6,now(),$6,$6,now())`, [ids.caseId, ids.caseNumber, ids.filingId, ids.paymentId, ids.courtId, actor.userId]);
  await db.query(`INSERT INTO judicial.hearings (hearing_id,case_id,court_id,hearing_type,status,scheduled_start,scheduled_end,courtroom,scheduled_by_subject,created_at) VALUES ($1,$2,$3,'MENTION','SCHEDULED',$4,$5,'SMOKE-1',$6,now())`, [ids.hearingId, ids.caseId, ids.courtId, scheduledStart.toISOString(), scheduledEnd.toISOString(), actor.userId]);
}

async function runLiveSmoke(env = process.env) {
  const config = createLiveSmokeConfig(env);
  const pool = createPostgresPool({ connectionString: config.databaseUrl, ssl: { rejectUnauthorized: false }, applicationName: 'dciecms-live-smoke' });
  const client = await pool.connect();
  const mapped = createMappedDatabase(client, config.dbProfile);
  const repository = new JudgmentPostgresRepository(mapped);
  const service = new JudicialWorkbenchService({ repository });
  const token = randomUUID().slice(0, 8);
  const ids = {
    courtId: randomUUID(), partyId: randomUUID(), filingId: randomUUID(), assessmentId: randomUUID(),
    paymentId: randomUUID(), caseId: randomUUID(), hearingId: randomUUID(),
    courtCode: `SMK-${token}`, filingReference: `SMOKE-FIL-${token}`, providerReference: `SMOKE-PAY-${token}`, caseNumber: `SMK-CIVIL-2026-${token}`
  };
  const actor = Object.freeze({ userId: `smoke-mag-${token}`, roles: ['MAG'], courtIds: [ids.courtId] });
  const scheduledStart = new Date(Date.now() + 10 * 60 * 1000);
  const scheduledEnd = new Date(scheduledStart.getTime() + 30 * 60 * 1000);

  try {
    await client.query('BEGIN');
    await mapped.query('SELECT 1 AS connected');
    await seedFixture(mapped, ids, actor, scheduledStart, scheduledEnd);

    const myCases = await service.listMyCases(actor);
    if (!myCases.some((row) => row.caseId === ids.caseId)) throw new Error('My Cases smoke verification failed');

    const daily = await service.listDailyHearings(actor, { date: pngDate(scheduledStart) });
    if (!daily.some((row) => row.hearingId === ids.hearingId)) throw new Error('Daily Hearings smoke verification failed');

    const started = await service.startHearing(actor, ids.hearingId);
    if (started.status !== 'IN_PROGRESS') throw new Error('Hearing start smoke verification failed');
    await service.recordAppearance(actor, ids.hearingId, { participantName: 'Smoke Counsel', participantRole: 'COUNSEL', appearanceMode: 'IN_PERSON' });
    await service.recordProceeding(actor, ids.hearingId, { note: 'Transactional live smoke proceeding record.' });
    const completed = await service.completeHearing(actor, ids.hearingId, { outcomeCode: 'DECISION_RESERVED' });
    if (completed.status !== 'COMPLETED') throw new Error('Hearing completion smoke verification failed');

    let judgment = await service.createJudgment(actor, ids.caseId, {
      hearingId: ids.hearingId, decisionType: 'JUDGMENT', title: 'Transactional Smoke Judgment', content: 'Initial smoke-test draft.'
    });
    judgment = await service.updateJudgmentDraft(actor, judgment.judgmentId, { title: judgment.title, content: 'Updated smoke-test draft.' });
    if (judgment.version !== 2) throw new Error('Judgment draft persistence smoke verification failed');
    judgment = await service.reviewJudgment(actor, judgment.judgmentId);
    judgment = await service.signJudgment(actor, judgment.judgmentId);
    judgment = await service.issueJudgment(actor, judgment.judgmentId);
    if (judgment.status !== 'ISSUED') throw new Error('Judgment lifecycle smoke verification failed');

    await client.query('ROLLBACK');
    return Object.freeze({
      connected: true,
      profile: config.dbProfile,
      myCases: true,
      dailyHearings: true,
      hearingMode: true,
      judgmentLifecycle: true,
      rolledBack: true
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  runLiveSmoke()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.code || 'LIVE_SMOKE_FAILED'}: ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = { createLiveSmokeConfig, runLiveSmoke };
