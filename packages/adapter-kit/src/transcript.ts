export type TranscriptSink = (kind: string, payload: unknown) => void;

export const noopTranscript: TranscriptSink = () => {};
