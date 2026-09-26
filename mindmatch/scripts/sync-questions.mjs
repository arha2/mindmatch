import { questions } from "../src/questions.js";
import fs from "node:fs";
const quote = (s) => "'" + s.replaceAll("'", "''") + "'";
fs.writeFileSync(
  new URL("../supabase/questions.sql", import.meta.url),
  "-- Run after schema.sql. Re-running safely updates question text.\ninsert into mindmatch.questions(id,pack,text) values\n" +
    questions
      .map((x) => `(${quote(x.id)},${quote(x.pack)},${quote(x.text)})`)
      .join(",\n") +
    "\non conflict(id) do update set pack=excluded.pack,text=excluded.text;\n",
);

const dir = new URL("../supabase/", import.meta.url);
fs.writeFileSync(new URL("setup.sql",dir), "-- Mindmatch: run this entire file ONCE in a NEW database.\n" + fs.readFileSync(new URL("schema.sql",dir),"utf8").replace("commit;", "") + "\n" + fs.readFileSync(new URL("questions.sql",dir),"utf8") + "\ncommit;\n");
