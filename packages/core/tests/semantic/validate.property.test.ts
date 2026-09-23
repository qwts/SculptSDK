import { describe, expect, it } from "vitest";
import {
  validateDecisionResponse,
  type ChoiceAnswer,
  type ChoiceQuestion,
  type DecisionEvidence,
  type DecisionRequest,
  type ProbabilityAnswer,
  type ProbabilityQuestion,
  type RawDecisionResponse,
  type ScoreAnswer,
  type ScoreQuestion,
  type SemanticAnswer,
  type SemanticQuestion
} from "@sculptsdk/core";

/**
 * Property test (#12's acceptance criteria): no fuzzed response ever yields
 * "accepted" for an option (or value) outside what the request declared.
 * Deterministic seeded PRNG instead of a new fuzzing dependency — reproducible
 * in CI without adding a package for one test file.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function evidence(): DecisionEvidence {
  return {
    requestId: "req-fuzz",
    operationId: "op-fuzz",
    point: "fuzz-point",
    model: "jev-1.13",
    questionVersion: "v1",
    policyVersion: "v1",
    origin: "http://fixtures.local",
    frameId: "main",
    navigationEpoch: 1,
    candidateSetDigest: "digest-candidates",
    redactedStateDigest: "digest-state",
    deadline: Date.now() + 1000,
    signal: new AbortController().signal
  };
}

const OPTION_POOL = ["a", "b", "c", "none"] as const;
const FOREIGN_OPTIONS = ["z", "not-a-candidate", "__proto__", ""];

function randomChoice<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length) % items.length] as T;
}

function randomQuestion(rand: () => number, index: number): SemanticQuestion {
  const kind = randomChoice(rand, ["choice", "score", "probability"] as const);
  const id = `q-${index}`;
  if (kind === "choice") {
    return { kind: "choice", id, options: OPTION_POOL } satisfies ChoiceQuestion;
  }
  if (kind === "score") {
    return { kind: "score", id, min: 0, max: 1 } satisfies ScoreQuestion;
  }
  return { kind: "probability", id } satisfies ProbabilityQuestion;
}

/** Builds a plausibly-malformed answer for a question: sometimes valid,
 * sometimes not, sometimes for the wrong kind or a foreign option/value. */
function randomAnswer(rand: () => number, question: SemanticQuestion): SemanticAnswer {
  const wrongKind = rand() < 0.1;
  const answerKind = wrongKind
    ? randomChoice(
        rand,
        (["choice", "score", "probability"] as const).filter((k) => k !== question.kind)
      )
    : question.kind;

  if (answerKind === "choice") {
    const useForeign = rand() < 0.3;
    const selected = useForeign ? randomChoice(rand, FOREIGN_OPTIONS) : randomChoice(rand, OPTION_POOL);
    const withDistribution = rand() < 0.5;
    const distribution = withDistribution
      ? Object.fromEntries(
          [...OPTION_POOL, ...(rand() < 0.2 ? [randomChoice(rand, FOREIGN_OPTIONS)] : [])].map((opt) => [
            opt,
            rand() < 0.1 ? Number.NaN : (rand() - (rand() < 0.1 ? 0.5 : 0)) * 2
          ])
        )
      : undefined;
    return {
      kind: "choice",
      questionId: question.id,
      selected,
      distribution,
      providerConfidence: rand() < 0.2 ? (rand() - 0.3) * 2 : undefined
    } as ChoiceAnswer;
  }

  if (answerKind === "score") {
    const inRange = rand() < 0.5;
    const value = inRange ? rand() : (rand() - 0.5) * 10;
    return { kind: "score", questionId: question.id, value: rand() < 0.05 ? Number.NaN : value } as ScoreAnswer;
  }

  const inRange = rand() < 0.5;
  const value = inRange ? rand() : (rand() - 0.5) * 10;
  return { kind: "probability", questionId: question.id, value: rand() < 0.05 ? Number.NaN : value } as ProbabilityAnswer;
}

describe("validateDecisionResponse — property: never accepts outside the request's declared option/value space", () => {
  const SEEDS = [1, 2, 3, 4, 5, 42, 1337, 90210];

  for (const seed of SEEDS) {
    it(`seed ${seed}: 200 fuzzed responses`, () => {
      const rand = mulberry32(seed);

      for (let trial = 0; trial < 200; trial++) {
        const questionCount = 1 + Math.floor(rand() * 4);
        const questions: SemanticQuestion[] = Array.from({ length: questionCount }, (_, i) => randomQuestion(rand, i));
        const request: DecisionRequest = { evidence: evidence(), questions };

        // Sometimes answer every question, sometimes drop some, sometimes duplicate one.
        const answers: SemanticAnswer[] = [];
        for (const question of questions) {
          if (rand() < 0.9) answers.push(randomAnswer(rand, question));
          if (rand() < 0.1) answers.push(randomAnswer(rand, question)); // duplicate
        }
        // Sometimes throw in an answer for a question that was never asked.
        if (rand() < 0.2) {
          answers.push(randomAnswer(rand, { kind: "choice", id: "q-never-asked", options: OPTION_POOL }));
        }

        const raw: RawDecisionResponse = { answers };
        const result = validateDecisionResponse(request, raw);

        for (const outcome of result.outcomes) {
          if (outcome.status !== "accepted") continue;
          const question = questions.find((q) => q.id === outcome.questionId)!;
          const answer = outcome.accepted!.answer;

          if (question.kind === "choice" && answer.kind === "choice") {
            expect(question.options).toContain(answer.selected);
            expect(answer.selected).not.toBe("none"); // "none" is abstained, never accepted
            if (answer.distribution) {
              for (const key of Object.keys(answer.distribution)) {
                expect(question.options).toContain(key);
              }
            }
          }
          if (question.kind === "score" && answer.kind === "score") {
            expect(answer.value).toBeGreaterThanOrEqual(question.min);
            expect(answer.value).toBeLessThanOrEqual(question.max);
            expect(Number.isFinite(answer.value)).toBe(true);
          }
          if (question.kind === "probability" && answer.kind === "probability") {
            expect(answer.value).toBeGreaterThanOrEqual(0);
            expect(answer.value).toBeLessThanOrEqual(1);
            expect(Number.isFinite(answer.value)).toBe(true);
          }
          // The validator never lets a mismatched answer kind through as accepted.
          expect(answer.kind).toBe(question.kind);
        }

        // No outcome exists for a question that was never requested.
        const requestedIds = new Set(questions.map((q) => q.id));
        for (const outcome of result.outcomes) {
          expect(requestedIds.has(outcome.questionId)).toBe(true);
        }
      }
    });
  }
});
