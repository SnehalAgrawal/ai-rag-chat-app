// The frozen question sets and the "evidence found" check, as defined in rag-engineering:
// a question is found when, for at least one of its accepted answers, every evidence
// passage appears whole inside one of the retrieved chunks.

import { readFileSync } from "node:fs";

const QUESTIONS = new URL("../../eval/questions/", import.meta.url);

/** The two sets: "new" (40 questions written to find differences) and "04" (60 from the chunking demo). */
export function loadQuestions() {
  const read = (file) => JSON.parse(readFileSync(new URL(file, QUESTIONS), "utf8")).questions;
  return { new: read("hybrid-search.json"), "04": read("chunking.json") };
}

export function found(question, texts) {
  return question.evidence.some((alternative) => alternative.every((passage) => texts.some((t) => t.includes(passage.text))));
}
