/// <reference lib="webworker" />
import { createSimulation, type RunningSimulation, type SimGraph } from './simulation';

/** main → worker. */
export type LayoutInbound =
  | { type: 'init'; graph: SimGraph; seed?: number }
  | { type: 'tick' }
  | { type: 'pin'; id: string; x: number; y: number }
  | { type: 'unpin'; id: string }
  | { type: 'stop' };

/** worker → main. */
export type LayoutOutbound = { type: 'positions'; positions: [string, { x: number; y: number }][] };

let sim: RunningSimulation | null = null;

addEventListener('message', (ev: MessageEvent<LayoutInbound>) => {
  const msg = ev.data;
  switch (msg.type) {
    case 'init':
      sim?.stop();
      sim = createSimulation(msg.graph, { seed: msg.seed ?? 1 });
      break;
    case 'tick': {
      if (!sim) return;
      const positions = [...sim.tick().entries()];
      const out: LayoutOutbound = { type: 'positions', positions };
      postMessage(out);
      break;
    }
    case 'pin':
      sim?.setPin(msg.id, msg.x, msg.y);
      break;
    case 'unpin':
      sim?.setPin(msg.id, null, null);
      break;
    case 'stop':
      sim?.stop();
      sim = null;
      break;
  }
});
