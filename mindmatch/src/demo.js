import { chooseQuestions, defaultPacks } from "./questions";
let room, deck;
const names = ["Farhan", "Maya", "Sam", "Alex"];
export function demoCreate(name = "Farhan", rounds = 5, packs = defaultPacks) {
  deck = chooseQuestions(packs, rounds);
  room = {
    id: "demo",
    code: "DEMO",
    host: "p0",
    moderator: "p3",
    stage: "lobby",
    round: 0,
    rounds,
    packs,
    players: names.map((n, i) => ({
      id: "p" + i,
      name: i === 0 ? name : n,
      isHost: i === 0,
      isModerator: i === 3,
      online: true,
      submitted: false,
      score: 0,
    })),
    answers: [],
    target: "p1",
    me: "p0",
    revision: 0,
  };
  return structuredClone(room);
}
function begin() {
  room.stage = "answering";
  room.answers = [];
  room.players.forEach((p) => (p.submitted = false));
  room.question = deck[room.round - 1];
  room.target = "p" + (1 + ((room.round - 1) % 2));
}
export function demoAct(action, payload = {}) {
  switch (action) {
    case "settings":
      room.rounds = payload.rounds;
      room.packs = payload.packs;
      deck = chooseQuestions(room.packs, room.rounds);
      break;
    case "start":
      room.round = 1;
      begin();
      break;
    case "submit": {
      const choices = [
        "A quiet café",
        "A long walk",
        "Pizza",
        "A weekend in London",
        "A good book",
        "A train trip",
      ];
      const players = room.players.filter((p) => !p.isModerator);
      room.answers = players.map((p, i) => ({
        uid: p.id,
        target: players[(i + 1 + ((room.round - 1) % 2)) % 3].id,
        own: i === 0 ? payload.own : choices[(room.round + i) % choices.length],
        guess:
          i === 0
            ? payload.guess
            : choices[(room.round + i + 1) % choices.length],
        points: null,
      }));
      players.forEach((p) => (p.submitted = true));
      room.stage = "judging";
      break;
    }
    case "score":
      room.answers.find((a) => a.uid === payload.id).points = payload.points;
      break;
    case "publish":
      if (room.answers.some((a) => a.points === null))
        throw Error("Score every player first.");
      room.answers.forEach(
        (a) => (room.players.find((p) => p.id === a.uid).score += a.points),
      );
      room.stage = "reveal";
      break;
    case "next":
      if (room.round >= room.rounds) room.stage = "finished";
      else {
        room.round++;
        begin();
      }
      break;
    case "restart":
      return demoCreate(room.players[0].name, room.rounds, room.packs);
    default:
      throw Error("This action is available in online rooms.");
  }
  room.revision++;
  return structuredClone(room);
}
