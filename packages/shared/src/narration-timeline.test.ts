import assert from "node:assert/strict";
import test from "node:test";
import { buildNarrationTimeline } from "./narration-timeline.js";

const inputs = [
  { sectionId: "hook", audioSeconds: 19.14, beatCount: 2 },
  { sectionId: "basics", audioSeconds: 45.1, beatCount: 3 },
  { sectionId: "what-happened", audioSeconds: 146.31, beatCount: 3 },
  { sectionId: "why-is-it-happening", audioSeconds: 124.22, beatCount: 3 },
  { sectionId: "why-it-matters", audioSeconds: 112.5, beatCount: 3 },
  { sectionId: "whats-next", audioSeconds: 76.0, beatCount: 3 },
  { sectionId: "takeaway", audioSeconds: 20.6, beatCount: 2 },
];

test("builds a continuous 24 fps plan with zero visual overlap or gaps", () => {
  const plan = buildNarrationTimeline(inputs);
  const beats = plan.sections.flatMap((section) => section.visualBeats);
  assert.equal(plan.sections.length, 7);
  assert.equal(beats.length, 19);
  let cursor = 0;
  for (const section of plan.sections) {
    assert.equal(section.startFrame, cursor);
    const end = section.startFrame + section.frames;
    assert.ok(section.frames / 24 >= section.measuredAudioSeconds + 0.4);
    const localBeats = section.visualBeats;
    assert.equal(localBeats[0]?.startFrame, section.startFrame);
    assert.equal(
      localBeats.at(-1)!.startFrame + localBeats.at(-1)!.frames,
      end,
    );
    for (const beat of localBeats) {
      assert.ok(beat.frames > 0);
      assert.ok(beat.startFrame >= section.startFrame);
    }
    cursor = end;
  }
  for (let i = 1; i < beats.length; i++) {
    assert.equal(beats[i]!.startFrame, beats[i - 1]!.startFrame + beats[i - 1]!.frames);
  }
  assert.equal(plan.totalFrames, cursor);
  assert.equal(plan.totalSeconds, cursor / 24);
});

test("allows varying speech duration without any per-section second quota", () => {
  const custom = inputs.map((input) => ({ ...input, audioSeconds: input.audioSeconds + 5 }));
  const plan = buildNarrationTimeline(custom);
  assert.ok(plan.totalSeconds > buildNarrationTimeline(inputs).totalSeconds);
});

test("rejects non-finite durations, duplicate ids and unbounded beats", () => {
  assert.throws(() =>
    buildNarrationTimeline([{ ...inputs[0]!, audioSeconds: Number.NaN }, ...inputs.slice(1)]),
  );
  assert.throws(() =>
    buildNarrationTimeline([inputs[0]!, inputs[0]!, ...inputs.slice(2)]),
  );
  assert.throws(() =>
    buildNarrationTimeline([{ ...inputs[0]!, beatCount: 0 }, ...inputs.slice(1)]),
  );
  assert.throws(() => buildNarrationTimeline(inputs, 0));
});
