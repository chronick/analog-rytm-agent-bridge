import type {
  RytmChangePatternInput,
  RytmLiveParameterInput,
  RytmSetTransportInput,
  RytmTriggerTrackInput,
} from "../domain/types.ts";

export type MockRytmTransportMessage =
  | { type: "live_parameter"; input: RytmLiveParameterInput }
  | { type: "trigger_track"; input: RytmTriggerTrackInput }
  | { type: "transport"; input: RytmSetTransportInput }
  | { type: "change_pattern"; input: RytmChangePatternInput };

export class MockRytmTransport {
  readonly messages: MockRytmTransportMessage[] = [];
  connected = true;

  async sendLiveParameter(input: RytmLiveParameterInput): Promise<void> {
    this.requireConnected();
    this.messages.push({ type: "live_parameter", input: structuredClone(input) });
  }

  async triggerTrack(input: RytmTriggerTrackInput): Promise<void> {
    this.requireConnected();
    this.messages.push({ type: "trigger_track", input: structuredClone(input) });
  }

  async setTransport(input: RytmSetTransportInput): Promise<void> {
    this.requireConnected();
    this.messages.push({ type: "transport", input: structuredClone(input) });
  }

  async changePattern(input: RytmChangePatternInput): Promise<void> {
    this.requireConnected();
    this.messages.push({ type: "change_pattern", input: structuredClone(input) });
  }

  private requireConnected(): void {
    if (!this.connected) throw new Error("mock Rytm transport is disconnected");
  }
}

