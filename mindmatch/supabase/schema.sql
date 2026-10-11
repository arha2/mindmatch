-- Mindmatch. Run once in a NEW Supabase project's SQL Editor.
-- Private tables are never exposed through the Data API. Only scoped RPCs and
-- a content-free revision signal are public. Every mutation locks its room.
begin;
create schema if not exists mindmatch;
revoke all on schema mindmatch from public, anon, authenticated;
create table mindmatch.questions(id text primary key, pack text not null, text text not null);
create table mindmatch.rooms(
 id uuid primary key default gen_random_uuid(), code text unique not null,
 host uuid not null, moderator uuid, dual_role boolean not null default false, stage text not null default 'lobby',
 round integer not null default 0, rounds integer not null default 5,
 packs text[] not null, deck text[] not null default '{}',
 created_at timestamptz not null default now(), expires_at timestamptz not null default now()+interval '24 hours'
);
create table mindmatch.members(
 room uuid references mindmatch.rooms on delete cascade,
 uid uuid not null, name text not null check(length(name) between 1 and 24),
 joined_at timestamptz not null default clock_timestamp(), seen_at timestamptz not null default now(),
 primary key(room,uid)
);
create unique index member_name on mindmatch.members(room,lower(name));
create table mindmatch.answers(
 room uuid references mindmatch.rooms on delete cascade, round integer not null,
 uid uuid not null, target uuid not null, own text not null, guess text not null,
 points integer check(points between 0 and 2), primary key(room,round,uid)
);
create table public.mm_signals(id uuid primary key references mindmatch.rooms on delete cascade, revision integer not null default 0);
alter table public.mm_signals enable row level security;
revoke all on public.mm_signals from anon, authenticated;
grant select on public.mm_signals to authenticated;
create function public.mm_is_member(p_room uuid) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from mindmatch.members m join mindmatch.rooms r on r.id=m.room where m.room=p_room and m.uid=auth.uid() and r.expires_at>now());
$$;
revoke all on function public.mm_is_member(uuid) from public,anon;
grant execute on function public.mm_is_member(uuid) to authenticated;
create policy member_signal on public.mm_signals for select to authenticated using(public.mm_is_member(id));

create function mindmatch.snapshot(p_room uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare r mindmatch.rooms; u uuid:=auth.uid(); ps jsonb; ans jsonb; target_id uuid; ids uuid[]; idx integer;
begin
 select * into r from mindmatch.rooms where id=p_room;
 if not found or r.expires_at<=now() or not exists(select 1 from mindmatch.members where room=p_room and uid=u) then raise exception 'Room unavailable. Check the code or create a new room.'; end if;
 select array_agg(uid order by joined_at,uid) into ids from mindmatch.members where room=p_room and (r.dual_role or uid is distinct from r.moderator);
 idx:=array_position(ids,u);
 if idx is not null and cardinality(ids)>1 then target_id:=ids[1+mod(idx-1+1+mod(greatest(r.round-1,0),cardinality(ids)-1),cardinality(ids))]; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',m.uid,'name',m.name,'isHost',m.uid=r.host,'isModerator',m.uid=r.moderator,'online',m.seen_at>now()-interval '40 seconds','submitted',exists(select 1 from mindmatch.answers a where a.room=p_room and a.round=r.round and a.uid=m.uid),'score',coalesce((select sum(a.points) from mindmatch.answers a where a.room=p_room and a.uid=m.uid and (a.round<r.round or r.stage in ('reveal','finished'))),0)) order by m.joined_at,m.uid),'[]') into ps from mindmatch.members m where m.room=p_room;
 select coalesce(jsonb_agg(jsonb_build_object('uid',a.uid,'target',a.target,'own',a.own,'guess',a.guess,'points',case when r.stage in ('reveal','finished') or u=r.moderator then a.points else null end)),'[]') into ans from mindmatch.answers a where a.room=p_room and a.round=r.round and (a.uid=u or r.stage in ('reveal','finished') or (u=r.moderator and r.stage='judging'));
 return jsonb_build_object('id',r.id,'code',r.code,'host',r.host,'moderator',r.moderator,'dualRole',r.dual_role,'stage',r.stage,'round',r.round,'rounds',r.rounds,'packs',r.packs,'players',ps,'answers',ans,'target',target_id,'me',u,'question',(select jsonb_build_object('id',q.id,'pack',q.pack,'text',q.text) from mindmatch.questions q where q.id=r.deck[r.round]),'revision',(select revision from public.mm_signals where id=p_room));
end; $$;

create function public.mm_create(p_name text,p_rounds integer,p_packs text[]) returns jsonb language plpgsql security definer set search_path='' as $$
declare rid uuid; u uuid:=auth.uid(); c text;
begin
 if u is null then raise exception 'Please reconnect and try again.'; end if;
 if length(trim(p_name)) not between 1 and 24 or p_name is null then raise exception 'Enter a name up to 24 characters.'; end if;
 if p_rounds is null or p_rounds not in (3,5,8,10,15,20) or coalesce(cardinality(p_packs),0)=0 or exists(select 1 from unnest(p_packs) p where p is null or p not in (select distinct pack from mindmatch.questions)) then raise exception 'Choose rounds and at least one question pack.'; end if;
 if (select count(*) from mindmatch.rooms where host=u and created_at>now()-interval '1 hour')>=20 then raise exception 'Too many rooms created. Try again later.'; end if;
 loop
 c:=upper(substr(replace(gen_random_uuid()::text,'-',''),1,8));
 begin
 insert into mindmatch.rooms(code,host,rounds,packs) values(c,u,p_rounds,p_packs) returning id into rid;
 exit;
 exception when unique_violation then null;
 end;
 end loop;
 insert into mindmatch.members(room,uid,name) values(rid,u,trim(p_name));
 insert into public.mm_signals(id) values(rid);
 return mindmatch.snapshot(rid);
end; $$;
create function public.mm_join(p_code text,p_name text) returns jsonb language plpgsql security definer set search_path='' as $$
declare r mindmatch.rooms; u uuid:=auth.uid();
begin
 if u is null then raise exception 'Please reconnect and try again.'; end if;
 select * into r from mindmatch.rooms where code=upper(trim(p_code)) and expires_at>now() for update;
 if not found then raise exception 'Room not found. Check the code.'; end if;
 if exists(select 1 from mindmatch.members where room=r.id and uid=u) then return mindmatch.snapshot(r.id); end if;
 if r.stage<>'lobby' then raise exception 'This game has already started.'; end if;
 if length(trim(p_name)) not between 1 and 24 or p_name is null then raise exception 'Enter a name up to 24 characters.'; end if;
 if (select count(*) from mindmatch.members where room=r.id)>=9 then raise exception 'This room is full.'; end if;
 if exists(select 1 from mindmatch.members where room=r.id and lower(name)=lower(trim(p_name))) then raise exception 'That name is already in use.'; end if;
 insert into mindmatch.members(room,uid,name) values(r.id,u,trim(p_name));
 update public.mm_signals set revision=revision+1 where id=r.id;
 return mindmatch.snapshot(r.id);
end; $$;
create function public.mm_state(p_room uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not public.mm_is_member(p_room) then raise exception 'Room unavailable. Check the code or create a new room.'; end if;
 update mindmatch.members set seen_at=now() where room=p_room and uid=auth.uid() and seen_at<now()-interval '15 seconds';
 return mindmatch.snapshot(p_room);
end; $$;
create function public.mm_action(p_room uuid,p_action text,p_round integer default 0,p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare r mindmatch.rooms; u uuid:=auth.uid(); ids uuid[]; tid uuid; idx integer; total integer; v jsonb; item jsonb;
begin
 select * into r from mindmatch.rooms where id=p_room for update;
 if not found or not public.mm_is_member(p_room) then raise exception 'Room unavailable. Check the code or create a new room.'; end if;
 if p_action in ('settings','moderator','remove','start','restart','end') and u<>r.host then raise exception 'Only the host can do that.'; end if;
 if p_action in ('settings','moderator','remove','start') and r.stage<>'lobby' then raise exception 'The game has already started.'; end if;
 if p_action in ('submit','score','publish','next') and (p_round is null or p_round<>r.round) then raise exception 'The round has changed. Please try again.'; end if;
 select array_agg(uid order by joined_at,uid) into ids from mindmatch.members where room=p_room and (r.dual_role or uid is distinct from r.moderator);
 total:=cardinality(ids);
 case p_action
 when 'settings' then
  if (p_payload->>'rounds')::integer not in (3,5,8,10,15,20) or p_payload->>'rounds' is null or jsonb_typeof(p_payload->'packs') is distinct from 'array' then raise exception 'Invalid settings.'; end if;
  if jsonb_array_length(p_payload->'packs')=0 or exists(select 1 from jsonb_array_elements_text(p_payload->'packs') p where p is null or p not in (select distinct pack from mindmatch.questions)) then raise exception 'Choose at least one question pack.'; end if;
  update mindmatch.rooms set rounds=(p_payload->>'rounds')::integer,packs=array(select jsonb_array_elements_text(p_payload->'packs')) where id=p_room;
 when 'moderator' then
  tid:=(p_payload->>'id')::uuid;
  if not exists(select 1 from mindmatch.members where room=p_room and uid=tid) then raise exception 'Choose a person in the room.'; end if;
  update mindmatch.rooms set moderator=tid where id=p_room;
 when 'remove' then
  tid:=(p_payload->>'id')::uuid;
  if tid=u then raise exception 'The host cannot be removed.'; end if;
  delete from mindmatch.members where room=p_room and uid=tid;
  update mindmatch.rooms set moderator=null where id=p_room and moderator=tid;
 when 'start' then
  if (select count(*) from mindmatch.members where room=p_room)=2 then
   -- Both members play; the host also scores after both have submitted.
   update mindmatch.rooms set moderator=r.host,dual_role=true where id=p_room;
  else
   if r.moderator is null or coalesce(total,0)<2 then raise exception 'You need at least two players and a moderator.'; end if;
   update mindmatch.rooms set dual_role=false where id=p_room;
  end if;
  update mindmatch.rooms set deck=array(select id from mindmatch.questions where pack=any(r.packs) order by random() limit r.rounds),round=1,stage='answering' where id=p_room;
 when 'submit' then
  if r.stage<>'answering' or (u=r.moderator and not r.dual_role) then raise exception 'You cannot submit answers now.'; end if;
  if length(trim(p_payload->>'own')) not between 1 and 180 or length(trim(p_payload->>'guess')) not between 1 and 180 or p_payload->>'own' is null or p_payload->>'guess' is null then raise exception 'Enter both answers, up to 180 characters each.'; end if;
  idx:=array_position(ids,u); tid:=ids[1+mod(idx-1+1+mod(r.round-1,total-1),total)];
  insert into mindmatch.answers(room,round,uid,target,own,guess) values(p_room,r.round,u,tid,trim(p_payload->>'own'),trim(p_payload->>'guess')) on conflict(room,round,uid) do nothing;
  if (select count(*) from mindmatch.answers where room=p_room and round=r.round)=total then update mindmatch.rooms set stage='judging' where id=p_room; end if;
 when 'score' then
  if u is distinct from r.moderator or r.stage<>'judging' then raise exception 'Only the moderator can score this round.'; end if;
  if (p_payload->>'points')::integer not between 0 and 2 or p_payload->>'points' is null then raise exception 'Points must be 0, 1, or 2.'; end if;
  update mindmatch.answers set points=(p_payload->>'points')::integer where room=p_room and round=r.round and uid=(p_payload->>'id')::uuid;
  if not found then raise exception 'Answer not found.'; end if;
 when 'publish' then
  if u is distinct from r.moderator or r.stage<>'judging' then raise exception 'Only the moderator can reveal scores.'; end if;
  if exists(select 1 from mindmatch.answers where room=p_room and round=r.round and points is null) then raise exception 'Score every player first.'; end if;
  update mindmatch.rooms set stage='reveal' where id=p_room;
 when 'next' then
  if u<>r.host and u is distinct from r.moderator then raise exception 'The host or moderator starts the next round.'; end if;
  if r.stage<>'reveal' then raise exception 'Reveal scores first.'; end if;
  update mindmatch.rooms set stage=case when r.round>=r.rounds then 'finished' else 'answering' end,round=case when r.round>=r.rounds then r.round else r.round+1 end where id=p_room;
 when 'restart' then
  if r.stage<>'finished' then raise exception 'Finish the game first.'; end if;
  delete from mindmatch.answers where room=p_room;
  update mindmatch.rooms set stage='lobby',round=0,deck='{}',dual_role=false where id=p_room;
 when 'end' then update mindmatch.rooms set stage='closed' where id=p_room;
 else raise exception 'Unknown action.';
 end case;
 update mindmatch.members set seen_at=now() where room=p_room and uid=u;
 update public.mm_signals set revision=revision+1 where id=p_room;
 return mindmatch.snapshot(p_room);
end; $$;
revoke all on all functions in schema mindmatch from public,anon,authenticated;
revoke all on function public.mm_create(text,integer,text[]),public.mm_join(text,text),public.mm_state(uuid),public.mm_action(uuid,text,integer,jsonb) from public,anon;
grant execute on function public.mm_create(text,integer,text[]),public.mm_join(text,text),public.mm_state(uuid),public.mm_action(uuid,text,integer,jsonb) to authenticated;
-- Safe to repeat this publication step.
do $$ begin
 if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='mm_signals') then
  alter publication supabase_realtime add table public.mm_signals;
 end if;
end $$;
commit;
