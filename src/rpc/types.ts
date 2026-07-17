export const RYTM_RPC_SCHEMA = "analog-rytm-rpc.v1" as const;

export interface RytmRpcRequest {
  schema: typeof RYTM_RPC_SCHEMA;
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface RytmRpcErrorBody {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export interface RytmRpcSuccess<T = unknown> {
  schema: typeof RYTM_RPC_SCHEMA;
  id: string;
  ok: true;
  result: T;
}

export interface RytmRpcFailure {
  schema: typeof RYTM_RPC_SCHEMA;
  id: string | null;
  ok: false;
  error: RytmRpcErrorBody;
}

export type RytmRpcResponse<T = unknown> = RytmRpcSuccess<T> | RytmRpcFailure;

export interface RytmRpcEvent<T = unknown> {
  schema: typeof RYTM_RPC_SCHEMA;
  eventId: string;
  type: string;
  payload: T;
}

export interface RytmDaemonHealth {
  status: "ready";
  connected: boolean;
  adapter: "mock" | "hardware";
  protocolSchema: typeof RYTM_RPC_SCHEMA;
  daemonSchema: "analog-rytm-daemon.v1";
  processId: number;
  methods: {
    declared: string[];
    implemented: string[];
  };
}

export interface RytmDaemonApi {
  health(): Promise<RytmDaemonHealth>;
  inspectDeviceState(): Promise<unknown>;
  inspectPattern(pattern?: string): Promise<unknown>;
}
