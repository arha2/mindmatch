-- Run this upgrade in the SQL Editor of your EXISTING Supabase project.
-- Finish existing games before applying; new two-person games use dual roles.
begin;
alter table mindmatch.rooms add column if not exists dual_role boolean not null default false;

create or replace function mindmatch.snapshot(p_room uuid) returns jsonb language plpgsql security definer set search_path='' as $$
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

create or replace function public.mm_action(p_room uuid,p_action text,p_round integer default 0,p_payload jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
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
commit;
