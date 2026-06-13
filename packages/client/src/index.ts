import type { ProblemDetails, QueryResponse, SubscribeFilter, WsFrame } from '@atlas/protocol';

export class AtlasClientError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly problem?: ProblemDetails,
  ) {
    super(message);
    this.name = 'AtlasClientError';
  }
}

export interface ConnectOptions {
  token?: string;
}

export interface Subscription {
  close(): void;
}

export class Database {
  constructor(
    private readonly baseUrl: string,
    private readonly name: string,
    private readonly opts: ConnectOptions,
  ) {}

  async query(aql: string, params: Record<string, unknown> = {}): Promise<QueryResponse> {
    const res = await fetch(`${this.baseUrl}/api/db/${this.name}/query`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
      },
      body: JSON.stringify({ query: aql, params }),
    });
    if (!res.ok) {
      const problem = (await res.json().catch(() => undefined)) as ProblemDetails | undefined;
      throw new AtlasClientError(
        problem?.code ?? 'ERROR',
        res.status,
        problem?.detail ?? res.statusText,
        problem,
      );
    }
    return (await res.json()) as QueryResponse;
  }

  /** Live change-feed subscription. Resolves once the socket is open. */
  subscribe(filter: SubscribeFilter, onFrame: (frame: WsFrame) => void): Promise<Subscription> {
    const wsBase = this.baseUrl.replace(/^http/, 'ws');
    const qs = new URLSearchParams();
    if (this.opts.token) qs.set('token', this.opts.token);
    if (filter.labels?.length) qs.set('labels', filter.labels.join(','));
    if (filter.types?.length) qs.set('types', filter.types.join(','));
    const ws = new WebSocket(`${wsBase}/ws/db/${this.name}?${qs.toString()}`);
    return new Promise((resolve, reject) => {
      ws.onmessage = (e) => onFrame(JSON.parse(String(e.data)) as WsFrame);
      ws.onopen = () => resolve({ close: () => ws.close() });
      ws.onerror = () => reject(new AtlasClientError('WS_ERROR', 0, 'websocket connection failed'));
    });
  }
}

export class AtlasClient {
  constructor(
    private readonly baseUrl: string,
    private readonly opts: ConnectOptions,
  ) {}

  database(name: string): Database {
    return new Database(this.baseUrl, name, this.opts);
  }
}

export function connect(url: string, opts: ConnectOptions = {}): AtlasClient {
  return new AtlasClient(url.replace(/\/$/, ''), opts);
}
