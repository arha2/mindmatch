import {test} from 'node:test';
import assert from 'node:assert/strict';
import config from '../vite.config.js';
import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs/promises';

test('Vercel integration variables map only public values into the frontend',()=>{
 const old={...process.env};
 try {
  delete process.env.VITE_SUPABASE_URL; delete process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  process.env.SUPABASE_URL='https://integration-check.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY='sb_publishable_public_test';
  process.env.SUPABASE_SECRET_KEY='SECRET_MUST_NOT_BE_EXPOSED';
  process.env.POSTGRES_URL='PRIVATE_DATABASE_MUST_NOT_BE_EXPOSED';
  const built=config({mode:'production'});
  assert.equal(JSON.parse(built.define['import.meta.env.VITE_SUPABASE_URL']),process.env.SUPABASE_URL);
  assert.equal(JSON.parse(built.define['import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY']),process.env.SUPABASE_PUBLISHABLE_KEY);
  assert.equal(Object.keys(built.define).length,2);
  assert.ok(!JSON.stringify(built).includes('MUST_NOT_BE_EXPOSED'));
 }finally{for(const k of Object.keys(process.env))if(!(k in old))delete process.env[k];Object.assign(process.env,old)}
});

test('one-file setup installs database and all 160 questions',async()=>{
 const db=new PGlite();
 try{await db.exec(`create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql as $$select null::uuid$$;`);
 await db.exec(await fs.readFile('supabase/setup.sql','utf8'));
 assert.equal((await db.query('select count(*)::int n from mindmatch.questions')).rows[0].n,160);
 }finally{await db.close()}
});
