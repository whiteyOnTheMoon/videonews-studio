/**
 * Monotone 24 fps scene/audio plan. The audio media duration is measured first.
 * Sections and visual beats never overlap. No TTS, media decoding or approval.
 */
export interface NarrationTimingInput {
  sectionId: string;
  audioSeconds: number;
  beatCount: number;
}
export interface VisualBeatTiming {
  sectionId: string;
  beat: number;
  startFrame: number;
  frames: number;
}
export interface NarrationSectionTiming {
  sectionId: string;
  startFrame: number;
  frames: number;
  measuredAudioSeconds: number;
  visualBeats: readonly VisualBeatTiming[];
}
export interface NarrationTimeline {
  fps: 24;
  totalFrames: number;
  totalSeconds: number;
  sections: readonly NarrationSectionTiming[];
}

export function buildNarrationTimeline(
  inputs: readonly NarrationTimingInput[],
  pauseSeconds = 0.7,
): NarrationTimeline {
  const fps = 24 as const;
  if (
    !Array.isArray(inputs) ||
    inputs.length !== 7 ||
    !Number.isFinite(pauseSeconds) ||
    pauseSeconds < 0.4 ||
    pauseSeconds > 2
  ) {
    throw new Error("Narration timeline configuration invalid");
  }
  const ids = new Set<string>();
  let cursor = 0;
  const sections: NarrationSectionTiming[] = inputs.map((input) => {
    if (
      !input ||
      typeof input.sectionId !== "string" ||
      !/^[a-z-]{3,40}$/.test(input.sectionId) ||
      ids.has(input.sectionId) ||
      !Number.isFinite(input.audioSeconds) ||
      input.audioSeconds <= 1 ||
      input.audioSeconds > 240 ||
      !Number.isSafeInteger(input.beatCount) ||
      input.beatCount < 1 ||
      input.beatCount > 5
    ) {
      throw new Error("Narration section timing invalid");
    }
    ids.add(input.sectionId);
    const frames = Math.ceil((input.audioSeconds + pauseSeconds) * fps);
    if (frames < input.beatCount) throw new Error("Narration beat too short");
    const base = Math.floor(frames / input.beatCount);
    const visualBeats = Array.from({ length: input.beatCount }, (_, beat) => ({
      sectionId: input.sectionId,
      beat,
      startFrame: cursor + base * beat,
      frames: beat === input.beatCount - 1 ? frames - base * beat : base,
    }));
    const section = {
      sectionId: input.sectionId,
      startFrame: cursor,
      frames,
      measuredAudioSeconds: input.audioSeconds,
      visualBeats,
    };
    cursor += frames;
    return section;
  });
  return { fps, totalFrames: cursor, totalSeconds: cursor / fps, sections };
}
