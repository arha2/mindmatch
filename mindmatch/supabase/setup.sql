-- Mindmatch: run this entire file ONCE in a NEW database.
-- Mindmatch. Run once in a NEW Supabase project's SQL Editor.
-- Private tables are never exposed through the Data API. Only scoped RPCs and
-- a content-free revision signal are public. Every mutation locks its room.
begin;
create schema if not exists mindmatch;
revoke all on schema mindmatch from public, anon, authenticated;
create table mindmatch.questions(id text primary key, pack text not null, text text not null);
create table mindmatch.rooms(
 id uuid primary key default gen_random_uuid(), code text unique not null,
 host uuid not null, moderator uuid, stage text not null default 'lobby',
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
 select array_agg(uid order by joined_at,uid) into ids from mindmatch.members where room=p_room and uid is distinct from r.moderator;
 idx:=array_position(ids,u);
 if idx is not null and cardinality(ids)>1 then target_id:=ids[1+mod(idx-1+1+mod(greatest(r.round-1,0),cardinality(ids)-1),cardinality(ids))]; end if;
 select coalesce(jsonb_agg(jsonb_build_object('id',m.uid,'name',m.name,'isHost',m.uid=r.host,'isModerator',m.uid=r.moderator,'online',m.seen_at>now()-interval '40 seconds','submitted',exists(select 1 from mindmatch.answers a where a.room=p_room and a.round=r.round and a.uid=m.uid),'score',coalesce((select sum(a.points) from mindmatch.answers a where a.room=p_room and a.uid=m.uid and (a.round<r.round or r.stage in ('reveal','finished'))),0)) order by m.joined_at,m.uid),'[]') into ps from mindmatch.members m where m.room=p_room;
 select coalesce(jsonb_agg(jsonb_build_object('uid',a.uid,'target',a.target,'own',a.own,'guess',a.guess,'points',case when r.stage in ('reveal','finished') or u=r.moderator then a.points else null end)),'[]') into ans from mindmatch.answers a where a.room=p_room and a.round=r.round and (a.uid=u or r.stage in ('reveal','finished') or (u=r.moderator and r.stage='judging'));
 return jsonb_build_object('id',r.id,'code',r.code,'host',r.host,'moderator',r.moderator,'stage',r.stage,'round',r.round,'rounds',r.rounds,'packs',r.packs,'players',ps,'answers',ans,'target',target_id,'me',u,'question',(select jsonb_build_object('id',q.id,'pack',q.pack,'text',q.text) from mindmatch.questions q where q.id=r.deck[r.round]),'revision',(select revision from public.mm_signals where id=p_room));
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
 select array_agg(uid order by joined_at,uid) into ids from mindmatch.members where room=p_room and uid is distinct from r.moderator;
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
  if r.moderator is null or total<2 then raise exception 'You need at least two players and a moderator.'; end if;
  update mindmatch.rooms set deck=array(select id from mindmatch.questions where pack=any(r.packs) order by random() limit r.rounds),round=1,stage='answering' where id=p_room;
 when 'submit' then
  if r.stage<>'answering' or u=r.moderator then raise exception 'You cannot submit answers now.'; end if;
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
  update mindmatch.rooms set stage='lobby',round=0,deck='{}' where id=p_room;
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


-- Run after schema.sql. Re-running safely updates question text.
insert into mindmatch.questions(id,pack,text) values
('everyday-1','everyday','What is the first thing you do when you get home?'),
('everyday-2','everyday','What small thing instantly puts you in a better mood?'),
('everyday-3','everyday','What is your most-used phone app?'),
('everyday-4','everyday','What chore do you put off the longest?'),
('everyday-5','everyday','What do you usually forget to pack?'),
('everyday-6','everyday','What is your ideal way to spend a rainy Sunday?'),
('everyday-7','everyday','What is the first thing you buy at a supermarket?'),
('everyday-8','everyday','What is one thing you always have in your bag?'),
('everyday-9','everyday','What sound annoys you most?'),
('everyday-10','everyday','What is your go-to excuse for leaving early?'),
('everyday-11','everyday','What time would you wake up with no alarm?'),
('everyday-12','everyday','What is a purchase you keep telling yourself you do not need?'),
('everyday-13','everyday','What do you do when you cannot sleep?'),
('everyday-14','everyday','What is your favourite place to sit at home?'),
('everyday-15','everyday','What is a habit you would like to break?'),
('everyday-16','everyday','What is the first thing you check in the morning?'),
('everyday-17','everyday','What is something you refuse to buy the cheap version of?'),
('everyday-18','everyday','What do you always run out of at home?'),
('everyday-19','everyday','What is your usual order at a café?'),
('everyday-20','everyday','What is the best part of your usual weekday?'),
('food-1','food','What food could you eat three days in a row?'),
('food-2','food','What would you order for your last meal?'),
('food-3','food','What is your favourite late-night snack?'),
('food-4','food','What is the most overrated food?'),
('food-5','food','What topping ruins a pizza for you?'),
('food-6','food','What dish reminds you of home?'),
('food-7','food','What do you bring to a picnic?'),
('food-8','food','What is your favourite thing from a bakery?'),
('food-9','food','What is your first choice on a takeaway menu?'),
('food-10','food','What is your favourite potato format?'),
('food-11','food','What do you cook when you want to impress someone?'),
('food-12','food','What food did you hate as a child but like now?'),
('food-13','food','What do you order at a restaurant you have never visited?'),
('food-14','food','What is the best ice-cream flavour?'),
('food-15','food','What is your favourite breakfast?'),
('food-16','food','What snack disappears fastest when you are around?'),
('food-17','food','What is the best thing to dip chips into?'),
('food-18','food','What drink would you choose on a hot afternoon?'),
('food-19','food','What food would you happily travel an hour for?'),
('food-20','food','What is one ingredient your kitchen must have?'),
('culture-1','culture','What film could you watch again tonight?'),
('culture-2','culture','What song gets you onto a dance floor?'),
('culture-3','culture','What fictional world would you like to live in?'),
('culture-4','culture','What TV series do you recommend most often?'),
('culture-5','culture','What is your karaoke song?'),
('culture-6','culture','What fictional character are you most like?'),
('culture-7','culture','What game brings out your competitive side?'),
('culture-8','culture','What is your favourite childhood cartoon?'),
('culture-9','culture','What song would play when you enter a room?'),
('culture-10','culture','What celebrity would you invite to dinner?'),
('culture-11','culture','What film genre do you usually avoid?'),
('culture-12','culture','What book has stayed with you?'),
('culture-13','culture','What musical instrument would you learn overnight?'),
('culture-14','culture','What is the best film snack?'),
('culture-15','culture','What TV show would you be terrible at competing in?'),
('culture-16','culture','What game would you choose for this group?'),
('culture-17','culture','What artist would you travel abroad to see live?'),
('culture-18','culture','What is your favourite fictional villain?'),
('culture-19','culture','What is a film everyone seems to have seen except you?'),
('culture-20','culture','What was your favourite game as a child?'),
('travel-1','travel','Where would you go for a spontaneous weekend?'),
('travel-2','travel','What city would you live in for one year?'),
('travel-3','travel','What is the first thing you do after checking into a hotel?'),
('travel-4','travel','What is your favourite kind of holiday?'),
('travel-5','travel','What is the best seat on a train?'),
('travel-6','travel','What is your airport snack?'),
('travel-7','travel','What would you visit first in a new city?'),
('travel-8','travel','Where would you go to completely switch off?'),
('travel-9','travel','What is the one thing you overpack?'),
('travel-10','travel','What country is next on your travel list?'),
('travel-11','travel','What souvenir are you most likely to buy?'),
('travel-12','travel','What is your ideal road-trip snack?'),
('travel-13','travel','What activity would you plan for a sunny Saturday?'),
('travel-14','travel','What place would you happily visit again?'),
('travel-15','travel','What do you miss most when you are away from home?'),
('travel-16','travel','What is your least favourite part of travelling?'),
('travel-17','travel','Where would you take a friend visiting your city?'),
('travel-18','travel','What would you do with a six-hour train journey?'),
('travel-19','travel','What would make you immediately leave a hotel?'),
('travel-20','travel','What is the best month to take a holiday?'),
('imaginary-1','imaginary','What superpower would you choose?'),
('imaginary-2','imaginary','What would you buy first if you won a million euros?'),
('imaginary-3','imaginary','What animal would you be for a day?'),
('imaginary-4','imaginary','What job would you try if qualifications did not matter?'),
('imaginary-5','imaginary','What would you name a boat?'),
('imaginary-6','imaginary','What would you take to a deserted island?'),
('imaginary-7','imaginary','What would you do first if you were invisible?'),
('imaginary-8','imaginary','What would your autobiography be called?'),
('imaginary-9','imaginary','What would you put in a time capsule?'),
('imaginary-10','imaginary','What useless talent would you like to have?'),
('imaginary-11','imaginary','What shop would you choose for a free five-minute shopping spree?'),
('imaginary-12','imaginary','What would you ask your future self?'),
('imaginary-13','imaginary','What would you do with an extra room in your home?'),
('imaginary-14','imaginary','What would your signature perfume smell like?'),
('imaginary-15','imaginary','What would you keep if you had to give away everything but one object?'),
('imaginary-16','imaginary','What would you invent to make everyday life easier?'),
('imaginary-17','imaginary','What decade would you visit for a week?'),
('imaginary-18','imaginary','What would you spend a surprise day off doing?'),
('imaginary-19','imaginary','What would you name a café you opened?'),
('imaginary-20','imaginary','What skill would you download directly into your brain?'),
('friends-1','friends','What would you bring to a group dinner?'),
('friends-2','friends','What activity should this group do next?'),
('friends-3','friends','What emoji best describes you in the group chat?'),
('friends-4','friends','What are you most likely to be teased about?'),
('friends-5','friends','What role do you take on during a group trip?'),
('friends-6','friends','What topic could you talk about for an hour?'),
('friends-7','friends','What is your go-to suggestion when nobody can decide what to do?'),
('friends-8','friends','What would you organise for your ideal birthday?'),
('friends-9','friends','What are you most likely to send to the group chat?'),
('friends-10','friends','What would your friends ask you for advice about?'),
('friends-11','friends','What is a phrase you say too often?'),
('friends-12','friends','What would you be doing at a house party?'),
('friends-13','friends','What would be your contribution to a camping trip?'),
('friends-14','friends','What would your friends find surprising about your search history?'),
('friends-15','friends','What is the quickest way to get you to cancel plans?'),
('friends-16','friends','What would you choose as this group’s theme song?'),
('friends-17','friends','What would you insist on doing during a shared holiday?'),
('friends-18','friends','What is the best gift someone in this group could give you?'),
('friends-19','friends','What is your strongest opinion that really does not matter?'),
('friends-20','friends','What is a competition you think you could win against this group?'),
('germany_uk-1','germany_uk','What is your first stop at a Christmas market?'),
('germany_uk-2','germany_uk','What do you buy at a German bakery?'),
('germany_uk-3','germany_uk','What British snack would you bring back in your suitcase?'),
('germany_uk-4','germany_uk','What German snack would you send to a friend in the UK?'),
('germany_uk-5','germany_uk','What would you order at a pub?'),
('germany_uk-6','germany_uk','What is your Sunday plan when the shops are closed?'),
('germany_uk-7','germany_uk','What would you do on a train that is delayed by an hour?'),
('germany_uk-8','germany_uk','What city should we meet in for a weekend together?'),
('germany_uk-9','germany_uk','What do you miss from another country’s supermarkets?'),
('germany_uk-10','germany_uk','What would you choose for a full English breakfast?'),
('germany_uk-11','germany_uk','What is your favourite thing to eat at a German street market?'),
('germany_uk-12','germany_uk','What is the first place you would take a friend visiting Germany?'),
('germany_uk-13','germany_uk','What is the first place you would take a friend visiting the UK?'),
('germany_uk-14','germany_uk','What do you associate most with British weather?'),
('germany_uk-15','germany_uk','What German word do you enjoy saying?'),
('germany_uk-16','germany_uk','What British expression do you enjoy using?'),
('germany_uk-17','germany_uk','What do you pack for a weekend in London?'),
('germany_uk-18','germany_uk','What would you buy at a train station before a long journey?'),
('germany_uk-19','germany_uk','What food would you introduce to a friend from the other country?'),
('germany_uk-20','germany_uk','What is the best way to spend a winter evening here?'),
('personal-1','personal','What small achievement are you proud of?'),
('personal-2','personal','What did you want to be when you were a child?'),
('personal-3','personal','What is the best compliment someone could give you?'),
('personal-4','personal','What is something you would like to learn this year?'),
('personal-5','personal','What instantly makes a place feel like home?'),
('personal-6','personal','What is a simple pleasure you never get bored of?'),
('personal-7','personal','What is a decision you take surprisingly seriously?'),
('personal-8','personal','What makes you feel most relaxed?'),
('personal-9','personal','What is something you were afraid of as a child?'),
('personal-10','personal','What would you do more often if you had the time?'),
('personal-11','personal','What is the best way to cheer you up?'),
('personal-12','personal','What is something you are unusually patient about?'),
('personal-13','personal','What is something you are unusually impatient about?'),
('personal-14','personal','What is a quality you appreciate most in a friend?'),
('personal-15','personal','What makes a day feel well spent?'),
('personal-16','personal','What is your favourite family tradition?'),
('personal-17','personal','What is something you would like to do for the first time?'),
('personal-18','personal','What makes you nostalgic?'),
('personal-19','personal','What is a place where you feel most like yourself?'),
('personal-20','personal','What would you like to be remembered for?')
on conflict(id) do update set pack=excluded.pack,text=excluded.text;

commit;
